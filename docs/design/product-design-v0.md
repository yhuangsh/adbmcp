# Product Design v0 — ADB MCP Server

**Status:** Draft v0 · **Repo:** `adbmcp` · **Audience:** maintainers, early contributors

---

## 1. Vision & Problem Statement

AI coding assistants (Claude, Pi, Cursor, etc.) are increasingly capable of writing Android code, but they are blind to the device: they cannot see whether an app installed, crashed, rendered correctly, or what `logcat` says. Today a human must copy-paste `adb` output into the chat, breaking the agentic loop.

**Vision:** an MCP (Model Context Protocol) server that exposes the Android Debug Bridge (ADB) capability surface as well-designed MCP tools, so any MCP-capable assistant can inspect and control Android devices and emulators end-to-end — list devices, run shell commands, install apps, stream logs, capture the screen, and transfer files — with safe defaults and explicit guardrails for destructive operations.

**Design goals:**
- **Correctness over cleverness** — thin, predictable wrappers over `adb`, not a new automation framework.
- **Safety by construction** — read-only tools auto-approvable; destructive tools clearly annotated and scoped.
- **Multi-device first** — explicit device selection everywhere (`adb -s`), never implicit "whatever is connected."
- **Agent-friendly output** — structured, truncated, and token-lean responses; errors the model can act on.

## 2. Target Users & Key Use Cases

| User | Use case |
|---|---|
| Android app developer (with AI assistant) | "Install the debug APK on my emulator, launch it, and show me any crashes in logcat." Iterative build → install → run → inspect loops driven by the agent. |
| QA engineer / test automation | Scripted device checks: app state via `dumpsys`, permission grants via `pm`, UI hierarchy inspection, screenshot-based verification, log capture attached to bug reports. |
| AI-driven device testing (agentic QA) | An autonomous agent explores an app: screenshot → decide → tap/type via `input` → verify. The MCP server is the actuator. |
| CI / headless environments | Streamable HTTP transport mode where a shared emulator farm is exposed to agents; port forwarding for backend integration tests. |
| Reverse engineering / support | Pull files/databases from a device, inspect packages, grab bug-report artifacts. |

Non-primary but welcome: tinkerers doing wireless debugging setup (`adb pair`, `adb connect`) via an assistant.

## 3. Existing Landscape Summary

The space is active but fragmented; most entries are thin wrappers with weak error handling, no streaming strategy, and inconsistent safety annotation.

1. **srmorete/adb-mcp** (TypeScript, npm `adb-mcp`) — The closest direct competitor. Tools: `adb_devices`, `adb_shell`, `adb_install`, `adb_package_manager`, `adb_activity_manager`, `adb_logcat`, `adb_pull`, `adb_push`, `dump_image`, `inspect_ui`. **Archived** by its author in favor of `mobile-device-mcp`; README notes it was "vibe-coded," limited multi-device handling, no streaming, no annotations strategy. [4]
2. **mobile-next/mobile-mcp** (TypeScript, npm `@mobilenext/mobile-mcp`, ~15.9k weekly downloads) — The heavyweight: cross-platform (iOS + Android, emulators + real devices) UI automation via accessibility snapshots and coordinate taps. Excellent for UI-driving agents, but deliberately abstracts away raw adb power (arbitrary shell, dumpsys, forwards/reverse, file sync at will) and adds operational weight. [5][6]
3. **srmorete/mobile-device-mcp** — Successor to adb-mcp; broader (iOS too), more scalable. Same trade-off: platform abstraction over adb depth. [4]
4. **allaudin/adb-mcp-server** (Python, PyPI `android-adb-mcp`) — Exposes ADB capabilities as tools *and resources*. Small, early-stage (v0.1.1), minimal hardening. [7]
5. **us-all/android-mcp-server** (TypeScript, npm `@us-all/android-mcp`) — Broad feature list: device management, UI automation, logcat, emulator control. Low adoption (~91 weekly downloads), maturity unclear. [8]
6. **hamen/android-mcp** (TypeScript) — Uses `@devicefarmer/adbkit` (a pure-JS adb client) instead of shelling out to the `adb` binary — interesting architecture, but adbkit lags modern adb features (e.g., `adb pair`, newer protocol bits). [9]
7. **JuanCF/scrcpy-mcp** (TypeScript) — Combines adb with scrcpy to give agents vision + control. Focused on screen interaction, not the general adb surface. [10]

**Differentiation gaps we can own:**
- **Depth over breadth**: full adb surface (forward/reverse, wireless pairing, screenrecord, bugreport, dumpsys helpers) rather than UI-automation-only.
- **Safety model**: rigorous `readOnlyHint`/`destructiveHint` annotations, device scoping, destructive-op allowlists — nearly absent across the field.
- **Failure-mode intelligence**: first-class detection/explanation of `unauthorized`, `offline`, adb server version conflicts, "more than one device" — the top real-world adb pain points [11].
- **Streaming done right**: a principled design for logcat/screenrecord as long-running operations (sessions/handles), which no surveyed server handles well.

## 4. Proposed MCP Tool Surface

Naming: snake_case, verb-first, `adb_` prefix avoided except where it aids clarity (tool names ≤ 64 chars [3]). Each tool takes an optional `device` (serial); when omitted and exactly one device is connected, it is used; otherwise the call fails with an actionable error. Read tools: `readOnlyHint: true`, `destructiveHint: false`. Write tools: `readOnlyHint: false`. Irreversible/hard-to-reverse tools: `destructiveHint: true`.

### 4.1 MVP (v1)

| Tool | adb basis | Inputs (key) | Annotations |
|---|---|---|---|
| `list_devices` | `adb devices -l` | — | readOnly |
| `get_device_info` | `adb shell getprop`, `dumpsys` curated subset | `device?` | readOnly |
| `shell` | `adb shell <cmd>` | `command`, `device?`, `timeout_ms?` | destructiveHint: false, readOnlyHint: false, `openWorldHint: true` — documented as the power-user escape hatch |
| `list_packages` | `pm list packages` | `filter?`, `device?` | readOnly |
| `install_apk` | `adb install` | `apk_path`, `replace?`, `device?` | destructiveHint: false (reversible via uninstall) |
| `uninstall_package` | `adb uninstall` | `package`, `keep_data?`, `device?` | **destructive** |
| `logcat_snapshot` | `adb logcat -d` (dump, bounded) | `filter_spec?`, `max_lines?`, `device?` | readOnly |
| `start_logcat_stream` / `stop_logcat_stream` / `read_logcat_stream` | `adb logcat` (long-lived) | `filter_spec?`, `stream_id` | readOnly |
| `screenshot` | `adb exec-out screencap -p` | `device?` → returns image content | readOnly |
| `pull_file` | `adb pull` | `remote_path`, `local_path`, `device?` | readOnlyHint: false (writes host FS), destructiveHint: false |
| `push_file` | `adb push` | `local_path`, `remote_path`, `device?` | destructiveHint: false, openWorld |
| `forward_port` / `remove_forward` | `adb forward` / `--remove` | `local`, `remote`, `device?` | destructiveHint: false |
| `start_activity` | `am start` | `component` or `action`+extras, `device?` | destructiveHint: false |
| `force_stop_app` | `am force-stop` | `package`, `device?` | destructiveHint: false (idempotent) |
| `get_ui_hierarchy` | `uiautomator dump` | `device?` | readOnly |
| `adb_server_restart` | `adb kill-server && adb start-server` | — | destructiveHint: false; documented recovery tool for server conflicts [11] |

Also in MVP: **Prompts** — a small set of prompt templates (`debug_crash`, `install_and_launch`, `capture_bug_report`) that orchestrate the tools above. **Resources** — `adb://devices` (live device list) so clients can subscribe to device state.

### 4.2 Later (v2) — REVISED after oracle pressure-test

**v0.1.1 first (hygiene, outranks all features):** npm publish, GitHub remote, CI matrix (ubuntu/macOS/windows — Windows is currently *unmeasured*, not best-effort), README polish.

**v2.0 cut list, in order:**
1. `reverse_port` / `remove_reverse` / `list_forwards` — mirror-symmetry with forwards; existing PORT_SPEC validation — **shipped (v0.2.0)**
2. `grant_permission` / `revoke_permission` (`destructiveHint: true`) / `clear_app_data` (allowlist-gated) — **shipped (v0.2.0)**
3. `connect` / `disconnect` — TCP/IP wireless without pairing; most "wireless debugging" asks are just this — **shipped (v0.2.0)**
4. `tap` / `swipe` / `type_text` / `key_event` — minimal first-class input injection (typed schemas fix the `input text` quoting footgun; no DSL per §7) — **shipped (v0.3.0)**
5. `dumpsys_query` — curated: battery, activity, window, connectivity — **shipped (v0.3.0)**
6. `wireless_pair` — pairing `code` as a **required argument** (the chat is the elicitation channel); MCP elicitation only as later progressive enhancement — **shipped (v0.3.0)**

**Explicitly out of v2.0:** Streamable HTTP transport (speculative multi-tenant infra; additive later), `screenrecord` (needs a job lifecycle, not the stream registry), `bugreport` (10–50 MB artifact agents can't consume), emulator management (different binary/lifecycle/trust surface — separate server when farm demand is real), resource subscriptions/notifications.

**Governing risk:** the roadmap must be re-ranked by validated demand after publishing, not adb-surface completeness.

## 5. High-Level Architecture

```
MCP client (Claude/Cursor/Pi)
        │  stdio (default) or Streamable HTTP (optional)
        ▼
┌──────────────────────────────┐
│  adbmcp server (TypeScript)  │
│  ┌────────────────────────┐  │
│  │ Tool layer: schemas,   │  │
│  │ annotations, output    │  │
│  │ shaping, error mapping │  │
│  └─────────┬──────────────┘  │
│  ┌─────────▼──────────────┐  │
│  │ AdbRunner: subprocess  │  │
│  │ mgmt, timeouts, output │  │
│  │ caps, stream registry  │  │
│  └─────────┬──────────────┘  │
└────────────┼─────────────────┘
             ▼
      adb binary (platform-tools on PATH or ADB_PATH)
             ▼
      devices / emulators (USB, TCP/IP, paired)
```

- **Language/SDK:** **TypeScript** with the official `@modelcontextprotocol/sdk` [12][13] (**decided**). Rationale: the dominant MCP client ecosystem (Claude Desktop, Cursor, VS Code) is Node-native; distribution via `npx` is the norm for MCP servers; the TS SDK is the reference implementation.
- **Transport:** **stdio as the default and only MVP transport** (client launches the server as a subprocess — matches how MCP servers are normally deployed [1]). **Streamable HTTP** as a v2 option for shared/remote emulator-farm scenarios [1][15]. Plain SSE is deprecated in favor of Streamable HTTP; do not implement it.
- **adb invocation:** shell out to the `adb` binary (resolved via `ADB_PATH` env → `PATH`), one short-lived subprocess per call with configurable timeouts and output truncation (head+tail with byte caps). We deliberately do **not** use adbkit-style pure-JS protocol clients [9]: tracking the real binary guarantees feature parity (wireless pairing, new device states) and avoids protocol drift.
- **Multi-device handling:** every tool accepts `device?: string` (serial, from `list_devices`); resolution rule: explicit serial → single connected device → error `"more than one device/emulator"` with the candidate list echoed back. Device state is refreshed per call (no stale cache); an `adb://devices` resource gives clients a live view.
- **Long-running operations:** logcat streaming and (v2) screenrecord use a **stream registry**: `start_*` spawns the process, returns a `stream_id`; `read_*` returns buffered output since last read (bounded ring buffer); `stop_*` terminates and cleans up. All streams are killed on server shutdown. This avoids holding an MCP request open indefinitely, which stdio clients handle poorly.
- **Error handling:** adb stderr/exit codes mapped to typed, actionable errors via MCP `isError: true` results [3] with distinct machine-readable causes: `DEVICE_UNAUTHORIZED`, `DEVICE_OFFLINE`, `NO_DEVICE`, `MULTIPLE_DEVICES`, `ADB_SERVER_CONFLICT` (version mismatch → suggest `adb_server_restart`) [11], `TIMEOUT`, `COMMAND_FAILED` (with stderr excerpt).

## 6. Safety & Permissioning

- **Annotations as the primary contract:** every tool carries `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and a human `title` — hosts use these for auto-approve vs. confirm UX [3][16]. Read-only and write tools are never merged into one tool [3].
- **Destructive tier** (`destructiveHint: true`): `uninstall_package`, `clear_app_data`, `revoke_permission` (v2), plus anything matching a configurable **denylist/allowlist** in `shell`.
- **`shell` guardrails:** `shell` is marked non-read-only and open-world, with an optional config `shell.allowedPrefixes` / `shell.blockedPatterns` (e.g., default-block `reboot`, `rm -rf /`, `su`) so teams can harden it without forking.
- **Device scoping:** optional config `allowedDevices: [serials]`; operations on non-listed serials are refused. This is the key control for shared/CI environments.
- **Confirmation strategy:** rely on host annotation-driven confirmation for v1; for interactive flows that need mid-call user input (wireless pairing code), use MCP **elicitation** (spec 2025-06-18+) where the client supports it, degrading to an error message that instructs the user otherwise [2].
- **Filesystem writes:** `pull_file` refuses to overwrite existing host files unless `overwrite: true`; `push_file` refuses writes outside configurable allowed remote roots by default (e.g., `/sdcard/`, `/data/local/tmp/`).
- **No privilege escalation:** the server never attempts `adb root`/`su` automatically; if a command fails with a permission error, it reports it rather than retrying with elevation.

## 7. Non-Goals

- **iOS support** — out of scope (that's mobile-mcp / mobile-device-mcp territory [5][4]).
- **A UI-test framework** — no assertion DSL, test runner, or record/replay. We expose primitives; frameworks can build on top.
- **Replacing scrcpy / screen mirroring** — screenshots and (v2) screenrecord only; no interactive video mirroring [10].
- **Managing the Android SDK / emulator lifecycle in v1** — no AVD creation, system-image download, or SDK installation.
- **An adb protocol reimplementation** — we orchestrate the official binary; we do not speak the adb wire protocol ourselves.
- **GUI / human-facing dashboard** — MCP clients are the UI.

## 8. Key Risks & Open Questions

1. **SDK/language choice (DECIDED):** **TypeScript** with the official `@modelcontextprotocol/sdk` — chosen for client-ecosystem fit (Claude Desktop, Cursor, VS Code are Node-native) and `npx` distribution. Python is dropped. *Recorded by maintainer decision.*
2. **Streaming UX variance (risk):** stream-registry polling works everywhere but is clunky; MCP **sampling/notifications** support varies across clients. *Open question: do any target clients consume progress notifications for long reads?*
3. **adb server lifecycle contention (risk):** the shared adb server is global state on the host — Android Studio and our server can fight over it (version mismatches, `kill-server` side effects) [11]. Mitigation: never auto-restart; make `adb_server_restart` explicit.
4. **Annotation semantics still evolving (risk):** the annotation vocabulary is under active SEP discussion; hosts apply hints inconsistently [16]. Treat annotations as advisory, keep server-side guardrails authoritative.
5. **Security surface of `shell` (risk):** arbitrary command execution is the product's power and its biggest liability. *Open question: ship `shell` in MVP with guardrails, or defer?*
6. **Spec version targeting (open):** the spec moves fast (2025-03-26 → 2025-06-18 → 2025-11-25 → 2026-07-28 [15]); pin to the current stable spec supported by the chosen SDK release line, and track SDK v1→v2 migration [13].
7. **Windows support (risk — MEASURED, resolved):** path handling, subprocess spawning, and signal semantics differ; most existing servers are POSIX-first [4]. CI matrix (ubuntu/macos/windows × node 20/22) passes on all platforms since v0.2.1; the only POSIX-only test construct (shebang fake-adb script) is win32-skipped with cross-platform coverage retained.

## 9. Sources

1. MCP Specification — Transports (2025-06-18): stdio + Streamable HTTP. https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
2. MCP Specification — Elicitation (2025-06-18). https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
3. Anthropic claude-plugins-official — MCP tool design reference (annotations, read/write separation, ≤64-char names). https://github.com/anthropics/claude-plugins-official/blob/main/plugins/mcp-server-dev/skills/build-mcp-server/references/tool-design.md
4. srmorete/adb-mcp (archived; successor mobile-device-mcp). https://github.com/srmorete/adb-mcp
5. mobile-next/mobile-mcp. https://github.com/mobile-next/mobile-mcp/ and https://www.npmjs.com/package/@mobilenext/mobile-mcp
6. Mobile Next docs — quick start. https://mobilenext.ai/docs/mobile-mcp/quick-start
7. android-adb-mcp (PyPI). https://pypi.org/project/android-adb-mcp/
8. @us-all/android-mcp (npm). https://www.npmjs.com/package/@us-all/android-mcp
9. hamen/android-mcp (adbkit-based). https://github.com/hamen/android-mcp
10. scrcpy-mcp (npm). https://www.npmjs.com/package/scrcpy-mcp
11. adb documentation & failure modes — Android Developers adb guide; ADB Wi-Fi architecture; common `unauthorized`/`offline` troubleshooting. https://developer.android.com/tools/adb · https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/docs/dev/adb_wifi.md · https://stackoverflow.com/questions/26079838/
12. MCP TypeScript SDK — server guide. https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
13. MCP TypeScript SDK repo (v2 stable line, latest spec). https://github.com/modelcontextprotocol/typescript-sdk
14. MCP Python SDK. https://py.sdk.modelcontextprotocol.io/
15. MCP specification versioning (current revision 2026-07-28; prior 2025-11-25, 2025-06-18). https://modelcontextprotocol.io/specification/versioning · https://modelcontextprotocol.io/specification/2025-06-18/changelog
16. MCP Blog — Tool Annotations as Risk Vocabulary (Mar 2026). https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/
