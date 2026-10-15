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
  'start_activity',
  'force_stop_app',
  'get_ui_hierarchy',
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
    expect(byName.get('shell')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('shell')?.annotations?.openWorldHint).toBe(true);
    expect(byName.get('pull_file')?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get('install_apk')?.annotations?.destructiveHint).toBe(false);
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
    expect(harness.runner.commands()).toContain('shell uiautomator dump /sdcard/window_dump.xml');
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
