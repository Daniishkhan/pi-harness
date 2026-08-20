/**
 * Minimal cross-process file lock (no npm deps).
 * Lock = exclusively-created file (`wx`). Stale locks (older than
 * STALE_MS) are reclaimed. Used for inbox appends, config writes,
 * task claims, and cursors.
 */

import { open, stat, unlink } from "node:fs/promises";

const DEFAULT_TIMEOUT_MS = 5000;
const STALE_MS = 30_000;
const RETRY_MS = 20;

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock exists — check for staleness, then retry.
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat; retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`Lock timeout after ${timeoutMs}ms: ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}
