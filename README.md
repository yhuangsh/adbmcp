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
- **stdio by default, Streamable HTTP optional** — the client launches `adbmcp` as a subprocess;
  `--http` serves the same tools over `/mcp` for shared-device-host deployments.

Implements the MVP plus v2.0 items 1–7 in [`docs/design/product-design-v0.md`](docs/design/product-design-v0.md).

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

Other stdio clients work the same way: a `command` plus `args`, with `ADB_PATH` / `ADBMCP_*`
environment variables passed through. In stdio mode, stdout carries MCP protocol traffic only;
diagnostics go to **stderr**.

### Streamable HTTP (shared device host)

Use HTTP when several agents or MCP clients should share one machine's adb server, devices and
allowlist — an emulator farm, a lab phone, or a remote desktop — instead of each client launching its
own subprocess. stdio stays the default: with no flags, `adbmcp` speaks MCP on stdin/stdout.

```bash
node dist/index.js --http                                    # http://127.0.0.1:3331/mcp
ADBMCP_HTTP_TOKEN=secret node dist/index.js --http --host 0.0.0.0 --port 8080
```

| Flag / variable | Default | Meaning |
| --- | --- | --- |
| `--http` | off | Enable the Streamable HTTP transport. Without it the server is stdio-only. |
| `--port`, `ADBMCP_HTTP_PORT` | `3331` | Listen port (`--port` wins over the env var). `0` asks the OS for an ephemeral port; the real URL is logged to stderr. |
| `--host`, `ADBMCP_HTTP_HOST` | `127.0.0.1` | Bind address (`--host` wins over the env var). |
| `ADBMCP_HTTP_TOKEN` | unset | When set, every `/mcp` request must send `Authorization: Bearer <token>`. Unset is allowed only on a loopback host. |
| `ADBMCP_HTTP_ALLOWED_HOSTS` | derived | Comma-separated exact `Host` header values (`host[:port]`) for DNS-rebinding protection. Overrides the derived loopback/bound-host list. |

The endpoint is stateful: `initialize` creates a session, `Mcp-Session-Id` identifies it, and
`DELETE /mcp` closes it. All sessions share one device host, one `ADBMCP_ALLOWED_DEVICES` allowlist
and one logcat stream registry — streams started in one session can be read from another. Sessions
are the same trust domain, **not** isolation between agents.

Client config (Claude Desktop, Cursor, or any Streamable HTTP client):

```json
{
  "mcpServers": {
    "adb": {
      "type": "http",
      "url": "http://localhost:3331/mcp"
    }
  }
}
```

When `ADBMCP_HTTP_TOKEN` is set, add `"headers": { "Authorization": "Bearer <token>" }` to the
server entry (client support for header config varies).

Security notes:

- **Loopback by default.** Binding a non-loopback host without `ADBMCP_HTTP_TOKEN` is refused at
  startup; the error explains the two ways forward (set a token, or bind `127.0.0.1`).
- **Token auth is pre-MCP.** With a token configured, missing/incorrect credentials get `401` before
  any MCP session handling; comparison is constant-time (`node:crypto` `timingSafeEqual`).
- **DNS-rebinding protection.** The SDK transport rejects requests whose `Host` header is not the
  bound host or a loopback alias (`localhost`, `127.0.0.1`, `::1`) on the actual port. Override with
  `ADBMCP_HTTP_ALLOWED_HOSTS` when a reverse proxy forwards a different hostname.
- **One device host, many agents.** `shell` is available to every session; on a shared host prefer
  `ADBMCP_ALLOWED_DEVICES` and `ADBMCP_SHELL_ALLOWED_PREFIXES`, and put the server behind the token.
- **No in-process TLS.** The server speaks plain HTTP; terminate TLS in a reverse proxy for
  non-loopback deployments and set `ADBMCP_HTTP_ALLOWED_HOSTS` to the forwarded `Host` value.
- Only `/mcp` is served; POST bodies are capped at 1 MiB (`413` above that), unsupported methods get
  `405`, and unknown paths get `404`.

### Deploying over a VPN mesh (Tailscale example)

A common topology: your agent runs on a public server, and one or more device hosts (machines with
USB-attached phones) are joined to a private mesh such as a Tailscale tailnet. Nothing needs to be
exposed to the public internet — the agent reaches device hosts through the mesh.

**Shape A — bind the mesh interface directly.** On each device host, set the token, bind to the
mesh IP (or `0.0.0.0`), and allow the hostname the agent will dial:

```bash
ADBMCP_HTTP_TOKEN=<token> ADBMCP_HTTP_ALLOWED_HOSTS='phonehost.tailnet-name.ts.net:3331,127.0.0.1:3331,localhost:3331' \
  adbmcp --http --host 0.0.0.0 --port 3331
```

WireGuard encrypts mesh traffic; the bearer token stays as the application-level gate so a
misconfigured ACL or a compromised mesh member still cannot touch your devices. `ALLOWED_HOSTS` must
contain the exact `Host` header the agent sends — MagicDNS name *and* port. Note the override
*replaces* the derived loopback defaults, so loopback entries are re-added for local health checks.

**Shape B — loopback + `tailscale serve` (nice for always-on hosts).** Keep adbmcp bound to
`127.0.0.1` (optionally with a token still set), then let Tailscale expose it:

```bash
adbmcp --http --host 127.0.0.1 --port 3331 &
tailscale serve --bg --https=443 http://127.0.0.1:3331   # --https=443 is the default mode
```

Keep the token set even in this shape — `tailscale serve` terminates TLS and limits reachability to
the tailnet, but adbmcp should still authenticate its clients. Point the agent at
`https://phonehost.tailnet-name.ts.net/mcp` (`tailscale serve` passes the original Host header
through, so the portless `ADBMCP_HTTP_ALLOWED_HOSTS` entry is correct here).

Caveats that apply to both shapes: one adbmcp node per device host (the agent configures one MCP
server entry per host — there is no cross-host device registry); sessions live until the client
deletes them or the process restarts, so a device host that suspends or redeploys drops its logcat
streams and agents must re-initialize; and provision the token to the agent out-of-band (secret
manager, not chat).

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
| `launch_package` | Resolve a package's LAUNCHER activity, then `am start -n`; returns the component, `wait` for `-W` | — | — | — | — |
| `force_stop_app` | `am force-stop` | — | — | ✅ | — |
| `get_ui_hierarchy` | `uiautomator dump` XML with bounds/ids/text; `to_file` dumps to `/data/local/tmp` and returns `{path, bytes}` for `pull_file` | ✅ | — | ✅ | — |
| `tap` | `input tap x y` — tap a screen coordinate (device pixels) | — | — | — | — |
| `swipe` | `input swipe x1 y1 x2 y2 [duration_ms]` — scroll or drag | — | — | — | — |
| `type_text` | `input text` with `%s` space encoding and device-shell quoting; non-ASCII (e.g. CJK) goes through the `ADB_INPUT_B64` broadcast when a capable IME (ADB Keyboard) is active — see [Non-ASCII text input](#non-ascii-text-input) | — | — | — | — |
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

### Non-ASCII text input

Android's `input text` is ASCII-only: typing non-ASCII text (e.g. CJK) through it crashes on the
device with a `NullPointerException` instead of typing anything (issue #3). `type_text` therefore
has two paths:

- **ASCII text** (default and unchanged) is sent as `input text` with `%s` space encoding and
  device-shell quoting — one round trip, no extra device calls.
- **Non-ASCII text** is sent as `am broadcast -a ADB_INPUT_B64 --es msg <base64-utf8>` to the active
  input method. This requires a broadcast-capable IME to be the **active** IME; the reference
  implementation is [ADB Keyboard](https://github.com/senzhk/ADBKeyBoard)
  (`com.android.adbkeyboard/.AdbIME`). On every non-ASCII call adbmcp queries
  `settings get secure default_input_method` (never cached) and broadcasts only when the active IME
  matches a configured capable component.

One-time setup, run from your own shell (adbmcp detects the IME but deliberately never installs or
switches IMEs on its own):

```sh
adb install ADBKeyboard.apk                      # from the ADBKeyBoard releases
adb shell ime enable com.android.adbkeyboard/.AdbIME
adb shell ime set com.android.adbkeyboard/.AdbIME   # must be the ACTIVE input method
```

Failure modes, both typed and actionable instead of leaking the device-side NPE:

- `[IME_UNAVAILABLE]` — the text is non-ASCII but the active IME is not broadcast-capable (or no IME
  is selected). The message names the active IME and the hint gives the `ime enable` / `ime set`
  commands above.
- `[TEXT_NOT_ASCII]` — `ADBMCP_TYPE_TEXT_NON_ASCII=reject` opts out of the broadcast path, so
  non-ASCII text is refused before any device call.

IMEs other than ADB Keyboard can be declared broadcast-capable with
`ADBMCP_IME_BROADCAST_COMPONENTS` (see the table below); both the short `pkg/.Class` form and the
flattened `pkg/pkg.Class` form match.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADB_PATH` | `adb` (from `PATH`) | Path to the adb binary. Must match the version of any running adb server. |
| `ADBMCP_ALLOWED_DEVICES` | unset (all allowed) | Comma-separated serial allowlist. Operations on other serials are refused. |
| `ADBMCP_SHELL_BLOCKED_PATTERNS` | `reboot`, `su`, `mkfs`, `wipe`, `rm` of `/` (split/reordered flags and `/*` included), pipelines into `sh`/`bash` | Comma-separated JavaScript regex sources tested against the whole `shell` command. Overriding **replaces** the defaults. |
| `ADBMCP_SHELL_ALLOWED_PREFIXES` | unset (no prefix restriction) | When set, a `shell` command must start with one of these comma-separated prefixes. |
| `ADBMCP_PUSH_ALLOWED_ROOTS` | `/sdcard`, `/storage/emulated/0`, `/data/local/tmp` | Remote roots `push_file` may write to. |
| `ADBMCP_CLEAR_ALLOWED_PACKAGES` | unset (refuse every clear) | Comma-separated package allowlist for `clear_app_data`. There is no allow-all mode: unset or empty refuses every clear. |
| `ADBMCP_TYPE_TEXT_NON_ASCII` | `ime` | How `type_text` handles non-ASCII text (see [Non-ASCII text input](#non-ascii-text-input)): `ime` sends the `ADB_INPUT_B64` broadcast when a capable IME is active, `reject` fails with `[TEXT_NOT_ASCII]`. |
| `ADBMCP_IME_BROADCAST_COMPONENTS` | `com.android.adbkeyboard/.AdbIME` | Comma-separated IME component ids accepted as broadcast-capable for the `ADB_INPUT_B64` path. `pkg/.Class` and flattened `pkg/pkg.Class` forms both match. |
| `ADBMCP_TIMEOUT_MS` | `30000` | Default subprocess timeout (`timeout_ms` per call overrides it). |
| `ADBMCP_MAX_OUTPUT_BYTES` | `65536` | Head+tail byte cap per call; the dropped middle is reported inline. |
| `ADBMCP_LOGCAT_BUFFER_BYTES` | `1048576` | Ring-buffer cap per logcat stream; overflow is reported as `dropped_bytes`. |
| `ADBMCP_HTTP_PORT` | `3331` | HTTP mode listen port (equivalent to `--port`; the flag wins). |
| `ADBMCP_HTTP_HOST` | `127.0.0.1` | HTTP mode bind address (equivalent to `--host`; the flag wins). |
| `ADBMCP_HTTP_TOKEN` | unset | Bearer token required on every `/mcp` request when set. Non-loopback binds without it are refused. |
| `ADBMCP_HTTP_ALLOWED_HOSTS` | derived | Comma-separated exact `Host` header values accepted by DNS-rebinding protection. |

## Safety notes

- **Annotations are advisory, guardrails are authoritative.** The host decides what to auto-approve;
  `adbmcp` enforces its own limits regardless: blocked `shell` patterns, the device allowlist, remote
  push roots, and the pull overwrite check.
- **`shell` is arbitrary code execution on the device.** It is annotated as not read-only and
  open-world, blocklisted by default, and documented as the escape hatch — keep `shell` disabled or
  prefix-restricted (`ADBMCP_SHELL_ALLOWED_PREFIXES`) on shared or CI machines. The default blocklist
  covers reboot/power-state changes, `su`, `mkfs`, `wipe`, `rm` of `/` (including split/reordered
  flags and the `/*` glob), and pipelines into `sh`/`bash` such as `curl … | sh` or `… | sudo bash`.
  This is a guardrail, not a sandbox: a deliberately obfuscated command can still get through. A
  pattern-based guardrail: matching runs on the raw command text, including inside quotes, so even
  prose like `echo "use curl | sh to install"` is refused — precision always yields to safety here.
  maintainer can replace the patterns with `ADBMCP_SHELL_BLOCKED_PATTERNS`.
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
  index.ts            entrypoint: stdio by default, --http for Streamable HTTP
  http.ts             HTTP sessions, bearer auth, loopback guard, DNS-rebinding allowlist
  server.ts           assembles config + runner + tools/resources/prompts
  config.ts           env config, shell/device/push/clear guardrails
  devices.ts          device parsing, resolution rule, list_devices tool
  adb/runner.ts       subprocess per call: -s scoping, timeouts, head+tail caps
  adb/errors.ts       typed causes mapped from adb stderr/exit codes
  streams/registry.ts long-running logcat handles + ring buffer
  tools/              one module per tool group (35 tools, MVP + v2.0 items 1–6 + v0.6.0 additions)
  resources/devices.ts, prompts/index.ts
test/                 vitest suites (fakes in test/helpers/)
```

## Status

Implements the MVP plus v2.0 items 1–7 from the design (§4.2): reverse port forwards and structured
forward/reverse listings, `pm grant`/`revoke` plus allowlist-gated `clear_app_data`, wireless
TCP/IP `connect`/`disconnect`/`wireless_pair`, first-class input injection (`tap`, `swipe`,
`type_text`, `key_event` — typed schemas that fix the `input text` quoting footgun, no DSL), the
curated `dumpsys_query`, and the pulled-forward Streamable HTTP transport. v0.4.0 was a
hardening/polish release (no new tools): shell guardrails now also block pipe-to-shell payloads and
split/globbed root-deleting `rm`, address-targeted `disconnect` failures are reported as typed
errors, and `reverse_port` rejects forward-only device-side specs pre-spawn. v0.5.0 adds Streamable
HTTP (`/mcp`, stateful sessions, one shared device/stream context, optional bearer auth, loopback
binding guard, DNS-rebinding protection). v0.6.0 adds `launch_package` (resolve a package's launcher
activity and start it, returning the component) and `get_ui_hierarchy` `to_file` (keep large dumps
on-device as `{path, bytes}` for `pull_file` instead of returning structurally truncated inline XML).
v0.6.1 teaches `type_text` non-ASCII (CJK) input: text rides the `ADB_INPUT_B64` broadcast to a
capable IME (ADB Keyboard by default) when one is the active input method, with typed
`IME_UNAVAILABLE`/`TEXT_NOT_ASCII` errors otherwise (`ADBMCP_TYPE_TEXT_NON_ASCII` chooses the
posture). v0.7.0 moves onto the MCP TypeScript SDK v2 packages and serves both protocol revisions:
legacy clients keep stateful Streamable HTTP sessions while `2026-07-28` clients get stateless
serving (`server/discover`, `resultType`, per-request `_meta`), same guardrails on both paths.
Not implemented: `screenrecord`, `bugreport`, iOS, emulator lifecycle management. Windows is
best-effort (POSIX-first, like most of the ecosystem).

## Contributing

Bug reports and use-case-driven feature requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for what makes a good issue, how triage works, and the
development setup.
