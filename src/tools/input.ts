import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { imeUnavailableError, textNotAsciiError } from '../adb/errors.js';
import type { ServerContext } from '../context.js';
import { quoteForDeviceShell } from '../util/shell.js';
import { guard, textResult } from './common.js';

const DEVICE_ARG = z
  .string()
  .optional()
  .describe('Device serial from list_devices; optional when exactly one device is connected.');

/** Common KeyEvent names mapped to their Android keycodes. */
const NAMED_KEYS = {
  HOME: 3,
  BACK: 4,
  ENTER: 66,
  DEL: 67,
  MENU: 82,
  POWER: 26,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  TAB: 61,
  ESCAPE: 111,
  APP_SWITCH: 187,
  WAKEUP: 224,
  SLEEP: 223,
} as const;

type NamedKey = keyof typeof NAMED_KEYS;

const NAMED_KEY_NAMES = Object.keys(NAMED_KEYS) as [NamedKey, ...NamedKey[]];

const KEY_ARG = z
  .union([z.number().int().min(0).max(300), z.enum(NAMED_KEY_NAMES)], {
    // Zod's default union message hides the enum list; make bad names actionable.
    error: `key must be an Android keycode 0-300 or a named key: ${NAMED_KEY_NAMES.join(', ')}.`,
  })
  .describe(`Android keycode 0-300, or a named key: ${NAMED_KEY_NAMES.join(', ')}.`);

function coordinateArg(name: string) {
  return z.number().int().min(0).describe(`${name} in device pixels (non-negative integer).`);
}

/**
 * `input text` treats spaces as argument separators and converts `%s` back to a
 * space on the device, so spaces must be encoded before the token is handed to
 * the device shell. Shell metacharacters (quotes, backticks, `$`, `;`, `&`,
 * `<`, `>`, `\`, `*`, `?`, `~`, …) are neutralized by quoteForDeviceShell,
 * which single-quotes anything outside its safe set.
 */
function encodeInputText(text: string): string {
  return text.replaceAll(' ', '%s');
}

/** Android's `input text` is ASCII-only (issue #3); anything else needs the IME broadcast path. */
const ASCII_ONLY = /^[\x00-\x7F]*$/;

/** Broadcast action ADB Keyboard (com.android.adbkeyboard) types base64 payloads for (issue #3). */
const ADB_IME_BROADCAST_ACTION = 'ADB_INPUT_B64';
const ACTIVE_IME_COMMAND = 'settings get secure default_input_method';

/** Normalize a component id so "pkg/.Class" and "pkg/pkg.Class" compare equal. */
function flattenComponentId(id: string): string {
  const slash = id.indexOf('/');
  if (slash < 0) return id.trim();
  const pkg = id.slice(0, slash).trim();
  let cls = id.slice(slash + 1).trim();
  if (cls.startsWith('.')) cls = `${pkg}${cls}`;
  return `${pkg}/${cls}`;
}

/** True when the active IME is one of the configured broadcast-capable components. */
function isBroadcastCapableIme(activeIme: string | null, capable: readonly string[]): boolean {
  if (!activeIme) return false;
  const flattened = flattenComponentId(activeIme);
  return capable.some((candidate) => flattenComponentId(candidate) === flattened);
}

/**
 * Input injection drives the active UI. The four tools are deliberately not
 * idempotent: every call injects a fresh event, so a repeated tap can register
 * as a double-tap, a swipe scrolls further, and BACK/DEL/ENTER/VOLUME_* key
 * presses accumulate (design §4.2 item 4, §6).
 */
export function registerInputTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    'tap',
    {
      title: 'Tap the screen',
      description:
        'Tap a point on the device screen (`input tap X Y`). Coordinates are device pixels: read them from get_ui_hierarchy bounds or get_device_info screen_size, and screenshot after the tap to verify the result (screenshot → decide → act loop). If the display is off, wake it first with key_event WAKEUP — input events are dropped while the screen is off.',
      inputSchema: {
        x: coordinateArg('X'),
        y: coordinateArg('Y'),
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
        const command = ['input', 'tap', String(args.x), String(args.y)].join(' ');
        await ctx.runner.runChecked(['shell', command], {
          serial,
          operation: 'tap',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(`Tapped (${args.x}, ${args.y}) on ${serial}.`);
      }),
  );

  server.registerTool(
    'swipe',
    {
      title: 'Swipe the screen',
      description:
        'Swipe from (x1, y1) to (x2, y2) (`input swipe X1 Y1 X2 Y2 [duration_ms]`), e.g. to scroll a list or dismiss a card. duration_ms is the gesture time in milliseconds (device default 300 when omitted); a longer duration drags more slowly. Coordinates are device pixels; screenshot afterwards to verify the result.',
      inputSchema: {
        x1: coordinateArg('Start X'),
        y1: coordinateArg('Start Y'),
        x2: coordinateArg('End X'),
        y2: coordinateArg('End Y'),
        duration_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Gesture duration in milliseconds; omit for the device default (300 ms).'),
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
        const durationMs = args.duration_ms;
        const command = ['input', 'swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
        if (durationMs !== undefined) command.push(String(durationMs));
        await ctx.runner.runChecked(['shell', command.join(' ')], {
          serial,
          operation: 'swipe',
          // The adb client must outlive the gesture it is injecting, not just use
          // the default budget.
          timeoutMs: ctx.config.limits.defaultTimeoutMs + (durationMs ?? 0),
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(
          `Swiped (${args.x1}, ${args.y1}) -> (${args.x2}, ${args.y2}) on ${serial}${durationMs !== undefined ? ` over ${durationMs} ms` : ''}.`,
        );
      }),
  );

  server.registerTool(
    'type_text',
    {
      title: 'Type text',
      description:
        'Type text into the focused input field (`input text <text>`). Spaces are encoded as %s (adb\'s space form) and shell metacharacters are quoted, so the text reaches the device intact; note that a literal "%s" in text still becomes a space on the device. Non-ASCII text (e.g. CJK) cannot go through `input text` (ASCII-only): when a broadcast-capable IME is active — ADB Keyboard, `com.android.adbkeyboard/.AdbIME` — it is typed via the `ADB_INPUT_B64` broadcast instead. If no capable IME is active the call fails with `[IME_UNAVAILABLE]` (install/enable/select AdbIME, then retry); with `ADBMCP_TYPE_TEXT_NON_ASCII=reject` non-ASCII text fails with `[TEXT_NOT_ASCII]` instead. Focus the field first (tap it), and screenshot to confirm what was typed.',
      inputSchema: {
        text: z.string().min(1).describe('Text to type, e.g. "hello world" or "user@example.com".'),
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
        const runOptions = {
          serial,
          operation: 'type_text',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        };

        // ASCII fast path: `input text`, single round trip, unchanged behavior.
        if (ASCII_ONLY.test(args.text)) {
          const command = `input text ${quoteForDeviceShell(encodeInputText(args.text))}`;
          await ctx.runner.runChecked(['shell', command], runOptions);
          return textResult(`Typed text into the focused field on ${serial}.`);
        }

        if (ctx.config.input.nonAscii === 'reject') {
          throw textNotAsciiError();
        }

        // IME broadcast path (issue #3 option 1): the broadcast only types when a
        // broadcast-capable IME is the *active* input method. Query fresh on every
        // call — the user can switch IMEs at any time, so do not cache.
        const imeResult = await ctx.runner.runChecked(['shell', ACTIVE_IME_COMMAND], {
          ...runOptions,
          operation: 'type_text (detect active IME)',
        });
        const rawIme = imeResult.stdout.trim();
        const activeIme = rawIme === '' || rawIme === 'null' ? null : rawIme;
        if (!isBroadcastCapableIme(activeIme, ctx.config.input.imeBroadcastComponents)) {
          throw imeUnavailableError(activeIme);
        }

        const base64 = Buffer.from(args.text, 'utf8').toString('base64');
        await ctx.runner.runChecked(
          [
            'shell',
            `am broadcast -a ${ADB_IME_BROADCAST_ACTION} --es msg ${quoteForDeviceShell(base64)}`,
          ],
          runOptions,
        );
        return textResult(
          `Typed text into the focused field on ${serial} via the ${activeIme} broadcast.`,
        );
      }),
  );

  server.registerTool(
    'key_event',
    {
      title: 'Send a key event',
      description:
        'Send one key event to the device (`input keyevent <code>`). Pass a named key (HOME, BACK, ENTER, DEL, MENU, POWER, VOLUME_UP, VOLUME_DOWN, TAB, ESCAPE, APP_SWITCH, WAKEUP, SLEEP) or a raw Android keycode 0-300. Use WAKEUP (or POWER) before driving a screen that may be off, and BACK/HOME to navigate.',
      inputSchema: {
        key: KEY_ARG,
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
        const code = typeof args.key === 'number' ? args.key : NAMED_KEYS[args.key];
        const label = typeof args.key === 'number' ? `keycode ${code}` : `${args.key} (keycode ${code})`;
        await ctx.runner.runChecked(['shell', `input keyevent ${code}`], {
          serial,
          operation: 'key_event',
          timeoutMs: ctx.config.limits.defaultTimeoutMs,
          maxBytes: ctx.config.limits.maxOutputBytes,
        });
        return textResult(`Pressed ${label} on ${serial}.`);
      }),
  );
}
