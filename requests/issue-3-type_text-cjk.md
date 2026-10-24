Fix issue #3: `type_text` breaks on non-ASCII (CJK) input — implement the reporter's option 1 (IME broadcast path); option 2 is the fallback only where the IME path genuinely cannot apply.
Where: the input tool group (src/tools/input.ts — verified) and its tests in test/ (vitest against fakes, no device needed); if the fix needs a guardrail/config knob, src/config.ts is where those live.
Done means: type_text handles CJK via the ADB_INPUT_B64 broadcast (com.android.adbkeyboard/.AdbIME) when a capable IME is active; fails with a typed actionable cause (IME_UNAVAILABLE / TEXT_NOT_ASCII, per the issue) instead of leaking the NullPointerException when not; README documents the behavior; the full vitest suite passes green.
Out of scope: new clipboard/paste tools, IME installation or IME-switching flows beyond detecting the active IME, changes to other tool groups.

--- verbatim issue #3 (yhuangsh/adbmcp, opened 2026-10-17) ---

Thanks for adbmcp — it drives an Android app-automation project of mine and holds up well. Third small proposal, this one a correctness bug.

## Problem

`type_text` uses Android's `input text`, which is **ASCII-only**: typing non-ASCII text (e.g. CJK) fails. On the devices I test, `adb shell input text "咖啡"` throws:

```
Exception occurred while executing 'text':
java.lang.NullPointerException: Attempt to get length of null array
```

For Chinese-market apps this blocks the single most common automation step: typing a search query. Consumer-side workaround: an ADB Keyboard IME (`com.android.adbkeyboard/.AdbIME`) and a broadcast — `am broadcast -a ADB_INPUT_B64 --es msg <base64>` — which types any script reliably (AdbIME must be the active IME).

## Proposal

One of, in order of preference:

1. `type_text` gains an IME path: when the text contains non-ASCII and an IME that supports the broadcast (AdbIME) is active, send `ADB_INPUT_B64` instead of `input text`; error with a typed cause when no capable IME is active (e.g. `IME_UNAVAILABLE` as a `COMMAND_FAILED` hint rather than an NPE leak).
2. Keep `type_text` ASCII-only but fail with a typed cause (`TEXT_NOT_ASCII`) and document the limitation plus the recommended AdbIME pattern in the description.

## Alternatives considered

- Raw `input text` with unicode escaping tricks — unreliable across Android versions.
- Clipboard + paste via `key_event 279` — needs clipboard-set access adbmcp doesn't expose.

## Use case

Searching Chinese apps by CJK keywords is *the* core workflow step for my agent-builder (Xiaohongshu search); today it silently can't be expressed through `type_text`.
