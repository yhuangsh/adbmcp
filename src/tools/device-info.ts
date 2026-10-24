import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

/** Property keys surfaced by get_device_info, in display order. */
const CURATED_PROPERTIES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'ro.serialno', label: 'serialno' },
  { key: 'ro.product.manufacturer', label: 'manufacturer' },
  { key: 'ro.product.model', label: 'model' },
  { key: 'ro.product.device', label: 'device' },
  { key: 'ro.build.version.release', label: 'android_version' },
  { key: 'ro.build.version.sdk', label: 'sdk' },
  { key: 'ro.build.version.security_patch', label: 'security_patch' },
  { key: 'ro.product.cpu.abi', label: 'abi' },
  { key: 'ro.build.characteristics', label: 'characteristics' },
  { key: 'ro.debuggable', label: 'debuggable' },
];

export function parseGetprop(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim());
    if (match && match[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }
  return values;
}

/** `wm size` output -> "1080x2400" (override wins when present). */
export function parseWmSize(stdout: string): string | undefined {
  const lines = stdout.split('\n').map((line) => line.trim());
  const override = lines.find((line) => line.startsWith('Override size:'));
  const physical = lines.find((line) => line.startsWith('Physical size:'));
  const chosen = override ?? physical;
  return chosen?.split(':')[1]?.trim();
}

/** `wm density` output -> "420" (override wins when present). */
export function parseWmDensity(stdout: string): string | undefined {
  const lines = stdout.split('\n').map((line) => line.trim());
  const override = lines.find((line) => line.startsWith('Override density:'));
  const physical = lines.find((line) => line.startsWith('Physical density:'));
  const chosen = override ?? physical;
  return chosen?.split(':')[1]?.trim();
}

export function registerDeviceInfoTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'get_device_info',
    {
      title: 'Get device information',
      description:
        'Read a curated set of build properties (model, Android version, SDK level, ABI) plus screen size and density for one device. Use it instead of shell getprop when you only need identity/build details.',
      inputSchema: {
        device: z.string().optional().describe('Device serial from list_devices; optional when exactly one device is connected.'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const serial = await ctx.devices.resolve(args.device);
        const limits = ctx.config.limits;
        const props = await ctx.runner.runChecked(['shell', 'getprop'], {
          serial,
          operation: 'get_device_info',
          timeoutMs: limits.defaultTimeoutMs,
          maxBytes: limits.maxOutputBytes,
        });
        const values = parseGetprop(props.stdout);

        const lines = [`device: ${serial}`];
        for (const { key, label } of CURATED_PROPERTIES) {
          const value = values.get(key);
          if (value !== undefined && value.length > 0) lines.push(`${label}: ${value}`);
        }

        // Display metrics come from `wm`, which is far cheaper than dumpsys.
        const size = await ctx.runner.run(['shell', 'wm', 'size'], { serial, operation: 'get_device_info' });
        const density = await ctx.runner.run(['shell', 'wm', 'density'], { serial, operation: 'get_device_info' });
        if (size.exitCode === 0) {
          const parsed = parseWmSize(size.stdout);
          if (parsed) lines.push(`screen_size: ${parsed}`);
        }
        if (density.exitCode === 0) {
          const parsed = parseWmDensity(density.stdout);
          if (parsed) lines.push(`screen_density: ${parsed}`);
        }
        return textResult(lines.join('\n'));
      }),
  );
}
