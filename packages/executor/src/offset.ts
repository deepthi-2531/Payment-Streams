/**
 * Simple offset store for the executor service.
 *
 * Persists the last processed timestamp to a local file so the executor
 * can resume from where it left off after a restart. This is a basic
 * implementation — production deployments should use a database.
 *
 * @module offset
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export class OffsetStore {
  constructor(private readonly filePath: string) {}

  /**
   * Load the last saved offset.
   * Returns null if no offset has been saved yet.
   */
  async load(): Promise<string | null> {
    try {
      const data = await readFile(this.filePath, 'utf-8');
      return data.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Save the current offset.
   */
  async save(offset: string): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, offset, 'utf-8');
    } catch (err) {
      // Non-fatal — the executor can still function without persistence
      console.warn('Failed to save offset:', err);
    }
  }
}
