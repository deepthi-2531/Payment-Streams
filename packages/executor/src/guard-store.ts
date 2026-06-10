/**
 * Idempotency guard store for the executor service.
 *
 * Persists the set of in-flight / recently-completed execution ids so a
 * restart does not replay a payout. Writes go through a tmp file + rename so
 * a crash mid-write cannot leave a torn file. This is a local guard only —
 * cross-instance safety relies on the on-ledger DelegatedPolicy rate limit.
 *
 * @module guard-store
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Upper bound on retained ids; oldest are dropped first. */
const MAX_IDS = 1024;

export class ExecutionGuardStore {
  constructor(private readonly filePath: string) {}

  /**
   * Load persisted execution ids. Returns an empty array if none / unreadable.
   */
  async load(): Promise<string[]> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /**
   * Atomically persist the current guard set (tmp file + rename).
   * Insertion order is preserved; only the most recent MAX_IDS are kept.
   */
  async persist(ids: Set<string>): Promise<void> {
    const retained = [...ids].slice(-MAX_IDS);
    const tmp = `${this.filePath}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, JSON.stringify(retained), 'utf-8');
      await rename(tmp, this.filePath);
    } catch (err) {
      // Non-fatal — the in-memory guard still protects this instance.
      console.warn('Failed to persist execution guard:', err);
    }
  }
}
