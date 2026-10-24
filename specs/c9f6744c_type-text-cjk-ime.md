# Fix issue #3: `type_text` non-ASCII (CJK) input via the ADB_INPUT_B64 IME broadcast

## Goal

`type_text` currently shells out to Android's `input text`, which is ASCII-only and dies with a
`NullPointerException` on CJK text. Implement the reporter's option 1: when the text contains
non-ASCII characters and a broadcast-capable IME (AdbIME, `com.android.adbkeyboard/.AdbIME`) is the
active IME, type via `am broadcast -a ADB_INPUT_B64 --es msg <base64>`. When no capable IME is
active, fail with a typed `IME_UNAVAILABLE` cause instead of leaking the NPE. Option 2 (fail with
`TEXT_NOT_ASCII`) is kept as an explicit opt-out config mode for operators who don't want the IME
dependency.

Done means:
- `type_text` types CJK via the `ADB_INPUT_B64` broadcast when a capable IME is active.
- Non-ASCII without a capable IME → typed `[IME_UNAVAILABLE]` error with an actionable hint.
- Opt-out mode (`ADBMCP_TYPE_TEXT_NON_ASCII=reject`) → typed `[TEXT_NOT_ASCII]` error, no device call.
- ASCII text keeps the exact current `input text` behavior (one round trip, no IME query).
- README documents the behavior, the AdbIME setup, and the new env vars.
- Full vitest suite green (`npm test`), `npm run typecheck` green.

Out of scope: clipboard/paste tools, IME installation or IME-switching flows (we only *detect* the
active IME), changes to other tool groups.

## Files to touch

1. `src/adb/errors.ts` — two new typed causes + constructors.
2. `src/config.ts` — new `input` config section with two env knobs.
3. `src/tools/input.ts` — the `type_text` dispatch logic.
4. `test/config.test.ts` — parsing tests for the new knobs.
5. `test/server.test.ts` — behavior tests for the new `type_text` paths (extend near the existing
   `type_text` tests around line 1234; all tool tests live in this file, do not create a new file).
6. `README.md` — tool-table row, a "Non-ASCII / CJK text input" subsection, env-var table rows.

No changes to `test/helpers/fakes.ts` are needed — the existing `devicesHandler(listing, extra)`
handler and `FakeAdbRunner` already let us answer the IME-detection shell call and assert on
recorded commands.

## Detailed changes

### 1. `src/adb/errors.ts`

Extend `AdbErrorCause` with two members:

```ts
export type AdbErrorCause =
  | 'DEVICE_UNAUTHORIZED'
  | ... (existing members unchanged)
  | 'COMMAND_FAILED'
  | 'IME_UNAVAILABLE'
  | 'TEXT_NOT_ASCII';
```

Add two constructors next to the others (same style: message + actionable `hint`):

```ts
export function imeUnavailableError(activeIme: string | null): AdbError {
  const current = activeIme ? `The active IME is "${activeIme}".` : 'No IME is currently selected.';
  return new AdbError({
    cause: 'IME_UNAVAILABLE',
    message: `type_text cannot type non-ASCII text: no broadcast-capable IME is active. ${current}`,
    hint: 'Install ADB Keyboard (com.android.adbkeyboard), enable it and select it as the active input method ("adb shell ime set com.android.adbkeyboard/.AdbIME"), then retry. adbmcp sends non-ASCII text via the ADB_INPUT_B64 broadcast that AdbIME receives.',
  });
}

export function textNotAsciiError(): AdbError {
  return new AdbError({
    cause: 'TEXT_NOT_ASCII',
    message: 'type_text received non-ASCII text but ADBMCP_TYPE_TEXT_NON_ASCII=reject disables the IME broadcast path; "input text" is ASCII-only.',
    hint: 'Type ASCII only, or unset ADBMCP_TYPE_TEXT_NON_ASCII (default "ime") and make AdbIME (com.android.adbkeyboard/.AdbIME) the active IME so the ADB_INPUT_B64 broadcast path can type any script.',
  });
}
```

No changes to `mapAdbFailure` — these are thrown directly by the tool, and the existing
`guard`/`errorResult` plumbing already renders `AdbError` via `toToolText()` as `[CAUSE] message\nHint: ...`.

### 2. `src/config.ts`

Add an `input` section to `AdbmcpConfig`:

```ts
export type NonAsciiMode = 'ime' | 'reject';

export interface AdbmcpConfig {
  // ... existing members ...
  input: {
    /**
     * How type_text handles non-ASCII text (ADBMCP_TYPE_TEXT_NON_ASCII):
     * 'ime' (default) sends the ADB_INPUT_B64 broadcast when a capable IME is
     * active; 'reject' fails with TEXT_NOT_ASCII (issue #3 option 2).
     */
    nonAscii: NonAsciiMode;
    /**
     * Component ids of IMEs that accept the ADB_INPUT_B64 broadcast
     * (ADBMCP_IME_BROADCAST_COMPONENTS, comma-separated).
     */
    imeBroadcastComponents: string[];
  };
}
```

Defaults:

```ts
export const DEFAULT_IME_BROADCAST_COMPONENTS: readonly string[] = ['com.android.adbkeyboard/.AdbIME'];
```

In `loadConfig`, parse:
- `ADBMCP_TYPE_TEXT_NON_ASCII`: trim; unset/empty → `'ime'`; `'ime'`/`'reject'` accepted; anything
  else throws `Error('ADBMCP_TYPE_TEXT_NON_ASCII must be "ime" or "reject", received "...".')`
  (same throw-on-invalid style as `parsePositiveInt`).
- `ADBMCP_IME_BROADCAST_COMPONENTS`: via the existing `parseList`; null (unset) →
  `[...DEFAULT_IME_BROADCAST_COMPONENTS]`. (An explicitly empty value also falls back to defaults,
  consistent with the other list knobs.)

Update `testConfig` compatibility: nothing to change in `test/helpers/fakes.ts` — it spreads
`loadConfig(env)`, so `createHarness({ env: {...} })` picks the knobs up for free.

### 3. `src/tools/input.ts`

Constants and helpers (module scope, above `registerInputTools`):

```ts
/** Android's `input text` is ASCII-only (issue #3); anything else needs the IME broadcast path. */
const ASCII_ONLY = /^[\x00-\x7F]*$/;

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

function isBroadcastCapableIme(activeIme: string | null, capable: readonly string[]): boolean {
  if (!activeIme) return false;
  const flattened = flattenComponentId(activeIme);
  return capable.some((candidate) => flattenComponentId(candidate) === flattened);
}
```

`type_text` handler becomes:

```ts
async (args) =>
  await guard(async () => {
    const serial = await ctx.devices.resolve(args.device);
    const runOptions = {
      serial,
      operation: 'type_text',
      timeoutMs: ctx.config.limits.defaultTimeoutMs,
      maxBytes: ctx.config.limits.maxOutputBytes,
    };

    // ASCII fast path: unchanged `input text`, single round trip.
    if (ASCII_ONLY.test(args.text)) {
      const command = `input text ${quoteForDeviceShell(encodeInputText(args.text))}`;
      await ctx.runner.runChecked(['shell', command], runOptions);
      return textResult(`Typed text into the focused field on ${serial}.`);
    }

    if (ctx.config.input.nonAscii === 'reject') {
      throw textNotAsciiError();
    }

    // IME broadcast path (issue #3 option 1): only works when a broadcast-capable
    // IME is the *active* input method. Query fresh on every call — the user can
    // switch IMEs at any time, so do not cache.
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
      ['shell', `am broadcast -a ${ADB_IME_BROADCAST_ACTION} --es msg ${quoteForDeviceShell(base64)}`],
      runOptions,
    );
    return textResult(`Typed text into the focused field on ${serial} via the ${activeIme} broadcast.`);
  }),
```

Notes:
- Base64 output is `[A-Za-z0-9+/=]`, entirely inside `quoteForDeviceShell`'s SAFE_TOKEN set, so it
  passes through unquoted; keep the `quoteForDeviceShell` call anyway for defense in depth.
- The IME-detection call uses `runChecked`, so a device-side failure surfaces as an existing typed
  cause (`COMMAND_FAILED` etc.) — never a raw NPE.
- Update the `type_text` tool **description** to document the behavior, e.g.: append to the current
  text: "Non-ASCII text (e.g. CJK) cannot go through `input text` (ASCII-only): when a
  broadcast-capable IME is active — ADB Keyboard, `com.android.adbkeyboard/.AdbIME` — it is typed
  via the `ADB_INPUT_B64` broadcast instead. If no capable IME is active the call fails with
  `[IME_UNAVAILABLE]` (install/enable/select AdbIME, then retry); with
  `ADBMCP_TYPE_TEXT_NON_ASCII=reject` non-ASCII text fails with `[TEXT_NOT_ASCII]` instead."
- Imports to add: `imeUnavailableError, textNotAsciiError` from `../adb/errors.js`.
- Do **not** route the internal `settings`/`am broadcast` commands through the `shell` tool's
  guardrail patterns; internal runner calls bypass them by design, same as every other tool.

### 4. Tests — `test/server.test.ts`

Add a `describe` block (or extend the existing input section near line 1234) with these cases. All
use `createHarness({ handler: devicesHandler(ONE_DEVICE_LONG, extra) })` where `extra` answers the
shell commands. The fake records every call, so call indices: `[0]` = `devices -l`, `[1]` = first
shell call.

1. **CJK via broadcast when AdbIME is active.** `extra`: `settings get secure default_input_method`
   → `{ stdout: 'com.android.adbkeyboard/.AdbIME\n' }`. Call `type_text` with `text: '咖啡'`.
   Assert: not an error; `harness.runner.calls[1].args` equals
   `['shell', 'settings get secure default_input_method']`; `calls[2].args` equals
   `['shell', 'am broadcast -a ADB_INPUT_B64 --es msg 5ZKW5ZWh']` (base64 of `咖啡` is `5ZKW5ZWh`,
   unquoted because base64 is in the safe-token set); both scoped to `emulator-5554`; result text
   mentions the broadcast.
2. **Flattened component form accepted.** Active IME reported as
   `com.android.adbkeyboard/com.android.adbkeyboard.AdbIME` → still broadcasts (normalization test).
3. **IME_UNAVAILABLE when a different IME is active.** Active IME
   `com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME` → `isError` true,
   text contains `[IME_UNAVAILABLE]`, the active IME id, and `com.android.adbkeyboard`; no
   `am broadcast` in `harness.runner.commands()`.
4. **IME_UNAVAILABLE when the query returns `null`/empty.** Both `''` and `'null\n'` outputs →
   `[IME_UNAVAILABLE]`.
5. **Custom capable component via env.** `createHarness({ env: { ADBMCP_IME_BROADCAST_COMPONENTS:
   'com.example.ime/.B64IME' }, handler: ... })` with that IME active → broadcast succeeds.
6. **Reject mode (option 2 fallback).** `env: { ADBMCP_TYPE_TEXT_NON_ASCII: 'reject' }`, text `咖啡`
   → `isError` true, `[TEXT_NOT_ASCII]`; runner calls stop after `devices -l` (no shell calls).
7. **ASCII regression.** `type_text` with `'hello world'` → still exactly
   `['shell', 'input text hello%sworld']` at `calls[1]`; **no** `settings` command anywhere in
   `harness.runner.commands()` (proves the fast path doesn't pay the IME round trip). The existing
   quoting test at line 1234 already covers the encoding matrix and must keep passing unchanged.
8. **IME-detection failure is typed.** `extra` returns `{ stdout: '', stderr: 'error: device
   offline', exitCode: 1 }` for the `settings` call → `isError` true, `[DEVICE_OFFLINE]`, no
   broadcast. (Guards the "never leak a raw failure" requirement.)

### 5. Tests — `test/config.test.ts`

Add cases to the `loadConfig` describe:
- Defaults: `loadConfig({}).input` equals `{ nonAscii: 'ime', imeBroadcastComponents:
  ['com.android.adbkeyboard/.AdbIME'] }`.
- `ADBMCP_TYPE_TEXT_NON_ASCII: 'reject'` → `nonAscii === 'reject'`.
- Invalid value (`ADBMCP_TYPE_TEXT_NON_ASCII: 'always'`) → `loadConfig` throws with
  `ADBMCP_TYPE_TEXT_NON_ASCII` in the message.
- `ADBMCP_IME_BROADCAST_COMPONENTS: 'a.b/.Ime, c.d/e.F'` → `['a.b/.Ime', 'c.d/e.F']`.

### 6. `README.md`

- Tool table (line 212): change the `type_text` row to
  `| \`type_text\` | \`input text\` with \`%s\` space encoding and device-shell quoting; non-ASCII (e.g. CJK) goes through the \`ADB_INPUT_B64\` broadcast when a capable IME (ADB Keyboard) is active — see [Non-ASCII text input](#non-ascii-text-input) | — | — | — | — |`.
- Add a `### Non-ASCII text input` subsection (near the tool table / input tools) covering:
  - `input text` is ASCII-only; CJK used to die with an NPE (issue #3).
  - Default `ime` mode: requires ADB Keyboard installed, enabled and **selected** as the active IME;
    setup commands (`ime enable`/`ime set` examples) are documented for the reader's own shell use —
    adbmcp deliberately does not install or switch IMEs, it only detects.
  - Failure modes: `[IME_UNAVAILABLE]` (no capable active IME), `[TEXT_NOT_ASCII]` (reject mode).
  - The exact broadcast sent: `am broadcast -a ADB_INPUT_B64 --es msg <base64-utf8>`.
- Env-var table (around line 233): add rows for `ADBMCP_TYPE_TEXT_NON_ASCII` (default `ime`,
  values `ime`/`reject`) and `ADBMCP_IME_BROADCAST_COMPONENTS` (default
  `com.android.adbkeyboard/.AdbIME`, comma-separated component ids; `pkg/.Class` and flattened
  `pkg/pkg.Class` forms both match).

## Verification

1. `npm run typecheck` — clean.
2. `npm test` — full vitest suite green, including all pre-existing tests (no regressions in the
   `type_text` quoting matrix or the tool-surface/annotation tests; the tool list is unchanged).
3. Manual sanity (optional, needs a device/emulator with AdbIME): `type_text` with `咖啡` types the
   characters; with another IME selected it returns `[IME_UNAVAILABLE]`.

## Non-goals / pitfalls

- Do not cache the active IME; it can change between calls.
- Do not add new tools (no clipboard/paste), do not attempt IME install/switch.
- Keep the ASCII path byte-for-byte identical to today (encoding, quoting, single round trip).
- Keep `AdbError` semantics: new causes are constructed directly, `mapAdbFailure` untouched.
