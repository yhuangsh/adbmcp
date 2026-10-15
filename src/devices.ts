import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AdbInvoker } from './adb/runner.js';
import {
  AdbError,
  mapAdbFailure,
  multipleDevicesError,
  noDeviceError,
  offlineError,
  unauthorizedError,
} from './adb/errors.js';
import { GuardrailError, type AdbmcpConfig } from './config.js';
import type { ServerContext } from './context.js';
import { guard, textResult } from './tools/common.js';

export type DeviceState =
  | 'device'
  | 'offline'
  | 'unauthorized'
  | 'bootloader'
  | 'recovery'
  | 'sideload'
  | 'connecting'
  | 'no_permissions'
  | 'unknown';

export interface DeviceEntry {
  serial: string;
  state: DeviceState;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
  /** False when ADBMCP_ALLOWED_DEVICES excludes this serial. */
  allowed: boolean;
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'sideload',
  'connecting',
]);

function isKnownState(value: string): value is DeviceState {
  return KNOWN_STATES.has(value);
}

export interface RawDeviceEntry {
  serial: string;
  state: DeviceState;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
}

/**
 * Parse `adb devices -l` stdout. adb informational lines ("* daemon not running…",
 * "List of devices attached") are skipped rather than treated as devices.
 */
export function parseDevicesOutput(stdout: string): RawDeviceEntry[] {
  const entries: RawDeviceEntry[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('*') || trimmed.toLowerCase().startsWith('list of devices')) continue;
    const tokens = trimmed.split(/\s+/);
    const serial = tokens[0];
    if (serial === undefined) continue;
    const stateToken = tokens[1];
    const state: DeviceState = stateToken !== undefined && isKnownState(stateToken) ? stateToken : 'unknown';
    const details: Record<string, string> = {};
    for (const token of tokens.slice(2)) {
      const separator = token.indexOf(':');
      if (separator > 0) {
        details[token.slice(0, separator)] = token.slice(separator + 1);
      }
    }
    const entry: RawDeviceEntry = { serial, state };
    const model = details['model'];
    const product = details['product'];
    const device = details['device'];
    const transportId = details['transport_id'];
    if (model !== undefined) entry.model = model;
    if (product !== undefined) entry.product = product;
    if (device !== undefined) entry.device = device;
    if (transportId !== undefined) entry.transportId = transportId;
    if (state === 'unknown' && stateToken === 'no') {
      // `????????????  no permissions` — udev/driver problem, not a usable device.
      entry.state = 'no_permissions';
    }
    entries.push(entry);
  }
  return entries;
}

function isAllowed(serial: string, allowedDevices: string[] | null): boolean {
  return allowedDevices === null || allowedDevices.includes(serial);
}

function printableState(entry: RawDeviceEntry): string {
  return entry.state === 'no_permissions' ? 'no permissions' : entry.state;
}

/** Device listing plus the "which serial should this call use?" rule (design §5). */
export class DeviceManager {
  constructor(
    private readonly runner: AdbInvoker,
    private readonly config: AdbmcpConfig,
  ) {}

  /** Live device list, refreshed per call — never cached. */
  async list(): Promise<DeviceEntry[]> {
    const result = await this.runner.run(['devices', '-l'], {
      operation: 'list_devices',
      timeoutMs: this.config.limits.defaultTimeoutMs,
      maxBytes: this.config.limits.maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      throw mapAdbFailure(result, { operation: 'list_devices' });
    }
    return parseDevicesOutput(result.stdout).map((entry) => ({
      ...entry,
      allowed: isAllowed(entry.serial, this.config.allowedDevices),
    }));
  }

  /**
   * Resolution rule: explicit serial → the single usable connected device →
   * a typed error naming the candidates.
   */
  async resolve(device?: string): Promise<string> {
    const entries = await this.list();
    const requested = device?.trim();
    if (requested && requested.length > 0) {
      if (!isAllowed(requested, this.config.allowedDevices)) {
        throw new GuardrailError(
          'device.notAllowed',
          `Device "${requested}" is not in ADBMCP_ALLOWED_DEVICES, so adbmcp refuses to operate on it.`,
        );
      }
      const entry = entries.find((candidate) => candidate.serial === requested);
      if (!entry) {
        throw noDeviceError(
          requested,
          entries.map((candidate) => candidate.serial),
        );
      }
      return this.assertUsable(entry);
    }

    const usable = entries.filter(
      (entry) => entry.state === 'device' && isAllowed(entry.serial, this.config.allowedDevices),
    );
    if (usable.length === 1) {
      const only = usable[0];
      if (only !== undefined) return only.serial;
    }
    if (usable.length > 1) {
      throw multipleDevicesError(usable.map((entry) => entry.serial));
    }

    // Nothing usable: explain the most specific reason we can see.
    const blocked = entries.filter((entry) => !entry.allowed);
    const present = entries.filter((entry) => entry.allowed);
    const firstProblem = present[0];
    if (firstProblem === undefined) {
      if (blocked.length > 0) {
        throw new GuardrailError(
          'device.notAllowed',
          `No device is available: ${blocked.length} connected device(s) are excluded by ADBMCP_ALLOWED_DEVICES (${blocked
            .map((entry) => entry.serial)
            .join(', ')}).`,
        );
      }
      throw noDeviceError(undefined);
    }
    return this.assertUsable(firstProblem);
  }

  /** Turn a non-`device` state into an actionable failure. */
  private assertUsable(entry: DeviceEntry): string {
    switch (entry.state) {
      case 'device':
        return entry.serial;
      case 'unauthorized':
        throw unauthorizedError(entry.serial);
      case 'offline':
      case 'connecting':
        throw offlineError(entry.serial);
      case 'no_permissions':
        throw new AdbError({
          cause: 'NO_DEVICE',
          message: `Device "${entry.serial}" is visible to adb but adbmcp has no permission to open it ("no permissions").`,
          hint: 'Fix the host-side rules for the device: check udev rules on Linux or the device driver on Windows, then run adb_server_restart.',
        });
      default:
        throw new AdbError({
          cause: 'DEVICE_OFFLINE',
          message: `Device "${entry.serial}" is in adb state "${printableState(entry)}", which adb shell/install commands cannot use.`,
          hint: 'Wait for the device to finish booting (state "device"), or boot it into normal mode.',
        });
    }
  }
}

/** Human/agent-readable device table. */
export function formatDeviceList(entries: DeviceEntry[], allowedDevices: string[] | null): string {
  if (entries.length === 0) {
    return 'No devices connected. Start an emulator or connect a device over USB/TCP, then re-run list_devices.';
  }
  const rows = entries.map((entry) => {
    const cells = [
      entry.serial,
      printableState(entry),
      entry.model ?? '-',
      entry.transportId ?? '-',
      entry.allowed ? 'yes' : 'no',
    ];
    return `| ${cells.join(' | ')} |`;
  });
  const usable = entries.filter((entry) => entry.state === 'device' && entry.allowed).length;
  const lines = [
    '| serial | state | model | transport_id | allowed |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    `${entries.length} device(s) connected, ${usable} usable.`,
  ];
  if (usable > 1) {
    lines.push('More than one device is usable: pass "device": "<serial>" on every device-scoped tool call.');
  }
  if (allowedDevices !== null) {
    lines.push(`ADBMCP_ALLOWED_DEVICES is set (${allowedDevices.join(', ')}); non-listed devices show allowed=no.`);
  }
  return lines.join('\n');
}

/** `list_devices` tool (design §4.1). */
export function registerListDevicesTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'list_devices',
    {
      title: 'List connected Android devices',
      description:
        'List Android devices and emulators known to adb with their serial, connection state and model. Call this first to discover serials for the "device" parameter of other tools.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      await guard(async () => {
        const entries = await ctx.devices.list();
        return textResult(formatDeviceList(entries, ctx.config.allowedDevices));
      }),
  );
}
