import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { GuardrailError, isRemotePathAllowed } from '../config.js';
import type { ServerContext } from '../context.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

export function registerFileTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'pull_file',
    {
      title: 'Pull a file from the device',
      description:
        'Copy a file from the device to the host machine (`adb pull`). Refuses to overwrite an existing host file unless overwrite is true. This writes to the host filesystem, so it is not a read-only tool.',
      inputSchema: {
        remote_path: z.string().min(1).describe('Absolute path on the device, e.g. "/sdcard/Download/crash.log".'),
        local_path: z.string().min(1).describe('Destination path on the host machine (relative paths resolve against the server cwd).'),
        overwrite: z.boolean().optional().describe('Allow replacing an existing host file (default false).'),
        device: DEVICE_ARG,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const serial = await ctx.devices.resolve(args.device);
        const target = resolve(args.local_path);
        if (existsSync(target)) {
          const stats = statSync(target);
          if (stats.isFile() && !args.overwrite) {
            throw new GuardrailError(
              'pull.overwrite',
              `Host file "${target}" already exists. Pass overwrite: true to replace it, or choose another local_path.`,
            );
          }
        } else {
          mkdirSync(dirname(target), { recursive: true });
        }
        const result = await ctx.runner.runChecked(['pull', args.remote_path, target], {
          serial,
          operation: 'pull_file',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const summary = result.stdout.trim() || `Pulled ${args.remote_path}.`;
        return textResult(`${summary}\nlocal_path: ${target}`);
      }),
  );

  server.registerTool(
    'push_file',
    {
      title: 'Push a file to the device',
      description:
        'Copy a file from the host machine to the device (`adb push`). For safety the remote path must be inside the configured allowed roots (default /sdcard, /storage/emulated/0, /data/local/tmp).',
      inputSchema: {
        local_path: z.string().min(1).describe('Source path on the host machine (relative paths resolve against the server cwd).'),
        remote_path: z.string().min(1).describe('Destination path on the device, e.g. "/sdcard/Download/app.apk".'),
        device: DEVICE_ARG,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) =>
      await guard(async () => {
        if (!isRemotePathAllowed(args.remote_path, ctx.config.pushAllowedRoots)) {
          throw new GuardrailError(
            'push.remoteRoot',
            `Refusing to push to "${args.remote_path}": the remote path must be an absolute path inside one of the allowed roots (${ctx.config.pushAllowedRoots.join(', ')}). A maintainer can widen this with ADBMCP_PUSH_ALLOWED_ROOTS.`,
          );
        }
        const source = resolve(args.local_path);
        if (!existsSync(source)) {
          throw new Error(`Host file not found: ${source}. adbmcp runs on your machine, so local_path must exist on the host.`);
        }
        const serial = await ctx.devices.resolve(args.device);
        const result = await ctx.runner.runChecked(['push', source, args.remote_path], {
          serial,
          operation: 'push_file',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const summary = result.stdout.trim() || `Pushed ${source}.`;
        return textResult(`${summary}\nlocal_path: ${source}\nremote_path: ${args.remote_path}`);
      }),
  );
}
