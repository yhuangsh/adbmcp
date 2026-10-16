# adbmcp — Android Debug Bridge, as MCP tools

[![CI](https://github.com/yhuangsh/adbmcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yhuangsh/adbmcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@yhuangsh/adbmcp)](https://www.npmjs.com/package/@yhuangsh/adbmcp)
[![license](https://img.shields.io/npm/l/@yhuangsh/adbmcp)](./LICENSE)

`adbmcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Android Debug Bridge (`adb`) to AI agents: list devices, run shell commands, install apps, read
logcat, take screenshots, drive the UI (tap/swipe/type/key events), query system services with
`dumpsys`, transfer files, forward ports, manage app permissions and pair/connect to devices over
Wi-Fi. It is a thin, predictable wrapper around the official
`adb` binary — no re-implemented adb protocol, no test framework, no extra state.

- **Multi-device first** — every device-scoped tool takes an optional `device` serial and every adb
  call is scoped with `adb -s <serial>`; ambiguity is an error listing the candidates.
- **Failures an agent can act on** — adb stderr/exit codes are mapped to typed causes
  (`NO_DEVICE`, `MULTIPLE_DEVICES`, `DEVICE_UNAUTHORIZED`, `DEVICE_OFFLINE`, `ADB_SERVER_CONFLICT`,
  `TIMEOUT`, `COMMAND_FAILED`) with a hint for the next step.
- **Safety by construction** — full MCP annotations on every tool plus server-side guardrails that
  are enforced even if a host ignores annotations.
- **stdio transport** — the client launches `adbmcp` as a subprocess, the normal MCP deployment.

Implements the MVP plus v2.0 items 1–6 in [`docs/design/product-design-v0.md`](docs/design/product-design-v0.md).

## Install

Requires Node.js >= 20 and Android platform-tools (`adb`) on `PATH` — or `ADB_PATH` pointing at the
binary.

```bash
# from npm
npx -y @yhuangsh/adbmcp

# from a checkout
git clone https://github.com/yhuangsh/adbmcp.git && cd adbmcp
npm install
npm run build
node dist/index.js        # speaks MCP on stdin/stdout
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "adb": {
      "command": "npx",
      "args": ["-y", "adbmcp"],
      "env": {
        "ADB_PATH": "/Users/me/Library/Android/sdk/platform-tools/adb"
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "adb": {
      "command": "node",
      "args": ["/absolute/path/to/adbmcp/dist/index.js"],
      "env": {
        "ADBMCP_ALLOWED_DEVICES": "emulator-5554"
      }
    }
  }
}
```

Other clients work the same way: a `command` plus `args`, with `ADB_PATH` / `ADBMCP_*` environment
variables passed through. Diagnostics are written to **stderr**; stdout carries MCP traffic only.

## Tools

`device` is optional on every device-scoped tool and required when more than one device is connected.
Annotation columns: **RO** = `readOnlyHint`, **D** = `destructiveHint`, **I** = `idempotentHint`,
**O** = `openWorldHint`.

| Tool | What it does | RO | D | I | O |
| --- | --- | --- | --- | --- | --- |
| `list_devices` | `adb devices -l`: serial, state, model, allowlist status | ✅ | — | ✅ | — |
| `get_device_info` | Curated build properties (model, Android version, SDK, ABI) + screen size/density | ✅ | — | ✅ | — |
| `dumpsys_query` | Curated `dumpsys` dump — battery/activity/window/connectivity, capped at 64 KB | ✅ | — | ✅ | — |
| `shell` | Arbitrary `adb shell` command — the power-user escape hatch, guardrailed | — | — | — | ✅ |
| `list_packages` | `pm list packages`, optional substring filter | ✅ | — | ✅ | — |
| `install_apk` | `adb install` a host APK, `replace` for `-r` | — | — | — | — |
| `uninstall_package` | `adb uninstall` — **destructive**, `keep_data` for `-k` | — | ✅ | ✅ | — |
| `grant_permission` | `pm grant` — **destructive**: grants a runtime permission | — | ✅ | ✅ | — |
| `revoke_permission` | `pm revoke` — **destructive**: the app loses the permission | — | ✅ | ✅ | — |
| `clear_app_data` | `pm clear` — **destructive**, refused unless the package is in `ADBMCP_CLEAR_ALLOWED_PACKAGES` | — | ✅ | ✅ | — |
| `logcat_snapshot` | Bounded `adb logcat -d`, optionally filtered | ✅ | — | ✅ | — |
| `start_logcat_stream` | Start a long-lived `adb logcat`, returns a `stream_id` | ✅ | — | — | — |
| `read_logcat_stream` | Drain buffered output since the last read | ✅ | — | — | — |
| `stop_logcat_stream` | Stop the stream, return unread output | ✅ | — | ✅ | — |
| `screenshot` | `exec-out screencap -p`, returned as PNG image content | ✅ | — | ✅ | — |
| `pull_file` | `adb pull` to the host; refuses to overwrite unless `overwrite: true` | — | — | — | — |
| `push_file` | `adb push`; remote path restricted to allowed roots | — | — | — | ✅ |
| `forward_port` | `adb forward` (e.g. `tcp:8080` → `tcp:8080`) | — | — | ✅ | — |
| `remove_forward` | `adb forward --remove` | — | — | ✅ | — |
| `reverse_port` | `adb reverse` — the device listens on `remote` and forwards to host `local` | — | — | ✅ | — |
| `remove_reverse` | `adb reverse --remove` (takes the `remote` spec) | — | — | ✅ | — |
| `list_forwards` | `adb forward --list` as JSON `{serial, local, remote}` | ✅ | — | ✅ | — |
| `list_reverses` | `adb reverse --list` as JSON `{serial, remote, local}` | ✅ | — | ✅ | — |
| `connect` | `adb connect host:port` — TCP/IP wireless without pairing | — | — | ✅ | ✅ |
| `disconnect` | `adb disconnect [host:port]`; no address disconnects every TCP/IP device | — | — | ✅ | ✅ |
| `wireless_pair` | `adb pair host:pair_port code` — Android 11+ pairing, step one of connect | — | — | ✅ | ✅ |
| `start_activity` | `am start` by component or action, `wait` for `-W` | — | — | — | — |
| `force_stop_app` | `am force-stop` | — | — | ✅ | — |
| `get_ui_hierarchy` | `uiautomator dump` XML with bounds/ids/text | ✅ | — | ✅ | — |
| `tap` | `input tap x y` — tap a screen coordinate (device pixels) | — | — | — | — |
| `swipe` | `input swipe x1 y1 x2 y2 [duration_ms]` — scroll or drag | — | — | — | — |
| `type_text` | `input text` with `%s` space encoding and device-shell quoting | — | — | — | — |
| `key_event` | `input keyevent` — named key (HOME, BACK, …) or keycode 0–300 | — | — | — | — |
| `adb_server_restart` | `kill-server` + `start-server` recovery for version conflicts | — | — | — | — |

Also shipped:

- **Resource** `adb://devices` — live device list as JSON (`serial`, `state`, `model`, `allowed`).
  State is never cached; re-read the resource to refresh.
- **Prompts** — `debug_crash`, `install_and_launch`, `capture_bug_report`: step-by-step orchestrations
  of the tools above.

`uninstall_package`, `grant_permission`, `revoke_permission` and `clear_app_data` are the tools with
`destructiveHint: true`; `shell`, `push_file`, `connect`, `disconnect` and `wireless_pair` are the
`openWorldHint: true` tools. They are never merged with read-only tools, so hosts can auto-approve
reads and confirm writes.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADB_PATH` | `adb` (from `PATH`) | Path to the adb binary. Must match the version of any running adb server. |
| `ADBMCP_ALLOWED_DEVICES` | unset (all allowed) | Comma-separated serial allowlist. Operations on other serials are refused. |
| `ADBMCP_SHELL_BLOCKED_PATTERNS` | `reboot`, `su`, `rm -rf /`, `mkfs`, `wipe` | Comma-separated JavaScript regex sources tested against the whole `shell` command. Overriding **replaces** the defaults. |
| `ADBMCP_SHELL_ALLOWED_PREFIXES` | unset (no prefix restriction) | When set, a `shell` command must start with one of these comma-separated prefixes. |
| `ADBMCP_PUSH_ALLOWED_ROOTS` | `/sdcard`, `/storage/emulated/0`, `/data/local/tmp` | Remote roots `push_file` may write to. |
| `ADBMCP_CLEAR_ALLOWED_PACKAGES` | unset (refuse every clear) | Comma-separated package allowlist for `clear_app_data`. There is no allow-all mode: unset or empty refuses every clear. |
| `ADBMCP_TIMEOUT_MS` | `30000` | Default subprocess timeout (`timeout_ms` per call overrides it). |
| `ADBMCP_MAX_OUTPUT_BYTES` | `65536` | Head+tail byte cap per call; the dropped middle is reported inline. |
| `ADBMCP_LOGCAT_BUFFER_BYTES` | `1048576` | Ring-buffer cap per logcat stream; overflow is reported as `dropped_bytes`. |

## Safety notes

- **Annotations are advisory, guardrails are authoritative.** The host decides what to auto-approve;
  `adbmcp` enforces its own limits regardless: blocked `shell` patterns, the device allowlist, remote
  push roots, and the pull overwrite check.
- **`shell` is arbitrary code execution on the device.** It is annotated as not read-only and
  open-world, blocklisted by default, and documented as the escape hatch — keep `shell` disabled or
  prefix-restricted (`ADBMCP_SHELL_ALLOWED_PREFIXES`) on shared or CI machines.
- **`uninstall_package` deletes app data** unless `keep_data: true`. **`clear_app_data` deletes app
  data permanently** and is refused unless the package is listed in `ADBMCP_CLEAR_ALLOWED_PACKAGES`
  (unset/empty refuses every clear). **`grant_permission` / `revoke_permission`** change an app's
  granted permissions. All four are marked `destructiveHint: true`.
- **Device scoping is explicit.** With multiple devices connected, calls without `device` fail with
  `MULTIPLE_DEVICES` and the candidate serials instead of guessing.
- **Filesystem writes are bounded.** `pull_file` never overwrites silently; `push_file` refuses
  writes outside the allowed remote roots and rejects `..` traversal and relative paths. Root
  containment is lexical: it does not resolve on-device symlinks, so a link pre-created inside an
  allowed root (e.g. `/data/local/tmp/x -> /data/system`) can still redirect a push outside it.
- **No privilege escalation.** `adbmcp` never runs `adb root`/`su` itself and never retries a
  permission failure with elevation.
- **The adb server is shared host state.** `adbmcp` never kills or restarts it implicitly;
  `adb_server_restart` exists for the version-conflict case and says so in its description.
- **Logcat streams are cleaned up.** Streams are killed on `stop_logcat_stream`, and all remaining
  streams are terminated on SIGINT/SIGTERM (server shutdown).

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest, no adb binary or device required
npm run typecheck
```

Tests drive a fake adb runner and a fake stream spawner, so the whole suite runs without
platform-tools, a device or an emulator. Layout:

```
src/
  index.ts            stdio entrypoint (transport, signals)
  server.ts           assembles config + runner + tools/resources/prompts
  config.ts           env config, shell/device/push/clear guardrails
  devices.ts          device parsing, resolution rule, list_devices tool
  adb/runner.ts       subprocess per call: -s scoping, timeouts, head+tail caps
  adb/errors.ts       typed causes mapped from adb stderr/exit codes
  streams/registry.ts long-running logcat handles + ring buffer
  tools/              one module per tool group (34 tools, MVP + v2.0 items 1–6)
  resources/devices.ts, prompts/index.ts
test/                 vitest suites (fakes in test/helpers/)
```

## Status

Implements the MVP plus v2.0 items 1–6 from the design (§4.2): reverse port forwards and structured
forward/reverse listings, `pm grant`/`revoke` plus allowlist-gated `clear_app_data`, wireless
TCP/IP `connect`/`disconnect`/`wireless_pair`, first-class input injection (`tap`, `swipe`,
`type_text`, `key_event` — typed schemas that fix the `input text` quoting footgun, no DSL), and the
curated `dumpsys_query`. Not implemented: `screenrecord`, `bugreport`, Streamable HTTP transport,
iOS, emulator lifecycle management. Windows is best-effort (POSIX-first, like most of the
ecosystem).
