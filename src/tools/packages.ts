import { existsSync } from 'node:fs';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AdbError } from '../adb/errors.js';
import { assertClearPackageAllowed } from '../config.js';
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

/** Failure text `pm grant`/`pm revoke` can print even when adb exits 0. */
const PM_PERMISSION_FAILURE =
  /unknown permission|bad argument|not a debuggable app|operation not allowed|securityexception|error:/i;

/** Turn a `pm grant`/`pm revoke` failure into a typed error with a cause-specific hint. */
function permissionCommandError(operation: string, output: string, exitCode: number): AdbError {
  if (/unknown permission/i.test(output)) {
    return packageCommandError(
      operation,
      output,
      exitCode,
      'The device does not know that permission name. Find the exact name with `pm list permissions` and pass it verbatim, e.g. "android.permission.CAMERA".',
    );
  }
  if (/not a debuggable app/i.test(output)) {
    return packageCommandError(
      operation,
      output,
      exitCode,
      'Only debuggable apps accept pm grant/revoke. Install a debug build (android:debuggable="true", e.g. the debug variant) and retry.',
    );
  }
  if (/bad argument/i.test(output)) {
    return packageCommandError(
      operation,
      output,
      exitCode,
      'The device rejected the arguments. pm grant/revoke expect: pm grant|revoke <package> <permission>; verify the package name with list_packages and the permission spelling.',
    );
  }
  return packageCommandError(
    operation,
    output,
    exitCode,
    'Common causes: the package is not installed (verify with list_packages), the permission is not a changeable runtime permission, or the device restricts pm grant/revoke.',
  );
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

  server.registerTool(
    'grant_permission',
    {
      title: 'Grant a runtime permission',
      description:
        'Grant a runtime permission to an app (`pm grant <package> <permission>`). Destructive: it changes the permissions the app holds; revoke_permission reverses it. Only changeable runtime permissions work, and the target app is normally expected to be debuggable.',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "com.example.app".'),
        permission: z.string().min(1).describe('Permission name, e.g. "android.permission.CAMERA".'),
        device: DEVICE_ARG,
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
        const command = ['pm', 'grant', args.package, args.permission]
          .map(quoteForDeviceShell)
          .join(' ');
        const result = await ctx.runner.run(['shell', command], {
          serial,
          operation: 'grant_permission',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || PM_PERMISSION_FAILURE.test(output)) {
          throw permissionCommandError(
            `pm grant ${args.permission} to ${args.package} on ${serial}`,
            output,
            result.exitCode,
          );
        }
        return textResult(
          output.length > 0 ? output : `Granted ${args.permission} to ${args.package} on ${serial}.`,
        );
      }),
  );

  server.registerTool(
    'revoke_permission',
    {
      title: 'Revoke a runtime permission',
      description:
        'Revoke a runtime permission from an app (`pm revoke <package> <permission>`). Destructive: the app loses the permission immediately and may fail until it is granted again.',
      inputSchema: {
        package: z.string().min(1).describe('Package name, e.g. "com.example.app".'),
        permission: z.string().min(1).describe('Permission name, e.g. "android.permission.CAMERA".'),
        device: DEVICE_ARG,
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
        const command = ['pm', 'revoke', args.package, args.permission]
          .map(quoteForDeviceShell)
          .join(' ');
        const result = await ctx.runner.run(['shell', command], {
          serial,
          operation: 'revoke_permission',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || PM_PERMISSION_FAILURE.test(output)) {
          throw permissionCommandError(
            `pm revoke ${args.permission} from ${args.package} on ${serial}`,
            output,
            result.exitCode,
          );
        }
        return textResult(
          output.length > 0 ? output : `Revoked ${args.permission} from ${args.package} on ${serial}.`,
        );
      }),
  );

  server.registerTool(
    'clear_app_data',
    {
      title: 'Clear app data',
      description:
        'Delete all data stored by an app (`pm clear <package>`). Destructive and allowlist-gated: the server refuses unless the package is listed in ADBMCP_CLEAR_ALLOWED_PACKAGES (comma-separated); an unset or empty value refuses every clear.',
      inputSchema: {
        package: z.string().min(1).describe('Package name to clear, e.g. "com.example.app".'),
        device: DEVICE_ARG,
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
        assertClearPackageAllowed(args.package, ctx.config.clearAllowedPackages);
        const serial = await ctx.devices.resolve(args.device);
        const command = ['pm', 'clear', args.package].map(quoteForDeviceShell).join(' ');
        const result = await ctx.runner.run(['shell', command], {
          serial,
          operation: 'clear_app_data',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.exitCode !== 0 || /^\s*Failed\b|securityexception/im.test(output)) {
          throw packageCommandError(
            `pm clear ${args.package} on ${serial}`,
            output,
            result.exitCode,
            'pm clear prints "Failed" (or a SecurityException) when the package is not installed or the device refuses to clear it; verify the name with list_packages. Some ROMs do not let the shell user clear other apps even when they are allowlisted.',
          );
        }
        return textResult(output.length > 0 ? output : `Cleared data for ${args.package} on ${serial}.`);
      }),
  );
}
