# adbmcp — Android Debug Bridge, as MCP tools

`adbmcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the
Android Debug Bridge (`adb`) to AI agents: list devices, run shell commands, install apps, read
logcat, take screenshots, transfer files. It is a thin, predictable wrapper around the official
`adb` binary — no re-implemented adb protocol, no test framework, no extra state.

- **Multi-device first** — every device-scoped tool takes an optional `device` serial and every adb
  call is scoped with `adb -s <serial>`; ambiguity is an error listing the candidates.
- **Failures an agent can act on** — adb stderr/exit codes are mapped to typed causes
  (`NO_DEVICE`, `MULTIPLE_DEVICES`, `DEVICE_UNAUTHORIZED`, `DEVICE_OFFLINE`, `ADB_SERVER_CONFLICT`,
  `TIMEOUT`, `COMMAND_FAILED`) with a hint for the next step.
- **Safety by construction** — full MCP annotations on every tool plus server-side guardrails that
  are enforced even if a host ignores annotations.
- **stdio transport** — the client launches `adbmcp` as a subprocess, the normal MCP deployment.

Implements the MVP in [`docs/design/product-design-v0.md`](docs/design/product-design-v0.md).

## Install

Requires Node.js >= 20 and Android platform-tools (`adb`) on `PATH` — or `ADB_PATH` pointing at the
binary.

```bash
# from npm (once published)
npx -y adbmcp

# from a checkout
git clone <repo> && cd adbmcp
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
| `shell` | Arbitrary `adb shell` command — the power-user escape hatch, guardrailed | — | — | — | ✅ |
| `list_packages` | `pm list packages`, optional substring filter | ✅ | — | ✅ | — |
| `install_apk` | `adb install` a host APK, `replace` for `-r` | — | — | — | — |
| `uninstall_package` | `adb uninstall` — **destructive**, `keep_data` for `-k` | — | ✅ | ✅ | — |
| `logcat_snapshot` | Bounded `adb logcat -d`, optionally filtered | ✅ | — | ✅ | — |
| `start_logcat_stream` | Start a long-lived `adb logcat`, returns a `stream_id` | ✅ | — | — | — |
| `read_logcat_stream` | Drain buffered output since the last read | ✅ | — | — | — |
| `stop_logcat_stream` | Stop the stream, return unread output | ✅ | — | ✅ | — |
| `screenshot` | `exec-out screencap -p`, returned as PNG image content | ✅ | — | ✅ | — |
| `pull_file` | `adb pull` to the host; refuses to overwrite unless `overwrite: true` | — | — | — | — |
| `push_file` | `adb push`; remote path restricted to allowed roots | — | — | — | — |
| `forward_port` | `adb forward` (e.g. `tcp:8080` → `tcp:8080`) | — | — | ✅ | — |
| `remove_forward` | `adb forward --remove` | — | — | ✅ | — |
| `start_activity` | `am start` by component or action, `wait` for `-W` | — | — | — | — |
| `force_stop_app` | `am force-stop` | — | — | ✅ | — |
| `get_ui_hierarchy` | `uiautomator dump` XML with bounds/ids/text | ✅ | — | ✅ | — |
| `adb_server_restart` | `kill-server` + `start-server` recovery for version conflicts | — | — | — | — |

Also shipped:

- **Resource** `adb://devices` — live device list as JSON (`serial`, `state`, `model`, `allowed`).
  State is never cached; re-read the resource to refresh.
- **Prompts** — `debug_crash`, `install_and_launch`, `capture_bug_report`: step-by-step orchestrations
  of the tools above.

`uninstall_package` is the only tool with `destructiveHint: true`; `shell` is the only `openWorldHint:
true` tool. They are never merged with read-only tools, so hosts can auto-approve reads and confirm
writes.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADB_PATH` | `adb` (from `PATH`) | Path to the adb binary. Must match the version of any running adb server. |
| `ADBMCP_ALLOWED_DEVICES` | unset (all allowed) | Comma-separated serial allowlist. Operations on other serials are refused. |
| `ADBMCP_SHELL_BLOCKED_PATTERNS` | `reboot`, `su`, `rm -rf /`, `mkfs`, `wipe` | Comma-separated JavaScript regex sources tested against the whole `shell` command. Overriding **replaces** the defaults. |
| `ADBMCP_SHELL_ALLOWED_PREFIXES` | unset (no prefix restriction) | When set, a `shell` command must start with one of these comma-separated prefixes. |
| `ADBMCP_PUSH_ALLOWED_ROOTS` | `/sdcard`, `/storage/emulated/0`, `/data/local/tmp` | Remote roots `push_file` may write to. |
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
- **`uninstall_package` deletes app data** unless `keep_data: true`. It is marked
  `destructiveHint: true`.
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
  config.ts           env config, shell/device/push guardrails
  devices.ts          device parsing, resolution rule, list_devices tool
  adb/runner.ts       subprocess per call: -s scoping, timeouts, head+tail caps
  adb/errors.ts       typed causes mapped from adb stderr/exit codes
  streams/registry.ts long-running logcat handles + ring buffer
  tools/              one module per tool group (19 MVP tools)
  resources/devices.ts, prompts/index.ts
test/                 vitest suites (fakes in test/helpers/)
```

## Status

MVP scope per the design doc. Not implemented (v2 candidates): wireless pairing (`adb pair` /
`adb connect`), `screenrecord`, port reverse, `bugreport`, `dumpsys` helpers, permission
grant/revoke, input injection tools, Streamable HTTP transport, iOS, emulator lifecycle management.
Windows is best-effort (POSIX-first, like most of the ecosystem).
