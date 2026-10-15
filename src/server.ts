/**
 * Server assembly: config → adb runner → device manager → tool/resource/prompt
 * layers (design §5). Kept separate from the entrypoint so tests can build a
 * server around fake adb deps.
 */
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { AdbRunner } from './adb/runner.js';
import { loadConfig, type AdbmcpConfig } from './config.js';
import type { ServerContext } from './context.js';
import { DeviceManager } from './devices.js';
import { registerPrompts } from './prompts/index.js';
import { registerDeviceResource } from './resources/devices.js';
import { createAdbStreamSpawner, StreamRegistry } from './streams/registry.js';
import { registerTools } from './tools/index.js';

export const SERVER_NAME = 'adbmcp';

export const SERVER_INSTRUCTIONS = [
  'adbmcp exposes the Android Debug Bridge (adb) as MCP tools.',
  'Start with list_devices. Every device-scoped tool takes an optional "device" serial, which becomes required as soon as more than one device is connected.',
  'Failures carry a machine-readable cause (NO_DEVICE, MULTIPLE_DEVICES, DEVICE_UNAUTHORIZED, DEVICE_OFFLINE, ADB_SERVER_CONFLICT, TIMEOUT, COMMAND_FAILED) plus a hint for the next step.',
  'Read-only tools can be auto-approved. uninstall_package and shell are not read-only, and shell refuses reboot / privilege-escalation / disk-destroying commands by default.',
].join(' ');

export function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'string'
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Packaged layouts differ (bundlers, npx cache); the version is cosmetic.
  }
  return '0.0.0';
}

/** Real context: adb binary from config, long-lived logcat streams on top of it. */
export function createContext(env: NodeJS.ProcessEnv = process.env): ServerContext {
  const config: AdbmcpConfig = loadConfig(env);
  const runner = new AdbRunner({
    adbPath: config.adbPath,
    defaultTimeoutMs: config.limits.defaultTimeoutMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  });
  const devices = new DeviceManager(runner, config);
  const streams = new StreamRegistry({
    spawner: createAdbStreamSpawner(config.adbPath),
    bufferBytes: config.logcat.bufferBytes,
    format: config.logcat.format,
  });
  return { config, runner, devices, streams };
}

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: readVersion() },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, ctx);
  registerDeviceResource(server, ctx);
  registerPrompts(server);
  return server;
}
