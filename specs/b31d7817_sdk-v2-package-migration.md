# Plan: Migrate `@modelcontextprotocol/sdk` v1.32.x → v2 packages (package migration only)

## Goal

Swap the SDK dependency from `@modelcontextprotocol/sdk ^1.32.1` to the v2 split
packages (`@modelcontextprotocol/core`, `/server`, `/client`, `/node`) with **zero
client-visible behavior change**: stdio serving unchanged, HTTP serving keeps 2025-era
stateful sessions (`Mcp-Session-Id`, initialize-creates-session, DELETE closes) on the
v2 Node streamable transport, bearer auth / loopback guard / Host allowlist still
enforced, all 35 tools + 1 resource + 3 prompts intact, full vitest suite green.

This is **not** the 2026-07-28 protocol adoption — no `createMcpHandler`, no stateless
mode, no dual-serve (that is the next work order, per
`docs/research/sdk-v2-2026-10.md` and design doc §8 item 6).

## Verified ground truth (recon already done — trust this, don't re-derive)

Package versions on npm (checked 2026-10-era registry):
- `@modelcontextprotocol/core` **2.4.0**, `/server` **2.4.0**, `/client` **2.4.0** —
  interdependent (`server` and `client` pin `core: 2.4.0`).
- `@modelcontextprotocol/node` **2.1.2** — independent version line; depends on
  `hono` + `@hono/node-server` (new transitive deps are expected).
- `@modelcontextprotocol/codemod` **2.4.0** — bin `mcp-codemod`.
- v2 requires `zod ^4.2.0` — repo has `^4.6.7`, **no zod change**.
- v2 requires Node 20+ — repo engines and CI matrix (20/22) already comply.

Import mapping (from the codemod's own `importMap`, cross-checked against the
published packages' export maps):

| v1 import (current) | v2 target |
|---|---|
| `sdk/server/mcp.js` (`McpServer`) | `@modelcontextprotocol/server` |
| `sdk/server/stdio.js` (`StdioServerTransport`) | `@modelcontextprotocol/server/stdio` |
| `sdk/server/streamableHttp.js` (`StreamableHTTPServerTransport`) | **`@modelcontextprotocol/node`**, symbol renamed **`NodeStreamableHTTPServerTransport`** |
| `sdk/types.js` (`CallToolResult`, `isInitializeRequest`, `LATEST_PROTOCOL_VERSION`) | resolved by context — schemas/types → `@modelcontextprotocol/core`, server helpers (`isInitializeRequest`) → `@modelcontextprotocol/server` |
| `sdk/client/index.js` (`Client`) | `@modelcontextprotocol/client` |
| `sdk/client/stdio.js` (`StdioClientTransport`) | `@modelcontextprotocol/client/stdio` |
| `sdk/inMemory.js` (`InMemoryTransport`) | resolved by context (used with `Client` → `@modelcontextprotocol/client`; also re-exported from `/server`) |

Key API facts (read from the published `.d.mts` files):

- `NodeStreamableHTTPServerTransport` is a drop-in for the v1 class: constructor takes
  `StreamableHTTPServerTransportOptions` (alias of `WebStandardStreamableHTTPServerTransportOptions`)
  which still includes `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`,
  `maxRequestBodySize`, and — **deprecated but functional** — `allowedHosts`,
  `allowedOrigins`, `enableDnsRebindingProtection`. Instance surface kept: `sessionId`
  getter, `onclose`, `onerror`, `handleRequest(req, res, parsedBody?)` (handles
  GET/POST/DELETE), `close()`. Stateful mode is documented and supported
  (`sessionIdGenerator: () => randomUUID()`).
- `McpServer` constructor unchanged: `new McpServer({name, version}, {instructions})`.
- `registerTool/registerResource/registerPrompt` still accept zod raw shapes
  (`InputArgs extends ZodRawShape` overload exists) — the repo already uses the
  `register*` shape everywhere, so tool files should need **import-line changes only**.
- v2 supports both protocol eras (`ProtocolEra = 'legacy' | 'modern'`); frozen
  2025-11-25 wire schemas ship inside the SDK and the client still sends
  `notifications/initialized` on legacy negotiation. `SUPPORTED_PROTOCOL_VERSIONS` /
  `supportedProtocolVersions` exist; the server passes them to the transport on
  `connect()` automatically. **However `LATEST_PROTOCOL_VERSION` in v2 is
  `2026-07-28`** — see step 5.
- The codemod rewrites `.ts/.mts/.cts/.js/.mjs` in place **and edits `package.json`**
  when run on a directory. It leaves `/* @mcp-codemod-error … */` comments where it
  can't decide.

Repo-specific facts (already grepped):

- SDK imports live in: `src/server.ts`, `src/index.ts`, `src/http.ts`,
  `src/tools/*.ts` (12 files, type-only `McpServer` + `CallToolResult` in
  `tools/common.ts`), `src/devices.ts`, `src/resources/devices.ts`,
  `src/prompts/index.ts`, `test/server.test.ts`, `test/http.test.ts`,
  `scripts/smoke.mjs`.
- The injected-SDK-seam tokens **`setRequestHandler(`, `ErrorCode.`, `extra.`,
  `McpError` appear nowhere** in `src/`, `test/`, `scripts/` (verified).
  `test/helpers/fakes.ts` fakes the adb seam (`AdbInvoker`, `StreamSpawner`), not the
  SDK — it imports zero SDK symbols. Tool handlers use only the first `args`
  parameter; no handler touches the v1 `extra` arg. Expect the codemod to leave
  `fakes.ts` untouched; re-verify anyway (step 3).
- No `vi.mock`/`jest.mock`, no dynamic SDK imports (only `import('./http.js')` in
  `src/index.ts`, a local path — unaffected).
- `tsconfig` is `module: NodeNext` — v2 subpath exports (`/stdio`) resolve fine.

## Steps

### 0. Clean starting point

`git status` — start from a clean tree (codemod rewrites in place; the diff must be
reviewable). Work on a branch if that's the session convention.

### 1. Run the codemod from the repo root

```bash
npx @modelcontextprotocol/codemod@2.4.0 v1-to-v2 .
```

(Pin `@2.4.0`, the version this plan was recon'd against; `@latest` also matches the
request's command.) Expected rewrites:

- All `src/**` import lines per the mapping table above; `src/http.ts` gets
  `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport` imported from
  `@modelcontextprotocol/node`, and `isInitializeRequest` routed to
  `@modelcontextprotocol/server`.
- `test/server.test.ts`: `Client` + `InMemoryTransport` → `@modelcontextprotocol/client`.
- `test/http.test.ts`: `LATEST_PROTOCOL_VERSION` re-routed (destination resolved by
  context — step 5 removes this import entirely).
- `scripts/smoke.mjs`: `Client` → `@modelcontextprotocol/client`,
  `StdioClientTransport` → `@modelcontextprotocol/client/stdio`.
- `package.json`: `@modelcontextprotocol/sdk` removed; v2 packages added.

Review the full diff (`git diff`) before proceeding.

### 2. Resolve codemod markers

```bash
grep -rn '@mcp-codemod-error' src test scripts package.json
```

Expect zero hits. Any marker: follow its embedded instruction; consult
https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html if unclear.
Done-criteria requires **no markers remain**.

### 3. Manual seam grep (the part the import-driven codemod cannot see)

```bash
grep -rn 'setRequestHandler(\|ErrorCode\.\|McpError\|extra\.' src test scripts
grep -n 'modelcontextprotocol' test/helpers/fakes.ts
```

Both should return nothing (verified pre-migration; confirm the codemod didn't
introduce anything odd). Any hit is a manual rewrite: `McpError` → `ProtocolError`
(`@modelcontextprotocol/server`), `ErrorCode` → `ProtocolErrorCode`/`SdkErrorCode`,
handler `extra` → `ctx`.

### 4. Fix `package.json` and regenerate the lockfile

The codemod edits the manifest; verify and correct by hand so that `dependencies`
declares **exactly the v2 packages actually imported** and no v1 package:

- `@modelcontextprotocol/server` `^2.4.0` (server surface, transitively pins `core`)
- `@modelcontextprotocol/node` `^2.1.2` (HTTP + nothing else)
- `@modelcontextprotocol/client` `^2.4.0` — **only imported by tests and
  `scripts/smoke.mjs`**. If the codemod puts it in `dependencies`, move it to
  `devDependencies` — the shipped server never imports it. (`/core` should arrive
  transitively via `/server`; declare it explicitly only if a source file imports it
  directly after the codemod — likely `src/tools/common.ts`'s `CallToolResult`.)
- `zod ^4.6.7` unchanged. No version bump, no other dependency churn.

Then:

```bash
npm install
```

This regenerates `package-lock.json` without the v1 package. Confirm:
`node -e "const p=require('./package.json'); console.log(p.dependencies, p.devDependencies)"`
shows no `@modelcontextprotocol/sdk`, and
`npm ls @modelcontextprotocol/sdk` exits non-zero / prints empty.

### 5. Pin the HTTP test to the 2025-era protocol version

`test/http.test.ts` builds its initialize message with `LATEST_PROTOCOL_VERSION`,
which in v2 is `2026-07-28` — but this suite asserts **2025-era stateful session**
behavior (session ids, DELETE semantics), and `scripts/smoke.mjs` already pins
`protocolVersion: '2025-11-25'` for its HTTP section. Edit `test/http.test.ts`:

- Delete the `LATEST_PROTOCOL_VERSION` import (whatever the codemod routed it to).
- In `initializeMessage()`, use the literal `protocolVersion: '2025-11-25'`, with a
  one-line comment: suite pins the 2025-era revision because it tests stateful
  sessions; the 2026-07-28 adoption is a separate work order.

If, with that pin, initialize still fails to yield a session, the fallback is the
server/transport `supportedProtocolVersions` option — but recon says legacy versions
are accepted by default, so don't touch `src/` for this until a test failure proves
otherwise.

### 6. Manual review of `src/http.ts` (the only file with real SDK surface)

After the codemod, walk `src/http.ts` top to bottom:

- Transport construction in `createSession()`: confirm the renamed
  `NodeStreamableHTTPServerTransport` keeps `sessionIdGenerator`,
  `onsessioninitialized`, `onsessionclosed`, `enableDnsRebindingProtection`,
  `allowedHosts`, `maxRequestBodySize`. **Keep the deprecated DNS-rebinding options**
  — they still function in v2, and replacing them with `hostHeaderValidation`
  middleware is behavior redesign that belongs to the next work order. Optionally add
  a `// deprecated in v2 but still enforced; replaced in the 2026-07-28 work order`
  comment.
- `transport.sessionId`, `onclose`, `onerror`, `handleRequest(req, res, parsedBody)`,
  `close()` usages — all still exist with the same signatures (verified); fix only
  what `tsc` flags.
- `isInitializeRequest` import — expect `@modelcontextprotocol/server`.
- The hand-rolled pieces (bearer check, `readBody` 413 cap, `sendJsonRpcError`,
  session map, loopback guard, `buildAllowedHosts`) are SDK-free — **do not touch
  them**. Note: since `handleRequest` always receives a pre-parsed `parsedBody` from
  `readJsonBody`, the transport's own `maxRequestBodySize` never fires; the repo's
  413 behavior stays owned by `readBody`.

### 7. Build and iterate on type errors

```bash
npm run build
```

Likely (small) fallout to fix:

- `src/tools/common.ts`: `CallToolResult` may land in `@modelcontextprotocol/core` —
  accept the codemod's choice if it compiles.
- Any `registerTool` config typing gripe with zod raw shapes — the v2 overload
  accepts `ZodRawShape`, so push back on any rewrite urge; only adjust if `tsc`
  actually errors.
- Keep diffs minimal: this is a package migration, not a refactor.

### 8. Run the full test suite

```bash
npm test        # vitest run, test/**/*.test.ts, 10s timeout
```

`test/server.test.ts` drives `Client` + `InMemoryTransport.createLinkedPair()`
against `createServer()` — the v2 client still performs the legacy
initialize/initialized handshake, so this should pass unchanged after import
rewrites. `test/http.test.ts` exercises the whole session lifecycle, bearer auth,
Host allowlist (403 on unexpected Host), 413/415/404/405 paths — the acceptance net
for "no client-visible change". Fix failures in `src/` **only** when the v2 API
genuinely differs; never weaken an assertion to make a test pass.

### 9. Verify stdio serving by hand

The unit suite covers in-memory; do one real stdio round-trip against the built
output:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"stdio-check","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | node dist/index.js 2>/dev/null | head -c 400
```

Expect two JSON-RPC responses on stdout, the second listing 35 tools. (This exercises
the real `StdioServerTransport` from `@modelcontextprotocol/server/stdio`.)

`scripts/smoke.mjs` needs a live device — do **not** run it; just confirm its imports
were rewritten (step 2/11 greps cover it).

### 10. Final acceptance greps

```bash
grep -rn '@modelcontextprotocol/sdk' src test scripts package.json   # → nothing
grep -rn '@mcp-codemod-error' src test scripts                       # → nothing
grep -rn '@modelcontextprotocol' src test scripts                    # → only v2 packages
npm run build && npm test                                            # → both exit 0
```

Also `git diff --stat`: expect `package.json`, `package-lock.json`, the SDK-import
lines across `src/**`, `test/server.test.ts`, `test/http.test.ts`,
`scripts/smoke.mjs`, and nothing else. No README/design-doc changes (the design doc
was already updated for v2 by a prior work order), no version bump.

## Out of scope (guardrails)

- No 2026-07-28 protocol adoption: no `createMcpHandler`, no stateless serving, no
  `isLegacyRequest` routing, no dual-serve, no `server/discover`.
- No dependency changes beyond the SDK swap (zod, vitest, typescript untouched).
- No new features, no behavior changes, no version bump, no release, no README or
  docs edits.
- Do not replace the deprecated `allowedHosts`/`enableDnsRebindingProtection`
  transport options with v2 host-validation middleware — that redesign ships with the
  2026-07-28 work order.
- Do not run `scripts/smoke.mjs` (needs a physical device).

## Risks / watch-items

1. **`@modelcontextprotocol/node` versions independently** (2.1.2 vs 2.4.0) — declare
   `^2.1.2`, don't force-align.
2. **Codemod context-resolution may surprise** on `sdk/types.js` and `sdk/inMemory.js`
   imports (`RESOLVE_BY_CONTEXT`): if `isInitializeRequest` or `LATEST_PROTOCOL_VERSION`
   land somewhere that doesn't compile, route them per the mapping table by hand.
3. **Protocol-version negotiation**: everything asserts 2025-era behavior; the literal
   `'2025-11-25'` pin in `test/http.test.ts` (step 5) is the load-bearing edit. If
   HTTP session tests fail after it, look at `supportedProtocolVersions` /
   `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` before changing any assertion.
4. **New transitive deps** (hono, @hono/node-server, jose, eventsource,
   pkce-challenge, cross-spawn) enter the lockfile via `/node` and `/client`; CI runs
   `npm ci`, so the lockfile must be regenerated and committed, not hand-edited.
5. The codemod is a `.mjs`-aware rewriter running over the whole repo — confine its
   blast radius by reviewing `git diff` immediately after step 1; anything outside
   `src/`, `test/`, `scripts/`, `package.json` is suspicious (`dist/` is build output
   and `.gitignore`d — confirm it isn't tracked).
