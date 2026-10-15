import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { isAdbError } from '../src/adb/errors.js';
import { AdbRunner } from '../src/adb/runner.js';

/**
 * `AdbRunner` is the only seam the rest of the suite fakes, so these tests spawn
 * real child processes (node, never a real adb or device) to pin spawn, argv and
 * timeout/kill behavior.
 */

const tempDirs: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'adbmcp-runner-'));
  tempDirs.push(directory);
  return directory;
}

/** Fake adb: writes its argv (minus the binary) to stdout as JSON. */
function createFakeAdb(): string {
  const script = join(tempDir(), 'fake-adb');
  writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(script, 0o755);
  return script;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('AdbRunner', () => {
  it('kills the child and rejects with TIMEOUT when the timeout elapses', async () => {
    const marker = join(tempDir(), 'child-still-alive');
    // Records a marker if it survives past the timeout, then keeps the event loop alive.
    const script = [
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 400);`,
      'setTimeout(() => {}, 1e6);',
    ].join('\n');
    const runner = new AdbRunner({ adbPath: process.execPath });

    const startedAt = Date.now();
    const error = await runner
      .run(['-e', script], { timeoutMs: 100, operation: 'runner test' })
      .catch((cause: unknown) => cause);
    const elapsed = Date.now() - startedAt;

    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    // TIMEOUT is only produced on the child's 'close' event, i.e. after it died.
    expect(error.cause).toBe('TIMEOUT');
    expect(error.message).toContain('runner test');
    expect(elapsed).toBeLessThan(2_000);

    await sleep(600);
    expect(existsSync(marker)).toBe(false);
  });

  it('prepends -s <serial> for scoped calls and leaves devices -l unscoped', async () => {
    const runner = new AdbRunner({ adbPath: createFakeAdb() });

    const unscoped = await runner.run(['devices', '-l']);
    expect(JSON.parse(unscoped.stdout)).toEqual(['devices', '-l']);

    const scoped = await runner.run(['shell', 'id'], { serial: 'emulator-5554' });
    expect(JSON.parse(scoped.stdout)).toEqual(['-s', 'emulator-5554', 'shell', 'id']);
  });

  it('maps a missing adb binary to COMMAND_FAILED with the ADB_PATH hint', async () => {
    const missing = join(tempDir(), 'missing-adb');
    const runner = new AdbRunner({ adbPath: missing });

    const error = await runner.run(['devices']).catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('COMMAND_FAILED');
    expect(error.message).toContain(missing);
    expect(error.message).toContain('file not found');
    expect(error.hint).toContain('ADB_PATH');
  });
});
