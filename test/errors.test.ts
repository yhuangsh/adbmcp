import { describe, expect, it } from 'vitest';

import {
  AdbError,
  commandFailedError,
  isAdbError,
  mapAdbFailure,
  multipleDevicesError,
  noDeviceError,
  offlineError,
  serverConflictError,
  timeoutError,
  unauthorizedError,
  type AdbErrorCause,
} from '../src/adb/errors.js';

const ALL_CAUSES: AdbErrorCause[] = [
  'DEVICE_UNAUTHORIZED',
  'DEVICE_OFFLINE',
  'NO_DEVICE',
  'MULTIPLE_DEVICES',
  'ADB_SERVER_CONFLICT',
  'TIMEOUT',
  'COMMAND_FAILED',
];

describe('mapAdbFailure', () => {
  it('maps "no devices/emulators found" to NO_DEVICE', () => {
    const error = mapAdbFailure({ stderr: 'error: no devices/emulators found', exitCode: 1 });
    expect(error.cause).toBe('NO_DEVICE');
    expect(error.message).toContain('No Android device');
    expect(error.hint).toMatch(/emulator|connect/i);
  });

  it('maps a missing explicit serial to NO_DEVICE naming it', () => {
    const error = mapAdbFailure(
      { stderr: 'adb: device \'R58M12345AB\' not found', exitCode: 1 },
      { serial: 'R58M12345AB' },
    );
    expect(error.cause).toBe('NO_DEVICE');
    expect(error.message).toContain('R58M12345AB');
  });

  it('maps "more than one device/emulator" to MULTIPLE_DEVICES', () => {
    const error = mapAdbFailure({
      stderr: 'adb: more than one device/emulator',
      exitCode: 1,
    });
    expect(error.cause).toBe('MULTIPLE_DEVICES');
    expect(error.hint).toContain('device');
  });

  it('maps device unauthorized output to DEVICE_UNAUTHORIZED with a screen-prompt hint', () => {
    const error = mapAdbFailure(
      { stderr: 'error: device unauthorized.\nThis adb server\'s $ADB_VENDOR_KEYS is not set', exitCode: 1 },
      { serial: 'emulator-5554' },
    );
    expect(error.cause).toBe('DEVICE_UNAUTHORIZED');
    expect(error.message).toContain('emulator-5554');
    expect(error.hint).toContain('Allow USB debugging');
  });

  it('maps device offline output to DEVICE_OFFLINE', () => {
    const error = mapAdbFailure({ stderr: 'error: device offline', exitCode: 1 });
    expect(error.cause).toBe('DEVICE_OFFLINE');
    expect(error.hint).toMatch(/reconnect|adb_server_restart/);
  });

  it('maps adb server version mismatches to ADB_SERVER_CONFLICT', () => {
    const error = mapAdbFailure({
      stderr: "adb server version (36) doesn't match this client (41); killing...\n* daemon started successfully",
      exitCode: 1,
    });
    expect(error.cause).toBe('ADB_SERVER_CONFLICT');
    expect(error.hint).toContain('adb_server_restart');
  });

  it('maps a timeout to TIMEOUT with the configured budget', () => {
    const error = mapAdbFailure(
      { stderr: '', exitCode: 0, timedOut: true, timeoutMs: 1234 },
      { operation: 'shell "sleep 60"' },
    );
    expect(error.cause).toBe('TIMEOUT');
    expect(error.message).toContain('1234');
    expect(error.message).toContain('shell "sleep 60"');
    expect(error.hint).toContain('timeout_ms');
  });

  it('falls back to COMMAND_FAILED with the stderr excerpt and exit code', () => {
    const error = mapAdbFailure({
      stderr: 'adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
      exitCode: 1,
    });
    expect(error.cause).toBe('COMMAND_FAILED');
    expect(error.message).toContain('exit 1');
    expect(error.message).toContain('INSTALL_FAILED_INSUFFICIENT_STORAGE');
    expect(error.exitCode).toBe(1);
  });

  it('truncates very long stderr excerpts', () => {
    const error = mapAdbFailure({ stderr: 'x'.repeat(5000), exitCode: 1 });
    expect(error.toToolText().length).toBeLessThan(1500);
  });
});

describe('AdbError', () => {
  it('formats cause, hint, candidates and stderr for the model', () => {
    const error = new AdbError({
      cause: 'MULTIPLE_DEVICES',
      message: 'More than one device is connected.',
      hint: 'Pass device: "<serial>".',
      candidates: ['emulator-5554', 'R58M12345AB'],
      stderr: 'adb: more than one device/emulator',
    });
    const text = error.toToolText();
    expect(text).toContain('[MULTIPLE_DEVICES]');
    expect(text).toContain('Hint: Pass device');
    expect(text).toContain('emulator-5554, R58M12345AB');
    expect(text).toContain('stderr:');
  });

  it('uses one of the documented causes for every factory', () => {
    const errors = [
      unauthorizedError('s'),
      offlineError('s'),
      noDeviceError(undefined),
      multipleDevicesError(['a', 'b']),
      serverConflictError('mismatch'),
      timeoutError({ timeoutMs: 10 }),
      commandFailedError({ stderr: 'boom', exitCode: 2 }),
    ];
    for (const error of errors) {
      expect(ALL_CAUSES).toContain(error.cause);
      expect(error.message.length).toBeGreaterThan(10);
      expect(isAdbError(error)).toBe(true);
      // Every failure must tell the model (or user) what to do next.
      expect(error.hint ?? '').not.toBe('');
    }
  });

  it('is not confused with plain errors', () => {
    expect(isAdbError(new Error('boom'))).toBe(false);
  });
});
