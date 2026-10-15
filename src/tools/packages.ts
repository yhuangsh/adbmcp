import { existsSync } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AdbError } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { capText, guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

/** Turn a `pm`/`install`/`uninstall` failure output into a typed error. */
function packageCommandError(operation: string, output: string, exitCode: number, hint: string): AdbError {
  const excerpt = output.trim().split('\n').slice(0, 5).join('\n');
  return new AdbError({
    cause: 'COMMAND_FAILED',
    message: `${operation} failed (exit ${exitCode})${excerpt ? `: ${excerpt}` : ''}`,
    hint,
  });
}

export function registerPackageTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'list_packages',
    {
      title: 'List installed packages',
      description:
        'List package names installed on one device (optionally filtered by a substring of the package name), e.g. filter "com.example" to find only the app you care about.',
      inputSchema: {
        filter: z.string().optional().describe('Substring filter passed to `pm list packages`, e.g. "example" or "com.android.chrome".'),
        device: DEVICE_ARG,
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
        const command = ['pm', 'list', 'packages'];
        if (args.filter) command.push(args.filter);
        const result = await ctx.runner.runChecked(['shell', command.map(quoteForDeviceShell).join(' ')], {
          serial,
          operation: 'list_packages',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const packages = result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith('package:'))
          .map((line) => line.slice('package:'.length));
        if (packages.length === 0) {
          return textResult(
            args.filter
              ? `No package on ${serial} matches filter "${args.filter}".`
              : `No packages reported by ${serial} (unexpected: check device state with list_devices).`,
          );
        }
        return textResult(
          capText([...packages, `# ${packages.length} package(s)${args.filter ? ` matching "${args.filter}"` : ''}`].join('\n'), ctx.config.limits.maxOutputBytes),
        );
      }),
  );

  server.registerTool(
    'install_apk',
    {
      title: 'Install an APK',
      description:
        'Install a local APK on one device via `adb install`. Fails with INSTALL_FAILED_* details from the device when the package cannot be installed.',
      inputSchema: {
        apk_path: z.string().min(1).describe('Path to the APK on the host machine (not on the device).'),
        replace: z.boolean().optional().describe('Pass -r to replace an already installed package (default false).'),
        device: DEVICE_ARG,
        timeout_ms: z.number().int().positive().optional().describe('Install timeout in milliseconds (default 120000; large APKs are slow).'),
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
        if (!existsSync(args.apk_path)) {
          throw new Error(
            `APK not found on the host: ${args.apk_path}. adbmcp runs on your machine, so apk_path must be a host path (build the APK first, or pull it with pull_file).`,
          );
        }
        const serial = await ctx.devices.resolve(args.device);
        const argv = ['install'];
        if (args.replace) argv.push('-r');
        argv.push(args.apk_path);
        const result = await ctx.runner.run(argv, {
          serial,
          operation: 'install_apk',
          timeoutMs: args.timeout_ms ?? 120_000,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || /^\s*Failure\b/m.test(result.stdout)) {
          throw packageCommandError(
            `adb install ${args.apk_path} on ${serial}`,
            output,
            result.exitCode,
            'INSTALL_FAILED_* codes come from the device: check the APK signature, min/target SDK, free storage, and pass replace: true when the package already exists.',
          );
        }
        return textResult(output.length > 0 ? output : `Installed ${args.apk_path} on ${serial}.`);
      }),
  );

  server.registerTool(
    'uninstall_package',
    {
      title: 'Uninstall a package',
      description:
        'Remove an application from one device via `adb uninstall`. Destructive: the app is deleted from the device (use keep_data to keep its data directory).',
      inputSchema: {
        package: z.string().min(1).describe('Package name to uninstall, e.g. "com.example.app".'),
        keep_data: z.boolean().optional().describe('Pass -k to keep the app data and cache directories (default false).'),
        device: DEVICE_ARG,
        timeout_ms: z.number().int().positive().optional().describe('Uninstall timeout in milliseconds (default 60000).'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) =>
      await guard(async () => {
        const serial = await ctx.devices.resolve(args.device);
        const argv = ['uninstall'];
        if (args.keep_data) argv.push('-k');
        argv.push(args.package);
        const result = await ctx.runner.run(argv, {
          serial,
          operation: 'uninstall_package',
          timeoutMs: args.timeout_ms ?? 60_000,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || /^\s*Failure\b/m.test(result.stdout)) {
          throw packageCommandError(
            `adb uninstall ${args.package} on ${serial}`,
            output,
            result.exitCode,
            'A common cause is that the package is not installed for the current user; verify the name with list_packages.',
          );
        }
        return textResult(output.length > 0 ? output : `Uninstalled ${args.package} from ${serial}.`);
      }),
  );
}
