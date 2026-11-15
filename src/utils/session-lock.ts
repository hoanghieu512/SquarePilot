import fs from 'node:fs';
import path from 'node:path';

/**
 * One approval session at a time.
 *
 * A run stays alive for up to six hours waiting for the owner. Two runs
 * polling the same Zalo bot would each receive some of the owner's messages
 * and miss the rest, so a second run steps aside while the first is alive.
 * The lock holds the owner's pid; a lock left by a dead process is taken over.
 */

export type LockResult = { acquired: true; release(): void } | { acquired: false; heldBy: number };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireSessionLock(file: string, pid: number = process.pid): LockResult {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, String(pid), { flag: 'wx' });
      return {
        acquired: true,
        release: () => {
          try {
            if (fs.readFileSync(file, 'utf8').trim() === String(pid)) fs.unlinkSync(file);
          } catch {
            // Already gone.
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // The holder can release the lock between the failed create and these
      // reads; a missing file just means the next attempt can take it.
      let holder = Number.NaN;
      try {
        holder = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') throw readErr;
        continue;
      }
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        return { acquired: false, heldBy: holder };
      }
      // Stale: the holder died without releasing it, or it is our own pid.
      try {
        fs.unlinkSync(file);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr;
      }
    }
  }
  throw new Error(`Could not take the session lock at ${file}`);
}
