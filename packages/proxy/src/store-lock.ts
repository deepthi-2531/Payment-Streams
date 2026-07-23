// Cross-process advisory lock for the proxy's JSON stores. Each store is a whole
// file loaded, mutated, and written back with awaits (chain reads, transfers) in
// between; an in-process mutex only serializes one Node process. Two processes
// sharing a store — a second replica, or the old instance during the slow
// SIGTERM->SIGKILL window on redeploy — would each read a stale snapshot and
// last-writer-wins would clobber the other's changes. This makes the whole
// read-modify-write single-writer across processes on one host.

import { readFileSync, writeFileSync, unlinkSync, linkSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export class StoreLockError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  constructor(statusCode: number, reason: string, message: string) {
    super(message);
    this.name = 'StoreLockError';
    this.statusCode = statusCode;
    this.reason = reason;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the pid exists but we may not signal it — still alive.
    return err?.code === 'EPERM';
  }
}

/** Age of the current holder, from its recorded timestamp or, if that is
 * unreadable, the lock file's mtime — never Infinity, so an unparseable lock is
 * waited on and only reclaimed once it truly ages out. */
function lockAgeMs(lockPath: string, holderAt: unknown): number {
  const at = Number(holderAt);
  if (Number.isFinite(at) && at > 0) return Date.now() - at;
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** Acquire an exclusive on-disk lock, returning a token the holder must present
 * to release it. The lock is created by writing a fully-formed record to a
 * private temp file and hard-linking it into place: link is atomic and fails if
 * the target exists, so the lock is never observed empty (no steal-mid-write
 * race). A held lock is reclaimed only when its holder pid is dead, or it has
 * aged past staleMs (which a genuine critical section never reaches) — a live,
 * in-progress holder is waited on, never overtaken. */
export async function acquireStoreLock(lockPath: string, staleMs: number): Promise<string> {
  const token = `${process.pid}:${randomUUID()}`;
  const tmp = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
  const start = Date.now();
  try {
    for (;;) {
      try {
        linkSync(tmp, lockPath);
        return token;
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err;
        let holder: { pid?: number; at?: number } = {};
        try {
          holder = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          /* unreadable — fall through to the mtime-based age check */
        }
        const aged = lockAgeMs(lockPath, holder.at) > staleMs;
        const dead = typeof holder.pid === 'number' ? !pidAlive(holder.pid) || aged : aged;
        if (dead) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* another waiter cleared it first */
          }
          continue;
        }
        if (Date.now() - start > staleMs) {
          throw new StoreLockError(
            503,
            'store_lock_timeout',
            `could not acquire the store lock within ${staleMs}ms; another instance is holding it`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp already gone */
    }
  }
}

/** Release a lock only if we still hold it: if it was reclaimed as stale and now
 * belongs to another process, leave that process's lock in place. */
export function releaseStoreLock(lockPath: string, token: string): void {
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (holder.token === token) unlinkSync(lockPath);
  } catch {
    /* missing or unreadable — nothing of ours to release */
  }
}
