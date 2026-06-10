/**
 * Durable journal for in-flight auto-withdraw settlements.
 *
 * The interactive withdraw path moves funds off-chain first and records the
 * withdrawal on-ledger second. This journal persists each settlement across
 * that window so a crash or a permanent submission failure leaves a durable,
 * machine-readable record that the next cycle recovers automatically,
 * instead of relying on log scraping.
 *
 * Writes are atomic (tmp file + rename), matching the offset-store pattern.
 *
 * @module settlement-journal
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Lifecycle of an entry:
 *  - `transfer`: the off-chain transfer has been initiated; its outcome is
 *    unknown. Recovery cannot safely retry this phase — it is surfaced for
 *    manual reconciliation.
 *  - `record`: funds have moved off-chain; the on-ledger record is pending.
 *    Recovery re-submits the ledger exercise with the original command id
 *    and contract id, so a record that actually landed is detected (archived
 *    contract / duplicate command) rather than double-applied.
 */
export interface PendingSettlementEntry {
  readonly settlementReference: string;
  readonly streamId: string;
  readonly contractId: string;
  readonly templateId: string;
  readonly escrowOperator: string;
  readonly commandId: string;
  readonly settledAmount: string;
  readonly withdrawTime: string;
  readonly phase: 'transfer' | 'record';
  readonly attempts: number;
  readonly updatedAt: string;
}

export class SettlementJournal {
  private entries: Map<string, PendingSettlementEntry> | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<Map<string, PendingSettlementEntry>> {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry && typeof entry.settlementReference === 'string') {
            this.entries.set(entry.settlementReference, entry as PendingSettlementEntry);
          }
        }
      }
    } catch {
      // Missing or unreadable file — start empty.
    }
    return this.entries;
  }

  private async flush(): Promise<void> {
    if (!this.entries) return;
    const tmp = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify([...this.entries.values()]), 'utf-8');
    await rename(tmp, this.filePath);
  }

  async put(entry: Omit<PendingSettlementEntry, 'updatedAt'>): Promise<void> {
    const entries = await this.ensureLoaded();
    entries.set(entry.settlementReference, {
      ...entry,
      updatedAt: new Date().toISOString(),
    });
    await this.flush();
  }

  async bumpAttempts(settlementReference: string): Promise<void> {
    const entries = await this.ensureLoaded();
    const existing = entries.get(settlementReference);
    if (!existing) return;
    entries.set(settlementReference, {
      ...existing,
      attempts: existing.attempts + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.flush();
  }

  async remove(settlementReference: string): Promise<void> {
    const entries = await this.ensureLoaded();
    if (entries.delete(settlementReference)) {
      await this.flush();
    }
  }

  async list(): Promise<PendingSettlementEntry[]> {
    return [...(await this.ensureLoaded()).values()];
  }
}
