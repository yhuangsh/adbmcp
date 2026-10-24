import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import {
  createHarness,
  devicesHandler,
  ONE_DEVICE_LONG,
  TWO_DEVICES_LONG,
  type TestHarness,
} from './helpers/fakes.js';

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

const EXPECTED_TOOLS = [
  'list_devices',
  'get_device_info',
  'shell',
  'list_packages',
  'install_apk',
  'uninstall_package',
  'logcat_snapshot',
  'start_logcat_stream',
  'read_logcat_stream',
  'stop_logcat_stream',
  'screenshot',
  'pull_file',
  'push_file',
  'forward_port',
  'remove_forward',
  'reverse_port',
  'remove_reverse',
  'list_forwards',
  'list_reverses',
  'grant_permission',
  'revoke_permission',
  'clear_app_data',
  'connect',
  'disconnect',
  'wireless_pair',
  'start_activity',
  'launch_package',
  'force_stop_app',
  'tap',
  'swipe',
  'type_text',
  'key_event',
  'get_ui_hierarchy',
  'dumpsys_query',
  'adb_server_restart',
];

function textOf(result: ToolResult): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

const openClients: Array<{ client: Client; close: () => Promise<void> }> = [];

async function connect(harness: TestHarness): Promise<Client> {
  const server = createServer(harness.ctx);
  const client = new Client({ name: 'adbmcp-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openClients.push({ client, close: () => server.close() });
  return client;
}

afterEach(async () => {
  for (const entry of openClients.splice(0)) {
    await entry.close();
  }
});

describe('tool surface', () => {
  it('registers the full MVP surface from design §4.1', async () => {
    const client = await connect(createHarness());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('carries the full annotation vocabulary and a title on every tool', async () => {
    const client = await connect(createHarness());
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect(tool.description, `${tool.name} description`).toBeTruthy();
      const annotations = tool.annotations ?? {};
      expect(typeof annotations.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      expect(typeof annotations.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
      expect(typeof annotations.idempotentHint, `${tool.name} idempotentHint`).toBe('boolean');
      expect(typeof annotations.openWorldHint, `${tool.name} openWorldHint`).toBe('boolean');
    }
  });

  it('marks read-only tools read-only and destructive tools destructive', async () => {
    const client = await connect(createHarness());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of ['list_devices', 'get_device_info', 'list_packages', 'logcat_snapshot', 'get_ui_hierarchy']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
    expect(byName.get('uninstall_package')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('uninstall_package')?.annotations?.readOnlyHint).toBe(false);
    for (const name of ['grant_permission', 'revoke_permission', 'clear_app_data']) {
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
    }
    for (const name of ['list_forwards', 'list_reverses']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
    for (const name of ['reverse_port', 'remove_reverse', 'connect', 'disconnect']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
    }
    expect(byName.get('shell')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('shell')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('pull_file')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('install_apk')?.annotations?.destructiveHint).toBe(false);

    // v0.3.0 additions: dumpsys is a read; input injection and pairing are writes.
    expect(byName.get('dumpsys_query')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('dumpsys_query')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('dumpsys_query')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('dumpsys_query')?.annotations?.openWorldHint).toBe(false);
    for (const name of ['tap', 'swipe', 'type_text', 'key_event']) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(false);
      // Every call injects a fresh UI event; repeating it acts again (double-tap,
      // further scroll, another BACK), so none of these is idempotent.
      expect(byName.get(name)?.annotations?.idempotentHint, name).toBe(false);
      expect(byName.get(name)?.annotations?.openWorldHint, name).toBe(false);
    }
    expect(byName.get('wireless_pair')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('wireless_pair')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('wireless_pair')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('wireless_pair')?.annotations?.openWorldHint).toBe(true);

    // v0.6.0 addition: launch_package is a plain stateful action, never read-only
    // and never destructive; repeating it re-launches (or foregrounds the app).
    expect(byName.get('launch_package')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('launch_package')?.annotations?.destructiveHint).toBe(false);
    expect(byName.get('launch_package')?.annotations?.idempotentHint).toBe(false);
    expect(byName.get('launch_package')?.annotations?.openWorldHint).toBe(false);
  });
});

describe('device-scoped tools', () => {
  it('lists devices with a single connected device', async () => {
    const client = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('emulator-5554');
    expect(textOf(result)).toContain('1 device(s) connected, 1 usable.');
  });

  it('fails with MULTIPLE_DEVICES when several devices are connected and none is chosen', async () => {
    const harness = createHarness({
      handler: devicesHandler(
        ['List of devices attached', 'emulator-5554          device', 'R58M12345AB            device'].join('\n'),
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'list_packages', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[MULTIPLE_DEVICES]');
    expect(textOf(result)).toContain('R58M12345AB');
  });

  it('fails with NO_DEVICE when nothing is connected', async () => {
    const client = await connect(createHarness({ handler: devicesHandler('List of devices attached\n') }));
    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('No devices connected');

    const shell = await client.callTool({ name: 'shell', arguments: { command: 'getprop' } });
    expect(shell.isError).toBe(true);
    expect(textOf(shell)).toContain('[NO_DEVICE]');
  });

  it('reports an unauthorized device as an actionable error', async () => {
    const client = await connect(
      createHarness({ handler: devicesHandler('List of devices attached\nemulator-5554          unauthorized\n') }),
    );
    const result = await client.callTool({ name: 'get_device_info', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[DEVICE_UNAUTHORIZED]');
    expect(textOf(result)).toContain('Allow USB debugging');
  });

  it('scopes adb calls with -s and passes the resolve-through serial', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: 'package:com.example.app\n' })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'list_packages', arguments: { filter: 'example' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('com.example.app');
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'pm list packages example']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
  });
});

describe('shell guardrails', () => {
  it('refuses a blocked command without ever spawning adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'shell', arguments: { command: 'reboot' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[shell.blocked]');
    expect(harness.runner.calls).toEqual([]);
  });

  it('runs an allowed command and returns stdout', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: 'Current Battery Service state:\n  level: 87\n' })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'shell', arguments: { command: 'dumpsys battery' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('level: 87');
  });

  it('reports a device-side non-zero exit as output with an exit code', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: '', stderr: 'grep: no match', exitCode: 1 })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'shell', arguments: { command: 'grep nothing /sdcard' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('exit_code: 1');
    expect(textOf(result)).toContain('grep: no match');
  });

  it('maps an adb-side failure to a typed error', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell'
          ? { stdout: '', stderr: 'error: device offline', exitCode: 1 }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'shell', arguments: { command: 'getprop' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[DEVICE_OFFLINE]');
  });
});

describe('package tools', () => {
  function createApk(): string {
    const directory = mkdtempSync(join(tmpdir(), 'adbmcp-test-'));
    const apk = join(directory, 'app.apk');
    writeFileSync(apk, 'fake apk');
    return apk;
  }

  it('treats an INSTALL_FAILED_* line on stdout as a failure even when adb exits 0', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'install'
          ? { stdout: 'Performing Streamed Install\nFailure [INSTALL_FAILED_VERSION_DOWNGRADE]', exitCode: 0 }
          : undefined,
      ),
    });
    const client = await connect(harness);

    const result = await client.callTool({ name: 'install_apk', arguments: { apk_path: createApk() } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('INSTALL_FAILED_VERSION_DOWNGRADE');
  });

  it('reports a successful install from stdout', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'install' ? { stdout: 'Success', exitCode: 0 } : undefined,
      ),
    });
    const client = await connect(harness);

    const result = await client.callTool({ name: 'install_apk', arguments: { apk_path: createApk() } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Success');
  });

  it('passes -k for keep_data and scopes the uninstall to the device', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'uninstall' ? { stdout: 'Success', exitCode: 0 } : undefined,
      ),
    });
    const client = await connect(harness);

    const result = await client.callTool({
      name: 'uninstall_package',
      arguments: { package: 'com.example.app', keep_data: true },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.runner.calls[1]?.args).toEqual(['uninstall', '-k', 'com.example.app']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
  });

  it('maps a DELETE_FAILED_* line on stdout to an error', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'uninstall'
          ? { stdout: 'Failure [DELETE_FAILED_INTERNAL_ERROR]', exitCode: 1 }
          : undefined,
      ),
    });
    const client = await connect(harness);

    const result = await client.callTool({ name: 'uninstall_package', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('DELETE_FAILED_INTERNAL_ERROR');
    expect(harness.runner.calls[1]?.args).toEqual(['uninstall', 'com.example.app']);
  });

  it('grants and revokes a runtime permission through pm with device scoping', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    const granted = await client.callTool({
      name: 'grant_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.CAMERA' },
    });
    expect(granted.isError).toBeFalsy();
    expect(textOf(granted)).toContain('Granted android.permission.CAMERA to com.example.app');
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'pm grant com.example.app android.permission.CAMERA']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');

    const revoked = await client.callTool({
      name: 'revoke_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.CAMERA' },
    });
    expect(revoked.isError).toBeFalsy();
    expect(textOf(revoked)).toContain('Revoked android.permission.CAMERA from com.example.app');
    expect(harness.runner.commands()).toContain('shell pm revoke com.example.app android.permission.CAMERA');
  });

  it('explains an Unknown permission failure from pm', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell' ? { stdout: 'Unknown permission: android.permission.BOGUS', exitCode: 1 } : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'grant_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.BOGUS' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('Unknown permission');
    expect(textOf(result)).toContain('pm list permissions');
  });

  it('explains an Unknown permission failure from pm revoke too', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell' ? { stdout: 'Unknown permission: android.permission.BOGUS', exitCode: 1 } : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'revoke_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.BOGUS' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('Unknown permission');
    expect(textOf(result)).toContain('pm list permissions');
  });

  it('explains a not-a-debuggable-app failure from pm', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell'
          ? { stderr: 'java.lang.SecurityException: Not a debuggable app', exitCode: 1 }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'revoke_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.CAMERA' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('debuggable');
  });

  it('maps a pm SecurityException to COMMAND_FAILED with the stderr excerpt', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell'
          ? {
              stderr:
                "Exception occurred while executing 'grant':\njava.lang.SecurityException: grantRuntimePermission: Neither user 2000 nor current process has android.permission.GRANT_RUNTIME_PERMISSIONS.",
              exitCode: 255,
            }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'grant_permission',
      arguments: { package: 'com.example.app', permission: 'android.permission.CAMERA' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('GRANT_RUNTIME_PERMISSIONS');
  });

  it('refuses clear_app_data when the package is not allowlisted, before touching adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'clear_app_data', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[clear.notAllowed]');
    expect(textOf(result)).toContain('ADBMCP_CLEAR_ALLOWED_PACKAGES');
    expect(harness.runner.calls).toEqual([]);
  });

  it('clears data for a package listed in ADBMCP_CLEAR_ALLOWED_PACKAGES', async () => {
    const harness = createHarness({
      env: { ADBMCP_CLEAR_ALLOWED_PACKAGES: 'com.example.app, com.example.dev' },
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => (args[0] === 'shell' ? { stdout: 'Success' } : undefined)),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'clear_app_data', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Success');
    expect(harness.runner.commands()).toContain('shell pm clear com.example.app');
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
  });

  it('treats a pm clear "Failed" line on stdout as a failure even when adb exits 0', async () => {
    const harness = createHarness({
      env: { ADBMCP_CLEAR_ALLOWED_PACKAGES: 'com.example.app' },
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell' ? { stdout: 'Failed', exitCode: 0 } : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'clear_app_data', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Failed');
  });

  it('treats a pm clear SecurityException on stdout as a failure even when adb exits 0', async () => {
    const harness = createHarness({
      env: { ADBMCP_CLEAR_ALLOWED_PACKAGES: 'com.example.app' },
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell'
          ? { stdout: 'java.lang.SecurityException: Shell cannot clear other apps\' data', exitCode: 0 }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'clear_app_data', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('SecurityException');
  });
});

describe('file transfer guardrails', () => {
  it('refuses to overwrite an existing host file unless overwrite is true', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adbmcp-test-'));
    const target = join(directory, 'pulled.txt');
    writeFileSync(target, 'existing');

    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: '1 file pulled' })),
    });
    const client = await connect(harness);

    const refused = await client.callTool({
      name: 'pull_file',
      arguments: { remote_path: '/sdcard/pulled.txt', local_path: target },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('[pull.overwrite]');

    const allowed = await client.callTool({
      name: 'pull_file',
      arguments: { remote_path: '/sdcard/pulled.txt', local_path: target, overwrite: true },
    });
    expect(allowed.isError).toBeFalsy();
    expect(harness.runner.commands()).toContain(`pull /sdcard/pulled.txt ${target}`);
  });

  it('refuses to push outside the allowed remote roots', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'push_file',
      arguments: { local_path: '/etc/hosts', remote_path: '/system/etc/hosts' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[push.remoteRoot]');
    expect(harness.runner.commands().some((command) => command.startsWith('push '))).toBe(false);
  });

  it('pushes to an allowed root', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'adbmcp-test-'));
    const source = join(directory, 'payload.bin');
    writeFileSync(source, 'data');
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: '1 file pushed' })),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'push_file',
      arguments: { local_path: source, remote_path: '/data/local/tmp/payload.bin' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('1 file pushed');
  });
});

describe('binary and long-running tools', () => {
  it('returns a screenshot as image content', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG),
      binaryHandler: () => ({ stdout: png }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'screenshot', arguments: {} });
    expect(result.isError).toBeFalsy();
    const image = result.content.find((block) => block.type === 'image');
    expect(image?.type).toBe('image');
    if (image?.type !== 'image') return;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data, 'base64')).toEqual(png);
    expect(harness.runner.calls[1]?.args).toEqual(['exec-out', 'screencap', '-p']);
  });

  it('explains an empty screenshot instead of returning broken image data', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG),
      binaryHandler: () => ({ stdout: Buffer.alloc(0) }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'screenshot', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no data');
  });

  it('streams logcat through start/read/stop', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    const started = await client.callTool({ name: 'start_logcat_stream', arguments: { filter_spec: 'ActivityManager:I *:S' } });
    expect(started.isError).toBeFalsy();
    const streamId = (JSON.parse(textOf(started)) as { stream_id: string }).stream_id;
    expect(streamId).toBe('logcat-1');
    expect(harness.streamSpawner.lastArgv).toEqual([
      '-s',
      'emulator-5554',
      'logcat',
      '-v',
      'threadtime',
      'ActivityManager:I',
      '*:S',
    ]);

    harness.streamSpawner.last.emitStdout('01-01 00:00:00.000 I/ActivityManager: start\n');
    const read = await client.callTool({ name: 'read_logcat_stream', arguments: { stream_id: streamId } });
    expect(read.isError).toBeFalsy();
    expect(textOf(read)).toContain('I/ActivityManager: start');

    const empty = await client.callTool({ name: 'read_logcat_stream', arguments: { stream_id: streamId } });
    expect(textOf(empty)).toContain('(no new logcat output)');

    const stopped = await client.callTool({ name: 'stop_logcat_stream', arguments: { stream_id: streamId } });
    expect(stopped.isError).toBeFalsy();
    expect(textOf(stopped)).toContain(`Stream ${streamId} stopped`);
    expect(harness.streamSpawner.last.killed).toContain('SIGTERM');
  });

  it('warns when stopping discards buffered bytes beyond max_bytes', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    const started = await client.callTool({ name: 'start_logcat_stream', arguments: {} });
    const streamId = (JSON.parse(textOf(started)) as { stream_id: string }).stream_id;
    harness.streamSpawner.last.emitStdout('0123456789ABCDEF');

    const stopped = await client.callTool({
      name: 'stop_logcat_stream',
      arguments: { stream_id: streamId, max_bytes: 4 },
    });
    expect(stopped.isError).toBeFalsy();
    expect(textOf(stopped)).toContain('0123');
    expect(textOf(stopped)).toContain('12 more buffered bytes were discarded');
  });

  it('reports an unknown stream id as an error with the active streams', async () => {
    const client = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const result = await client.callTool({ name: 'read_logcat_stream', arguments: { stream_id: 'logcat-42' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('start_logcat_stream');
  });
});

describe('app and ui tools', () => {
  it('launches a component with shell-quoted extras', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: 'Starting: Intent { cmp=com.example/.Main }' })),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'start_activity',
      arguments: {
        component: 'com.example/.MainActivity',
        extras: ['--es', 'message', 'hello world'],
        wait: true,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Starting: Intent');
    expect(harness.runner.calls[1]?.args).toEqual([
      'shell',
      "am start -W -n com.example/.MainActivity --es message 'hello world'",
    ]);
  });

  it('rejects an am start failure', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell'
          ? { stdout: 'Error: Activity class {com.example/.Missing} does not exist.', exitCode: 1 }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'start_activity',
      arguments: { component: 'com.example/.Missing' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not exist');
  });

  it('requires component or action for start_activity', async () => {
    const client = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const result = await client.callTool({ name: 'start_activity', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('component');
  });

  it('resolves the launcher from the --brief header and launches it by component', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('cmd package resolve-activity')) {
          return {
            stdout:
              'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n' +
              'com.android.settings/.Settings\n',
          };
        }
        if (command.startsWith('am start')) {
          return { stdout: 'Starting: Intent { cmp=com.android.settings/.Settings }' };
        }
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.android.settings' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('com.android.settings/.Settings');
    expect(textOf(result)).toContain('Starting: Intent');
    expect(harness.runner.calls[1]?.args).toEqual([
      'shell',
      'cmd package resolve-activity --brief -c android.intent.category.LAUNCHER com.android.settings',
    ]);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
    expect(harness.runner.calls[2]?.args).toEqual(['shell', 'am start -n com.android.settings/.Settings']);
    expect(harness.runner.calls[2]?.options.serial).toBe('emulator-5554');
  });

  it('quotes inner-class components and scans past vendor chatter when resolving', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('cmd package resolve-activity')) {
          return {
            stdout: 'Some vendor warning about resolve\nmore prose\ncom.example.app/.Outer$Inner\n',
          };
        }
        if (command.startsWith('am start')) return { stdout: 'Starting: Intent { cmp=com.example.app/.Outer$Inner }' };
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBeFalsy();
    // The device-derived component contains `$` (inner class), forcing device-shell quoting.
    expect(harness.runner.calls[2]?.args).toEqual(['shell', "am start -n 'com.example.app/.Outer$Inner'"]);
  });

  it('treats am start exit-0 with Error prose as a failure', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('cmd package resolve-activity')) return { stdout: 'com.example.app/.MainActivity' };
        if (command.startsWith('am start')) return { stdout: 'Error: Activity not started, unable to resolve Intent', exitCode: 0 };
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Error:');
  });

  it('passes -W when wait is true and surfaces the launch status output', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('cmd package resolve-activity')) {
          return { stdout: 'com.example.app/.MainActivity' };
        }
        if (command.startsWith('am start')) {
          return { stdout: 'Status: ok\nLaunchState: COLD\nActivity: com.example.app/.MainActivity' };
        }
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'launch_package',
      arguments: { package: 'com.example.app', wait: true },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Status: ok');
    expect(textOf(result)).toContain('LaunchState: COLD');
    expect(harness.runner.calls[2]?.args).toEqual(['shell', 'am start -W -n com.example.app/.MainActivity']);
  });

  it('fails with MULTIPLE_DEVICES before resolving when no device is chosen', async () => {
    const harness = createHarness({ handler: devicesHandler(TWO_DEVICES_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[MULTIPLE_DEVICES]');
    expect(textOf(result)).toContain('emulator-5554');
    expect(harness.runner.commands().some((command) => command.startsWith('shell'))).toBe(false);
  });

  it('parses headerless components and treats blank, empty and not-found resolution output as COMMAND_FAILED', async () => {
    const shapes: Array<{ label: string; stdout: string; stderr?: string; exitCode?: number; component?: string }> = [
      {
        label: 'header + component',
        stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.app/.MainActivity\n',
        component: 'com.example.app/.MainActivity',
      },
      {
        label: 'component only',
        stdout: 'com.example.app/com.example.app.MainActivity\n',
        component: 'com.example.app/com.example.app.MainActivity',
      },
      { label: 'not found prose', stdout: 'No activity found\n' },
      { label: 'not found on stderr', stdout: '', stderr: 'No activity found\n' },
      { label: 'blank output', stdout: '\n\n' },
      { label: 'empty output', stdout: '' },
      { label: 'non-zero exit', stdout: 'Error: package service unavailable', exitCode: 1 },
    ];
    for (const shape of shapes) {
      const harness = createHarness({
        handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
          if (args[0] !== 'shell') return undefined;
          const command = args[1] ?? '';
          if (command.startsWith('cmd package resolve-activity')) {
            return {
              stdout: shape.stdout,
              ...(shape.stderr !== undefined ? { stderr: shape.stderr } : {}),
              ...(shape.exitCode !== undefined ? { exitCode: shape.exitCode } : {}),
            };
          }
          if (command.startsWith('am start')) return { stdout: 'Starting: Intent' };
          return undefined;
        }),
      });
      const client = await connect(harness);
      const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.example.app' } });
      if (shape.component) {
        expect(result.isError, shape.label).toBeFalsy();
        expect(textOf(result), shape.label).toContain(shape.component);
        expect(harness.runner.commands(), shape.label).toContain(`shell am start -n ${shape.component}`);
      } else {
        expect(result.isError, shape.label).toBe(true);
        expect(textOf(result), shape.label).toContain('[COMMAND_FAILED]');
        expect(textOf(result), shape.label).toContain('list_packages');
        expect(textOf(result), shape.label).toContain('no LAUNCHER activity');
        expect(
          harness.runner.commands().some((command) => command.startsWith('shell am start')),
          shape.label,
        ).toBe(false);
      }
    }
  });

  it('shell-quotes the package id in the resolve-activity command', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        return (args[1] ?? '').startsWith('cmd package resolve-activity')
          ? { stdout: 'com.example.app/.MainActivity' }
          : { stdout: 'Starting: Intent' };
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'launch_package',
      arguments: { package: 'com.example.app; echo pwned' },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.runner.calls[1]?.args).toEqual([
      'shell',
      "cmd package resolve-activity --brief -c android.intent.category.LAUNCHER 'com.example.app; echo pwned'",
    ]);
  });

  it('maps an am start failure after a successful resolution to COMMAND_FAILED', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('cmd package resolve-activity')) {
          return { stdout: 'com.example.app/.MainActivity' };
        }
        if (command.startsWith('am start')) {
          return {
            stdout: 'Error: Activity class {com.example.app/.MainActivity} does not exist.',
            exitCode: 1,
          };
        }
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'launch_package', arguments: { package: 'com.example.app' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('does not exist');
    expect(textOf(result)).toContain('start_activity');
  });

  it('dumps the UI hierarchy via uiautomator + exec-out cat', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args.join(' ') === 'exec-out cat /sdcard/window_dump.xml'
          ? { stdout: '<?xml version="1.0"?><hierarchy><node text="OK"/></hierarchy>' }
          : { stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml' },
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('<node text="OK"/>');
    // The inline path is unchanged: fixed dump file, then exec-out cat, no to_file side effects.
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    expect(harness.runner.calls[2]?.args).toEqual(['exec-out', 'cat', '/sdcard/window_dump.xml']);
    expect(harness.runner.commands().some((command) => command.includes('adbmcp-ui-'))).toBe(false);
  });

  it('dumps to a timestamped device file and returns {path, bytes} for pull_file', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('uiautomator dump ')) {
          return { stdout: `UI hierchary dumped to: ${command.slice('uiautomator dump '.length)}` };
        }
        if (command.startsWith('wc -c ')) {
          return { stdout: `33896 ${command.slice('wc -c '.length)}` };
        }
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result).split('\n')[0] ?? '{}') as { path: string; bytes: number };
    expect(payload.path).toMatch(/^\/data\/local\/tmp\/adbmcp-ui-\d+-\d+\.xml$/);
    expect(payload.bytes).toBe(33896);
    expect(textOf(result)).toContain('pull_file');
    expect(textOf(result)).toContain(`rm ${payload.path}`);
    expect(harness.runner.calls[1]?.args).toEqual(['shell', `uiautomator dump ${payload.path}`]);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
    expect(harness.runner.calls[2]?.args).toEqual(['shell', `wc -c ${payload.path}`]);
    expect(harness.runner.calls[2]?.options.serial).toBe('emulator-5554');
  });

  it('produces distinct to_file paths across sequential calls (shared-context collision guard)', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('uiautomator dump ')) {
          return { stdout: `UI hierchary dumped to: ${command.slice('uiautomator dump '.length)}` };
        }
        if (command.startsWith('wc -c ')) return { stdout: `7 ${command.slice('wc -c '.length)}` };
        return undefined;
      }),
    });
    const client = await connect(harness);
    const first = JSON.parse(textOf(await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } })).split('\n')[0] ?? '{}') as { path: string };
    const second = JSON.parse(textOf(await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } })).split('\n')[0] ?? '{}') as { path: string };
    expect(first.path).not.toBe(second.path);
  });

  it('accepts toybox-padded wc output and dump prose on stderr only', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] !== 'shell') return undefined;
        const command = args[1] ?? '';
        if (command.startsWith('uiautomator dump ')) {
          return { stderr: `UI hierchary dumped to: ${command.slice('uiautomator dump '.length)}` };
        }
        if (command.startsWith('wc -c ')) return { stdout: `      33896 ${command.slice('wc -c '.length)}` };
        return undefined;
      }),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textOf(result).split('\n')[0] ?? '{}') as { bytes: number };
    expect(payload.bytes).toBe(33896);
  });

  it('accepts corrected and quiet dump output and trusts wc for the byte count', async () => {
    for (const dumpStdout of ['UI hierarchy dumped to: /path', '']) {
      const harness = createHarness({
        handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
          if (args[0] !== 'shell') return undefined;
          const command = args[1] ?? '';
          if (command.startsWith('uiautomator dump ')) return { stdout: dumpStdout };
          if (command.startsWith('wc -c ')) return { stdout: `12 ${command.slice('wc -c '.length)}` };
          return undefined;
        }),
      });
      const client = await connect(harness);
      const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } });
      expect(result.isError, JSON.stringify(dumpStdout)).toBeFalsy();
      const payload = JSON.parse(textOf(result).split('\n')[0] ?? '{}') as { bytes: number };
      expect(payload.bytes, JSON.stringify(dumpStdout)).toBe(12);
    }
  });

  it('rejects malformed dump output as COMMAND_FAILED without running wc', async () => {
    for (const dumpStdout of ['ERROR: could not get idle state.', 'unexpected uiautomator chatter']) {
      const harness = createHarness({
        handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
          if (args[0] !== 'shell') return undefined;
          const command = args[1] ?? '';
          if (command.startsWith('uiautomator dump ')) return { stdout: dumpStdout };
          return undefined;
        }),
      });
      const client = await connect(harness);
      const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } });
      expect(result.isError, dumpStdout).toBe(true);
      expect(textOf(result), dumpStdout).toContain('[COMMAND_FAILED]');
      expect(textOf(result), dumpStdout).toContain(dumpStdout);
      expect(
        harness.runner.commands().some((command) => command.includes('wc -c')),
        dumpStdout,
      ).toBe(false);
    }
  });

  it('rejects a zero-byte or unparsable wc result', async () => {
    for (const wcStdout of ['0 /path', 'not-a-number /path']) {
      const harness = createHarness({
        handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
          if (args[0] !== 'shell') return undefined;
          const command = args[1] ?? '';
          if (command.startsWith('uiautomator dump ')) {
            return { stdout: `UI hierchary dumped to: ${command.slice('uiautomator dump '.length)}` };
          }
          if (command.startsWith('wc -c ')) return { stdout: wcStdout };
          return undefined;
        }),
      });
      const client = await connect(harness);
      const result = await client.callTool({ name: 'get_ui_hierarchy', arguments: { to_file: true } });
      expect(result.isError, wcStdout).toBe(true);
      expect(textOf(result), wcStdout).toContain('[COMMAND_FAILED]');
    }
  });

  it('restarts the adb server and reports the device list', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'start-server' ? { stdout: '* daemon started successfully *' } : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'adb_server_restart', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('adb server restarted.');
    expect(harness.runner.commands()[0]).toBe('kill-server');
    expect(harness.runner.commands()[1]).toBe('start-server');
  });

  it('forwards and removes a port', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    await client.callTool({ name: 'forward_port', arguments: { local: 'tcp:8080', remote: 'tcp:8080' } });
    await client.callTool({ name: 'remove_forward', arguments: { local: 'tcp:8080' } });
    expect(harness.runner.commands()).toContain('forward tcp:8080 tcp:8080');
    expect(harness.runner.commands()).toContain('forward --remove tcp:8080');
  });

  it('rejects a malformed port spec before touching adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'forward_port', arguments: { local: '8080', remote: 'tcp:8080' } });
    expect(result.isError).toBe(true);
    expect(harness.runner.calls).toEqual([]);
  });

  it('reverses a port from the device to the host and removes it', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    const reversed = await client.callTool({
      name: 'reverse_port',
      arguments: { remote: 'tcp:18900', local: 'tcp:18901' },
    });
    expect(reversed.isError).toBeFalsy();
    expect(textOf(reversed)).toContain('Reversed tcp:18900 -> tcp:18901 on emulator-5554');
    expect(harness.runner.calls[1]?.args).toEqual(['reverse', 'tcp:18900', 'tcp:18901']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');

    const noRebind = await client.callTool({
      name: 'reverse_port',
      arguments: { remote: 'tcp:18900', local: 'tcp:18901', no_rebind: true },
    });
    expect(noRebind.isError).toBeFalsy();
    expect(harness.runner.calls[3]?.args).toEqual(['reverse', '--no-rebind', 'tcp:18900', 'tcp:18901']);

    const removed = await client.callTool({ name: 'remove_reverse', arguments: { remote: 'tcp:18900' } });
    expect(removed.isError).toBeFalsy();
    expect(harness.runner.commands()).toContain('reverse --remove tcp:18900');
  });

  it('lists forwards and reverses as structured JSON', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => {
        if (args[0] === 'forward' && args[1] === '--list') {
          return { stdout: 'emulator-5554 tcp:8080 tcp:8080\n' };
        }
        // adb reverse --list prints the transport name in the first column, not the serial.
        if (args[0] === 'reverse' && args[1] === '--list') {
          return { stdout: 'UsbFfs tcp:18900 tcp:18901\n' };
        }
        return undefined;
      }),
    });
    const client = await connect(harness);

    const forwards = await client.callTool({ name: 'list_forwards', arguments: {} });
    expect(forwards.isError).toBeFalsy();
    expect(JSON.parse(textOf(forwards))).toEqual([
      { serial: 'emulator-5554', local: 'tcp:8080', remote: 'tcp:8080' },
    ]);

    const reverses = await client.callTool({ name: 'list_reverses', arguments: {} });
    expect(reverses.isError).toBeFalsy();
    expect(JSON.parse(textOf(reverses))).toEqual([
      { serial: 'emulator-5554', remote: 'tcp:18900', local: 'tcp:18901' },
    ]);

    expect(harness.runner.calls[1]?.args).toEqual(['forward', '--list']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
    expect(harness.runner.calls[3]?.args).toEqual(['reverse', '--list']);
    expect(harness.runner.calls[3]?.options.serial).toBe('emulator-5554');
  });

  it('parses the 2-token forward list form that omits the serial', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'forward' && args[1] === '--list' ? { stdout: 'tcp:8080 tcp:8080\n' } : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'list_forwards', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual([
      { serial: 'emulator-5554', local: 'tcp:8080', remote: 'tcp:8080' },
    ]);
  });

  it('returns an empty JSON list when nothing is forwarded or reversed', async () => {
    const client = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const forwards = await client.callTool({ name: 'list_forwards', arguments: {} });
    expect(forwards.isError).toBeFalsy();
    expect(JSON.parse(textOf(forwards))).toEqual([]);
    const reverses = await client.callTool({ name: 'list_reverses', arguments: {} });
    expect(reverses.isError).toBeFalsy();
    expect(JSON.parse(textOf(reverses))).toEqual([]);
  });

  it('rejects malformed remote/local reverse specs and an unknown serial before touching the device', async () => {
    const malformed = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(malformed);
    const bad = await client.callTool({
      name: 'reverse_port',
      arguments: { remote: '18900', local: 'tcp:18901' },
    });
    expect(bad.isError).toBe(true);
    expect(malformed.runner.calls).toEqual([]);

    const badLocal = await client.callTool({
      name: 'reverse_port',
      arguments: { remote: 'tcp:18900', local: '18901' },
    });
    expect(badLocal.isError).toBe(true);
    expect(malformed.runner.calls).toEqual([]);

    const unknownDevice = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const missing = await unknownDevice.callTool({
      name: 'reverse_port',
      arguments: { remote: 'tcp:18900', local: 'tcp:18901', device: 'NOPE-DOES-NOT-EXIST' },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('[NO_DEVICE]');
  });

  it('rejects forward-only specs on the reverse device side and still accepts local* specs', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    for (const remote of ['jdwp:1234', 'dev:/dev/block/sda1', 'vsock:2:5555', 'acceptfd:3']) {
      const result = await client.callTool({
        name: 'reverse_port',
        arguments: { remote, local: 'tcp:18901' },
      });
      expect(result.isError, remote).toBe(true);
      expect(textOf(result), remote).toContain('forward-only');
      expect(textOf(result), remote).toContain('forward_port');
    }
    for (const remote of ['jdwp:1234', 'dev:/dev/block/sda1', 'vsock:2:5555', 'acceptfd:3']) {
      const result = await client.callTool({ name: 'remove_reverse', arguments: { remote } });
      expect(result.isError, remote).toBe(true);
      expect(textOf(result), remote).toContain('forward-only');
    }
    expect(harness.runner.calls).toEqual([]);

    const accepted = await client.callTool({
      name: 'reverse_port',
      arguments: { remote: 'localabstract:webview_devtools_remote', local: 'tcp:18901' },
    });
    expect(accepted.isError).toBeFalsy();
    expect(harness.runner.calls.at(-1)?.args).toEqual([
      'reverse',
      'localabstract:webview_devtools_remote',
      'tcp:18901',
    ]);
  });
});

describe('input injection tools', () => {
  it('taps a coordinate through adb shell with -s scoping', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'tap', arguments: { x: 540, y: 1200 } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Tapped (540, 1200)');
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'input tap 540 1200']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
  });

  it('rejects negative, fractional and non-numeric tap coordinates before spawning adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const invalid: Array<Record<string, unknown>> = [
      { x: -1, y: 10 },
      { x: 10, y: -1 },
      { x: 1.5, y: 10 },
      { x: '10', y: 10 },
    ];
    for (const args of invalid) {
      const result = await client.callTool({ name: 'tap', arguments: args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.runner.calls).toEqual([]);
  });

  it('swipes with and without an explicit duration', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    await client.callTool({ name: 'swipe', arguments: { x1: 1, y1: 2, x2: 3, y2: 4 } });
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'input swipe 1 2 3 4']);

    await client.callTool({ name: 'swipe', arguments: { x1: 1, y1: 2, x2: 3, y2: 4, duration_ms: 800 } });
    expect(harness.runner.calls[3]?.args).toEqual(['shell', 'input swipe 1 2 3 4 800']);
    // The adb client must stay alive for the gesture it injects.
    expect(harness.runner.calls[3]?.options.timeoutMs).toBe(harness.config.limits.defaultTimeoutMs + 800);
  });

  it('rejects a non-positive swipe duration before spawning adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'swipe',
      arguments: { x1: 0, y1: 0, x2: 1, y2: 1, duration_ms: 0 },
    });
    expect(result.isError).toBe(true);
    expect(harness.runner.calls).toEqual([]);
  });

  it('encodes type_text spaces as %s and quotes device-shell metacharacters', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const cases: Array<[string, string]> = [
      ['hello world', 'input text hello%sworld'],
      ['a b c', 'input text a%sb%sc'],
      ["don't stop", "input text 'don'\\''t%sstop'"],
      ['say "hi"', 'input text \'say%s"hi"\''],
      ['a;b&c|d', "input text 'a;b&c|d'"],
      ['$(id) `whoami`', "input text '$(id)%s`whoami`'"],
      ['a<b>c', "input text 'a<b>c'"],
      ['a\\b', "input text 'a\\b'"],
      ['star*question?~', "input text 'star*question?~'"],
      // Non-ASCII rows (héllo wörld, hi 👋) moved to the IME broadcast tests below:
      // `input text` is ASCII-only, so they no longer go through this path (issue #3).
      ['100%', 'input text 100%'],
      ['line one\nline two', "input text 'line%sone\nline%stwo'"], // spaces→%s; newline stays literal inside quotes (keymap → ENTER)
      ['a\tb', "input text 'a\tb'"],
      ["end'", "input text 'end'\\'''"],
      ['100%s done', 'input text 100%s%sdone'],
      ['-rf', 'input text -rf'],
    ];
    for (const [text, expected] of cases) {
      const result = await client.callTool({ name: 'type_text', arguments: { text } });
      expect(result.isError, text).toBeFalsy();
      expect(harness.runner.calls.at(-1)?.args, text).toEqual(['shell', expected]);
    }
    for (const call of harness.runner.calls.filter((entry) => entry.args[0] === 'shell')) {
      expect(call.options.serial).toBe('emulator-5554');
    }
  });

  it('rejects empty type_text before spawning adb', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '' } });
    expect(result.isError).toBe(true);
    expect(harness.runner.calls).toEqual([]);
  });

  it('keeps ASCII type_text on the input text fast path with no IME round trip', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args.join(' ').includes('settings')
          ? { stdout: 'com.android.adbkeyboard/.AdbIME\n' }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: 'hello world' } });
    expect(result.isError).toBeFalsy();
    // [0] = devices -l, [1] = the single input text call — nothing else.
    expect(harness.runner.calls).toHaveLength(2);
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'input text hello%sworld']);
    expect(
      harness.runner.commands().some((command) => command.includes('settings')),
      'ASCII text must not pay the IME-detection round trip',
    ).toBe(false);
  });

  it('types CJK text via the ADB_INPUT_B64 broadcast when AdbIME is active (issue #3)', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args.join(' ') === 'shell settings get secure default_input_method'
          ? { stdout: 'com.android.adbkeyboard/.AdbIME\n' }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('broadcast');
    // [0] = devices -l, [1] = IME detection, [2] = the broadcast itself.
    expect(harness.runner.calls[1]?.args).toEqual([
      'shell',
      'settings get secure default_input_method',
    ]);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');
    expect(harness.runner.calls[2]?.args).toEqual([
      'shell',
      'am broadcast -a ADB_INPUT_B64 --es msg 5ZKW5ZWh', // base64('咖啡'), safe-token so unquoted
    ]);
    expect(harness.runner.calls[2]?.options.serial).toBe('emulator-5554');
  });

  it('broadcasts other non-ASCII scripts too (Latin accents, emoji)', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: 'com.android.adbkeyboard/.AdbIME\n' })),
    });
    const client = await connect(harness);
    const cases: Array<[string, string]> = [
      ['héllo wörld', 'aMOpbGxvIHfDtnJsZA=='],
      ['hi 👋', 'aGkg8J+Riw=='],
    ];
    for (const [text, base64] of cases) {
      const result = await client.callTool({ name: 'type_text', arguments: { text } });
      expect(result.isError, text).toBeFalsy();
      expect(harness.runner.calls.at(-1)?.args, text).toEqual([
        'shell',
        `am broadcast -a ADB_INPUT_B64 --es msg ${base64}`,
      ]);
    }
  });

  it('accepts the flattened component form of the active IME', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({
        stdout: 'com.android.adbkeyboard/com.android.adbkeyboard.AdbIME\n',
      })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBeFalsy();
    expect(harness.runner.calls.at(-1)?.args).toEqual([
      'shell',
      'am broadcast -a ADB_INPUT_B64 --es msg 5ZKW5ZWh',
    ]);
  });

  it('honours ADBMCP_IME_BROADCAST_COMPONENTS for a custom capable IME', async () => {
    const harness = createHarness({
      env: { ADBMCP_IME_BROADCAST_COMPONENTS: 'com.example.ime/.B64IME' },
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: 'com.example.ime/.B64IME\n' })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBeFalsy();
    // [0] = devices -l, [1] = IME detection, [2] = the broadcast.
    expect(harness.runner.calls).toHaveLength(3);
    expect(harness.runner.calls[2]?.args).toEqual([
      'shell',
      'am broadcast -a ADB_INPUT_B64 --es msg 5ZKW5ZWh',
    ]);
  });

  it('fails with [IME_UNAVAILABLE] when another IME is active, without broadcasting', async () => {
    const activeIme = 'com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME';
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, () => ({ stdout: `${activeIme}\n` })),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[IME_UNAVAILABLE]');
    expect(textOf(result)).toContain(activeIme);
    expect(textOf(result)).toContain('com.android.adbkeyboard');
    expect(textOf(result)).toContain('Hint:');
    expect(harness.runner.commands().some((command) => command.includes('am broadcast'))).toBe(false);
  });

  it('fails with [IME_UNAVAILABLE] when no IME is selected (null or empty)', async () => {
    for (const stdout of ['', 'null\n']) {
      const harness = createHarness({
        handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
          args.join(' ').includes('settings') ? { stdout } : undefined,
        ),
      });
      const client = await connect(harness);
      const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
      expect(result.isError, JSON.stringify(stdout)).toBe(true);
      expect(textOf(result), JSON.stringify(stdout)).toContain('[IME_UNAVAILABLE]');
      expect(textOf(result), JSON.stringify(stdout)).toContain('No IME is currently selected.');
      expect(harness.runner.commands().some((command) => command.includes('am broadcast'))).toBe(
        false,
      );
    }
  });

  it('rejects non-ASCII text with [TEXT_NOT_ASCII] in reject mode, before any device shell call', async () => {
    const harness = createHarness({
      env: { ADBMCP_TYPE_TEXT_NON_ASCII: 'reject' },
      handler: devicesHandler(ONE_DEVICE_LONG),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[TEXT_NOT_ASCII]');
    expect(textOf(result)).toContain('ADBMCP_TYPE_TEXT_NON_ASCII');
    // Only the devices -l listing ran: reject mode never touches the device shell.
    expect(harness.runner.calls).toHaveLength(1);

    // ASCII text is unaffected by reject mode.
    const ascii = await client.callTool({ name: 'type_text', arguments: { text: 'ok' } });
    expect(ascii.isError).toBeFalsy();
    expect(harness.runner.calls.at(-1)?.args).toEqual(['shell', 'input text ok']);
  });

  it('surfaces a typed cause when the IME detection query itself fails', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args.join(' ').includes('settings')
          ? { stdout: '', stderr: 'error: device offline', exitCode: 1 }
          : undefined,
      ),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'type_text', arguments: { text: '咖啡' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[DEVICE_OFFLINE]');
    expect(harness.runner.commands().some((command) => command.includes('am broadcast'))).toBe(false);
  });

  it('maps every named key to its Android keycode', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const named: Array<[string, number]> = [
      ['HOME', 3],
      ['BACK', 4],
      ['ENTER', 66],
      ['DEL', 67],
      ['MENU', 82],
      ['POWER', 26],
      ['VOLUME_UP', 24],
      ['VOLUME_DOWN', 25],
      ['TAB', 61],
      ['ESCAPE', 111],
      ['APP_SWITCH', 187],
      ['WAKEUP', 224],
      ['SLEEP', 223],
    ];
    for (const [key, code] of named) {
      const result = await client.callTool({ name: 'key_event', arguments: { key } });
      expect(result.isError, key).toBeFalsy();
      expect(harness.runner.calls.at(-1)?.args, key).toEqual(['shell', `input keyevent ${code}`]);
    }
  });

  it('accepts a raw keycode and rejects unknown names or out-of-range codes pre-spawn', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);

    const numeric = await client.callTool({ name: 'key_event', arguments: { key: 26 } });
    expect(numeric.isError).toBeFalsy();
    expect(harness.runner.calls.at(-1)?.args).toEqual(['shell', 'input keyevent 26']);

    const unknown = await client.callTool({ name: 'key_event', arguments: { key: 'HOM' } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('HOME');
    expect(textOf(unknown)).toContain('keycode 0-300');

    const callsAfterNumeric = harness.runner.calls.length;
    for (const key of ['HOM', 'home', 301, -1, 1.5]) {
      const result = await client.callTool({ name: 'key_event', arguments: { key } });
      expect(result.isError, String(key)).toBe(true);
      expect(harness.runner.calls.length, String(key)).toBe(callsAfterNumeric);
    }
  });
});

describe('dumpsys_query', () => {
  it('queries a curated service and token-quotes extra args', async () => {
    const harness = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) =>
        args[0] === 'shell' ? { stdout: 'Current Battery Service state:\n  level: 87' } : undefined,
      ),
    });
    const client = await connect(harness);

    const battery = await client.callTool({ name: 'dumpsys_query', arguments: { service: 'battery' } });
    expect(battery.isError).toBeFalsy();
    expect(textOf(battery)).toContain('level: 87');
    expect(harness.runner.calls[1]?.args).toEqual(['shell', 'dumpsys battery']);
    expect(harness.runner.calls[1]?.options.serial).toBe('emulator-5554');

    const activity = await client.callTool({
      name: 'dumpsys_query',
      arguments: { service: 'activity', extra_args: 'activities com.example.app' },
    });
    expect(activity.isError).toBeFalsy();
    expect(harness.runner.calls[3]?.args).toEqual(['shell', 'dumpsys activity activities com.example.app']);
  });

  it('rejects an uncurated service before spawning adb and names the valid ones', async () => {
    const harness = createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'dumpsys_query', arguments: { service: 'cpuinfo' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('battery');
    expect(textOf(result)).toContain('connectivity');
    expect(harness.runner.calls).toEqual([]);
  });

  it('caps the runner budget for huge dumps while respecting a smaller configured cap', async () => {
    const large = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => (args[0] === 'shell' ? { stdout: 'x' } : undefined)),
    });
    large.ctx.config.limits.maxOutputBytes = 1024 * 1024;
    const largeClient = await connect(large);
    await largeClient.callTool({ name: 'dumpsys_query', arguments: { service: 'activity' } });
    expect(large.runner.calls[1]?.options.maxBytes).toBe(64 * 1024);

    const small = createHarness({
      handler: devicesHandler(ONE_DEVICE_LONG, (args) => (args[0] === 'shell' ? { stdout: 'x' } : undefined)),
    });
    const smallClient = await connect(small);
    await smallClient.callTool({ name: 'dumpsys_query', arguments: { service: 'window' } });
    expect(small.runner.calls[1]?.options.maxBytes).toBe(small.config.limits.maxOutputBytes);
  });
});

describe('wireless TCP/IP tools', () => {
  it('connects to a host:port without resolving a device serial', async () => {
    const harness = createHarness({
      handler: (args) => (args[0] === 'connect' ? { stdout: 'connected to 192.168.1.42:5555' } : undefined),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'connect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('connected to 192.168.1.42:5555');
    // connect is host-level: no `adb devices` lookup and no `-s` scoping.
    expect(harness.runner.calls.map((call) => call.args)).toEqual([['connect', '192.168.1.42:5555']]);
  });

  it('treats "failed to connect" output as an error even though adb exits 0', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'connect'
          ? { stderr: "failed to connect to '192.168.1.42:5555': Connection refused", exitCode: 0 }
          : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'connect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('Connection refused');
    // Android 11+ needs pairing first; the hint points at wireless_pair.
    expect(textOf(result)).toContain('wireless_pair');
  });

  it('treats "already connected to" success output as a success, not a failure', async () => {
    const harness = createHarness({
      handler: (args) => (args[0] === 'connect' ? { stdout: 'already connected to 192.168.1.42:5555' } : undefined),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'connect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('already connected to 192.168.1.42:5555');
  });

  it('reports a non-zero connect exit code as an error even without failure prose', async () => {
    const harness = createHarness({
      handler: (args) => (args[0] === 'connect' ? { stdout: '', stderr: '', exitCode: 1 } : undefined),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'connect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
  });

  it('rejects a malformed connect address before spawning adb', async () => {
    const harness = createHarness();
    const client = await connect(harness);
    for (const address of ['192.168.1.42', '192.168.1.42:0', '192.168.1.42:99999', 'bad host:5555']) {
      const result = await client.callTool({ name: 'connect', arguments: { address } });
      expect(result.isError, address).toBe(true);
    }
    expect(harness.runner.calls).toEqual([]);
  });

  it('trims whitespace around a connect address before validating and spawning adb', async () => {
    const harness = createHarness({
      handler: (args) => (args[0] === 'connect' ? { stdout: 'connected to 192.168.1.42:5555' } : undefined),
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'connect', arguments: { address: '  192.168.1.42:5555  ' } });
    expect(result.isError).toBeFalsy();
    expect(harness.runner.calls.map((call) => call.args)).toEqual([['connect', '192.168.1.42:5555']]);
  });

  it('disconnects one address or every TCP/IP device', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'disconnect'
          ? { stdout: args.length > 1 ? `disconnected ${args[1]}` : 'disconnected everything' }
          : undefined,
    });
    const client = await connect(harness);

    const one = await client.callTool({ name: 'disconnect', arguments: { address: '192.168.1.42:5555' } });
    expect(one.isError).toBeFalsy();
    expect(textOf(one)).toContain('disconnected 192.168.1.42:5555');

    const all = await client.callTool({ name: 'disconnect', arguments: {} });
    expect(all.isError).toBeFalsy();
    expect(textOf(all)).toContain('disconnected everything');

    expect(harness.runner.calls.map((call) => call.args)).toEqual([
      ['disconnect', '192.168.1.42:5555'],
      ['disconnect'],
    ]);
  });

  it('sniffs "no such device" prose from an address-targeted disconnect even when adb exits 0', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'disconnect'
          ? { stderr: "error: no such device '192.168.1.42:5555'", exitCode: 0 }
          : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'disconnect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('no such device');
    expect(textOf(result)).toContain('not an active TCP/IP connection');
  });

  it('reports the adb 34 exit-1 disconnect shape with the same actionable hint', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'disconnect'
          ? { stderr: "error: no such device '192.168.1.42:5555'", exitCode: 1 }
          : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({ name: 'disconnect', arguments: { address: '192.168.1.42:5555' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('not an active TCP/IP connection');
  });

  it('rejects a malformed disconnect address before spawning adb', async () => {
    const harness = createHarness();
    const client = await connect(harness);
    const result = await client.callTool({ name: 'disconnect', arguments: { address: '192.168.1.42:70000' } });
    expect(result.isError).toBe(true);
    expect(harness.runner.calls).toEqual([]);
  });
});

describe('wireless pairing', () => {
  it('pairs with a host:pair_port and code without resolving a device', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'pair'
          ? { stdout: 'Successfully paired to 192.168.1.42:37421 [guid=adb-emulator-5554]' }
          : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'wireless_pair',
      arguments: { host: '192.168.1.42', pair_port: 37421, code: '123456' },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Successfully paired');
    // pair is host-level: no `adb devices` lookup and no `-s` scoping.
    expect(harness.runner.calls.map((call) => call.args)).toEqual([
      ['pair', '192.168.1.42:37421', '123456'],
    ]);
    expect(harness.runner.calls[0]?.options.serial).toBeUndefined();
  });

  it('accepts a hyphenated pairing code and strips the hyphen', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'pair' ? { stdout: 'Successfully paired to 192.168.1.42:37421' } : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'wireless_pair',
      arguments: { host: '192.168.1.42', pair_port: 37421, code: '123-456' },
    });
    expect(result.isError).toBeFalsy();
    expect(harness.runner.calls[0]?.args).toEqual(['pair', '192.168.1.42:37421', '123456']);
  });

  it('treats "Failed to pair" output as an error even though adb exits 0', async () => {
    const harness = createHarness({
      handler: (args) =>
        args[0] === 'pair'
          ? { stdout: 'Failed to pair to 192.168.1.42:37421: incorrect pairing code', exitCode: 0 }
          : undefined,
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'wireless_pair',
      arguments: { host: '192.168.1.42', pair_port: 37421, code: '123456' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
    expect(textOf(result)).toContain('incorrect pairing code');
    expect(textOf(result)).toContain('expire');
  });

  it('reports a non-zero pair exit code even without failure prose', async () => {
    const harness = createHarness({
      handler: (args) => (args[0] === 'pair' ? { stdout: '', stderr: '', exitCode: 1 } : undefined),
    });
    const client = await connect(harness);
    const result = await client.callTool({
      name: 'wireless_pair',
      arguments: { host: '192.168.1.42', pair_port: 37421, code: '123456' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[COMMAND_FAILED]');
  });

  it('rejects malformed codes, hosts and ports before spawning adb', async () => {
    const harness = createHarness();
    const client = await connect(harness);
    const badCodes = ['12345', '1234567', '12-345', '123-45', 'abcdef', '', '123-456-789'];
    for (const code of badCodes) {
      const result = await client.callTool({
        name: 'wireless_pair',
        arguments: { host: '192.168.1.42', pair_port: 37421, code },
      });
      expect(result.isError, `code "${code}"`).toBe(true);
    }
    const badHost = await client.callTool({
      name: 'wireless_pair',
      arguments: { host: 'bad host', pair_port: 37421, code: '123456' },
    });
    expect(badHost.isError).toBe(true);
    for (const pair_port of [0, 70000, 1.5]) {
      const result = await client.callTool({
        name: 'wireless_pair',
        arguments: { host: '192.168.1.42', pair_port, code: '123456' },
      });
      expect(result.isError, `port ${pair_port}`).toBe(true);
    }
    expect(harness.runner.calls).toEqual([]);
  });
});

describe('resources and prompts', () => {
  it('exposes the live device list as adb://devices', async () => {
    const client = await connect(createHarness({ handler: devicesHandler(ONE_DEVICE_LONG) }));
    const list = await client.listResources();
    expect(list.resources.map((resource) => resource.uri)).toContain('adb://devices');

    const read = await client.readResource({ uri: 'adb://devices' });
    const content = read.contents[0];
    expect(content).toBeDefined();
    if (!content || !('text' in content)) throw new Error('expected text resource contents');
    const payload = JSON.parse(content.text) as { devices: Array<{ serial: string; state: string }> };
    expect(payload.devices).toEqual([
      { serial: 'emulator-5554', state: 'device', model: 'sdk_gphone64_x86_64', product: 'sdk_gphone64_x86_64', device: 'emu64xa', transport_id: '1', allowed: true },
    ]);
  });

  it('ships the three MVP prompts', async () => {
    const client = await connect(createHarness());
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([
      'capture_bug_report',
      'debug_crash',
      'install_and_launch',
    ]);
  });

  it('renders a prompt that orchestrates the tools', async () => {
    const client = await connect(createHarness());
    const prompt = await client.getPrompt({
      name: 'debug_crash',
      arguments: { package: 'com.example.app', device: 'emulator-5554' },
    });
    const first = prompt.messages[0];
    expect(first).toBeDefined();
    const content = first?.content;
    expect(content?.type).toBe('text');
    if (content?.type !== 'text') return;
    expect(content.text).toContain('com.example.app');
    expect(content.text).toContain('emulator-5554');
    expect(content.text).toContain('logcat_snapshot');
    expect(content.text).toContain('AndroidRuntime:E');
  });
});
