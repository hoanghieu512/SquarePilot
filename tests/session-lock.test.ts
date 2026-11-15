import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSessionLock } from '../src/utils/session-lock.js';

function lockFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'sp-lock-')), 'nested', 'session.lock');
}

/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}

describe('acquireSessionLock', () => {
  it('takes a free lock, writes its pid, and releases it', () => {
    const file = lockFile();
    const lock = acquireSessionLock(file);
    expect(lock.acquired).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
    if (lock.acquired) lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('steps aside while another live process holds it', () => {
    const file = lockFile();
    const parent = process.ppid; // alive for as long as this test runs
    const first = acquireSessionLock(file, parent);
    expect(first.acquired).toBe(true);

    expect(acquireSessionLock(file)).toEqual({ acquired: false, heldBy: parent });
  });

  it('takes over a lock left by a process that died', () => {
    const file = lockFile();
    acquireSessionLock(file, deadPid());

    const lock = acquireSessionLock(file);
    expect(lock.acquired).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(String(process.pid));
  });

  it('takes over a lock with garbage in it', () => {
    const file = lockFile();
    expect(acquireSessionLock(file).acquired).toBe(true);
    writeFileSync(file, 'not a pid');
    expect(acquireSessionLock(file).acquired).toBe(true);
  });

  it('release leaves a lock that someone else has taken since', () => {
    const file = lockFile();
    const lock = acquireSessionLock(file);
    writeFileSync(file, '424242');
    if (lock.acquired) lock.release();
    expect(readFileSync(file, 'utf8')).toBe('424242');
  });
});
