import { describe, expect, it } from 'vitest';

import { isAdbError } from '../src/adb/errors.js';
import { GuardrailError } from '../src/config.js';
import { formatDeviceList, parseDevicesOutput, type DeviceEntry } from '../src/devices.js';
import { createHarness, devicesHandler, ONE_DEVICE_LONG, TWO_DEVICES_LONG } from './helpers/fakes.js';

describe('parseDevicesOutput', () => {
  it('parses serial, state and -l details, skipping adb chatter', () => {
    const stdout = [
      '* daemon not running; starting now at tcp:5037',
      '* daemon started successfully',
      'List of devices attached',
      'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:1',
      'R58M12345AB            unauthorized',
      'R58M99999XY            offline',
      '',
    ].join('\n');
    const entries = parseDevicesOutput(stdout);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      serial: 'emulator-5554',
      state: 'device',
      model: 'sdk_gphone64_x86_64',
      product: 'sdk_gphone64_x86_64',
      device: 'emu64xa',
      transportId: '1',
    });
    expect(entries[1]).toMatchObject({ serial: 'R58M12345AB', state: 'unauthorized' });
    expect(entries[2]).toMatchObject({ serial: 'R58M99999XY', state: 'offline' });
  });

  it('flags the "no permissions" placeholder and unknown states', () => {
    const entries = parseDevicesOutput('????????????\tno permissions (user in plugdev group)\n');
    expect(entries[0]?.state).toBe('no_permissions');
  });

  it('returns nothing for an empty listing', () => {
    expect(parseDevicesOutput('List of devices attached\n\n')).toEqual([]);
  });
});

describe('DeviceManager.resolve', () => {
  it('uses the only connected device when no serial is given', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    await expect(harness.ctx.devices.resolve()).resolves.toBe('emulator-5554');
  });

  it('accepts an explicit serial', async () => {
    const harness = createHarness({ handler: devicesHandler(TWO_DEVICES_LONG) });
    await expect(harness.ctx.devices.resolve('R58M12345AB')).resolves.toBe('R58M12345AB');
  });

  it('fails with NO_DEVICE when nothing is connected', async () => {
    const harness = createHarness({ handler: devicesHandler('List of devices attached\n') });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('NO_DEVICE');
    expect(error.hint).toContain('list_devices');
  });

  it('fails with MULTIPLE_DEVICES and lists the candidates', async () => {
    const harness = createHarness({ handler: devicesHandler(TWO_DEVICES_LONG) });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('MULTIPLE_DEVICES');
    expect(error.candidates).toEqual(['emulator-5554', 'R58M12345AB']);
    expect(error.toToolText()).toContain('emulator-5554, R58M12345AB');
  });

  it('fails with DEVICE_UNAUTHORIZED when the only device needs authorization', async () => {
    const harness = createHarness({
      handler: devicesHandler('List of devices attached\nR58M12345AB            unauthorized\n'),
    });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('DEVICE_UNAUTHORIZED');
    expect(error.hint).toContain('Allow USB debugging');
  });

  it('fails with DEVICE_OFFLINE when the only device is offline', async () => {
    const harness = createHarness({
      handler: devicesHandler('List of devices attached\nR58M12345AB            offline\n'),
    });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('DEVICE_OFFLINE');
  });

  it('skips unusable devices and picks the single usable one', async () => {
    const harness = createHarness({
      handler: devicesHandler(
        ['List of devices attached', 'emulator-5554          unauthorized', 'R58M12345AB            device'].join('\n'),
      ),
    });
    await expect(harness.ctx.devices.resolve()).resolves.toBe('R58M12345AB');
  });

  it('fails with NO_DEVICE for an unknown explicit serial and echoes the candidates', async () => {
    const harness = createHarness({ handler: devicesHandler(TWO_DEVICES_LONG) });
    const error = await harness.ctx.devices.resolve('nope-1234').catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('NO_DEVICE');
    expect(error.message).toContain('nope-1234');
    expect(error.candidates).toEqual(['emulator-5554', 'R58M12345AB']);
  });

  it('refuses serials excluded by ADBMCP_ALLOWED_DEVICES', async () => {
    const harness = createHarness({
      handler: devicesHandler(TWO_DEVICES_LONG),
      env: { ADBMCP_ALLOWED_DEVICES: 'emulator-5554' },
    });
    const error = await harness.ctx.devices.resolve('R58M12345AB').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GuardrailError);
    expect((error as GuardrailError).rule).toBe('device.notAllowed');
  });

  it('resolves implicitly among allowed devices only', async () => {
    const harness = createHarness({
      handler: devicesHandler(TWO_DEVICES_LONG),
      env: { ADBMCP_ALLOWED_DEVICES: 'R58M12345AB' },
    });
    await expect(harness.ctx.devices.resolve()).resolves.toBe('R58M12345AB');
  });

  it('explains when every connected device is excluded by the allowlist', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG),
      env: { ADBMCP_ALLOWED_DEVICES: 'some-other-serial' },
    });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GuardrailError);
    expect((error as GuardrailError).message).toContain('ADBMCP_ALLOWED_DEVICES');
  });

  it('refuses devices stuck in bootloader state', async () => {
    const harness = createHarness({
      handler: devicesHandler('List of devices attached\nR58M12345AB            bootloader\n'),
    });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('DEVICE_OFFLINE');
    expect(error.message).toContain('bootloader');
  });

  it('surfaces adb server conflicts from the device listing itself', async () => {
    const harness = createHarness({
      handler: () => ({
        stdout: '',
        stderr: "adb server version (36) doesn't match this client (41); killing...",
        exitCode: 1,
      }),
    });
    const error = await harness.ctx.devices.resolve().catch((cause: unknown) => cause);
    expect(isAdbError(error)).toBe(true);
    if (!isAdbError(error)) return;
    expect(error.cause).toBe('ADB_SERVER_CONFLICT');
  });
});

describe('formatDeviceList', () => {
  it('renders a compact table with usability information', () => {
    const entries: DeviceEntry[] = [
      {
        serial: 'emulator-5554',
        state: 'device',
        model: 'sdk_gphone64',
        transportId: '1',
        allowed: true,
      },
      { serial: 'R58M12345AB', state: 'unauthorized', allowed: false },
    ];
    const text = formatDeviceList(entries, ['emulator-5554']);
    expect(text).toContain('| serial | state | model | transport_id | allowed |');
    expect(text).toContain('emulator-5554');
    expect(text).toContain('2 device(s) connected, 1 usable.');
    expect(text).toContain('ADBMCP_ALLOWED_DEVICES is set (emulator-5554)');
  });

  it('tells the model what to do when nothing is connected', () => {
    expect(formatDeviceList([], null)).toContain('No devices connected');
  });

  it('warns when several devices are usable', () => {
    const entries: DeviceEntry[] = [
      { serial: 'a', state: 'device', allowed: true },
      { serial: 'b', state: 'device', allowed: true },
    ];
    expect(formatDeviceList(entries, null)).toContain('pass "device": "<serial>"');
  });
});
