# Plan: Update design doc for MCP spec 2026-07-28 / TypeScript SDK v2

## Goal

Bring `docs/design/product-design-v0.md` back in line with reality after the MCP spec
2026-07-28 revision and TypeScript SDK v2 (stable 2.4.0, 2026-10-23). The committed research
note **`docs/research/sdk-v2-2026-10.md` is the source of truth** — every factual claim in the
update must be traceable to it. Docs-only: **no source, test, or dependency changes.**

## Files to touch

- `docs/design/product-design-v0.md` — sections §4.2, §5, §6 (one sentence, see below), §8 item 6, §9 (append sources).
- `README.md` — **conditional, likely untouched** (see step 4).

Do not change section numbering, do not re-rank roadmap items, do not add new top-level
sections, do not alter any "— **shipped (vX.Y.Z)**" annotation (those describe shipped
behavior on the v1 SDK and remain accurate).

## Step 1 — §4.2 "Later (v2)" deferred items get new mechanisms

The parked candidates' mechanisms changed; keep them parked (roadmap re-ranking stays
demand-driven — out of scope), but describe them against the new spec shapes.

1. **Item 6 (`wireless_pair`)** — the trailing note "MCP elicitation only as later progressive
   enhancement" is stale: spec 2026-07-28 replaces elicitation with Multi Round-Trip Requests
   (MRTR, SEP-2322). Rewrite the note so the progressive-enhancement path is: the server
   returns a result with `resultType: "input_required"` carrying `inputRequests` (the pairing
   code prompt), and the client retries the original request with `inputResponses`; viability
   depends on host MRTR support. Keep the "shipped (v0.3.0)" annotation and the required-`code`
   argument description unchanged.
2. **"Explicitly out of v2.0" paragraph** — update the parenthetical reasons, not the
   membership:
   - `screenrecord`: no longer "(needs a job lifecycle, not the stream registry)" in the old
     sense — long-running operations now have an official shape in the
     **`io.modelcontextprotocol/tasks` extension** (poll-based `tasks/get`, `tasks/update` for
     input, servers may return task handles unsolicited). Keep it deferred; state that any
     future design goes against the tasks extension.
   - resource subscriptions/notifications: `resources/subscribe`/`unsubscribe` were replaced by
     **`subscriptions/listen`** (single long-lived POST stream; opt-in types incl.
     `resourceSubscriptions`). Note the mechanism is viable again under the new shape and would
     need re-spec'ing before any design.
   - `bugreport` and emulator management: reasons unchanged, leave the prose as-is.

## Step 2 — §5 "High-Level Architecture" states the stateless direction and migration posture

Keep all descriptions of the shipped v0.5.0 transport accurate (it is what ships today);
add the forward-looking statements:

1. **Transport bullet** — after the existing stdio/Streamable HTTP statements, add: the
   2026-07-28 spec revision removes protocol-level sessions and the `Mcp-Session-Id` header;
   the protocol core is now stateless (no `initialize`/`notifications/initialized` handshake;
   protocol version and client capabilities ride per-request `_meta`; servers MUST implement
   `server/discover`). Consequently the shipped stateful per-session HTTP transport
   (`src/http.ts`) is v1-era/legacy going forward, while the stream-handle pattern
   (`StreamRegistry`, server-minted handles passed as ordinary tool arguments per SEP-2567) is
   now the officially blessed shape for cross-call state and survives unchanged.
2. **Streamable HTTP (v0.5.0) bullet** — append the migration posture: adbmcp pins
   `@modelcontextprotocol/sdk ^1.32.1` (v1 line), which upstream maintains with bug fixes and
   security updates only until **~2027-01-27**; the plan is to migrate to SDK v2 deliberately
   (not urgently), **dual-serving** during the transition — legacy session transport plus
   `isLegacyRequest` routing in front of `createMcpHandler` (the documented pattern) for one
   release, clean cut to stateless later. Note that v2's `createMcpHandler` performs no
   Host/Origin validation, so the existing bearer-token / Host-allowlist / loopback guardrails
   survive but must be remounted in front of it.
3. **Long-running operations bullet** — adjust the "(v2) screenrecord" phrase so screenrecord
   is described as a future candidate against the `io.modelcontextprotocol/tasks` extension,
   consistent with the §4.2 edit; logcat streaming via the stream registry is unchanged.

## Step 3 — §8 item 6 records the materialized risk

Rewrite item 6 ("Spec version targeting (open)") as a **materialized** risk:

- The spec moved: revision **2026-07-28** ("largest since launch"); SDK **v2 stable at 2.4.0
  (2026-10-23)** implements it; v1 is guaranteed bug/security fixes only until **~2027-01-27**.
- Record the verdict from the research note: migrate deliberately, not urgently; dual-serve for
  one release then cut; the 35-tool surface is unaffected in kind (mechanical
  `registerTool/registerPrompt/registerResource` renames covered by the official codemod
  `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`); the expensive part is the
  `src/http.ts` rewrite (clean cut vs dual-serve decision → dual-serve chosen given the
  installed host base).
- Note the known traps: the codemod is import-driven and SDK surfaces received as injected
  parameters (the `test/helpers/fakes.ts` DI seam) fail at **runtime**, needing manual v1-token
  grep; v2 requires Node 20+ and `zod ^4.2.0` — adbmcp already complies with both.
- Cite **`docs/research/sdk-v2-2026-10.md`** as the reference of record for this risk.
- Keep the trailing advice that the pinned spec follows the chosen SDK release line.

## Step 4 — README status section (conditional)

Read `README.md` → `## Status`. It currently describes only shipped behavior ("stateful
sessions", the v0.x release notes, "Not implemented: …") — none of which the spec change
falsifies, because shipped software on the v1 SDK still behaves that way. **Default: make no
change.** Only touch it if the builder finds a sentence that asserts something the 2026-07-28
spec makes false as a present-tense claim about the world (not about shipped behavior). If a
change is warranted, the minimal acceptable edit is one sentence noting that the design doc and
`docs/research/sdk-v2-2026-10.md` track the SDK v1→v2 migration. Do not rewrite the release
history. (The "Windows is best-effort" line conflicts with design doc §8 item 7 but predates
this spec change — out of scope; leave it.)

## Step 5 — §6 one-sentence consistency fix + §9 sources

- **§6 "Confirmation strategy"** mentions MCP elicitation for pairing-code flows — directly
  falsified by the same spec change and would contradict the updated §4.2 note. Make the
  minimal edit: elicitation → MRTR (SEP-2322, `input_required` interim results), same
  degrade-to-error fallback. One sentence; do not otherwise restructure §6.
- **§9 Sources** — append new numbered entries (never renumber existing ones): the internal
  research note `docs/research/sdk-v2-2026-10.md`, the 2026-07-28 spec changelog
  (https://modelcontextprotocol.io/specification/2026-07-28/changelog), and the SDK v2 upgrade
  guide (https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html). If any §8.6 /
  §5 text needs an inline citation, use these numbers.

## Out of scope (guardrails)

- No code, test, config, or dependency changes (`package.json` stays on SDK v1).
- No migration execution, no codemod run, no new GitHub issues.
- No re-ranking of roadmap items; deferred items stay deferred.
- No new sections or renumbering; preserve existing prose style (terse bullets, em-dashes,
  "— **shipped (vX.Y.Z)**" annotation format).

## Verification

1. `git diff --stat` shows only `docs/design/product-design-v0.md` (and possibly `README.md`).
2. Read the full doc top-to-bottom: no contradictions between §4.2, §5, §6, §8.6, §9.
3. `grep -n "elicitation\|Mcp-Session-Id\|resources/subscribe" docs/design/product-design-v0.md`
   — every remaining hit must be either (a) a shipped-behavior description or (b) framed as
   legacy/superseded by the 2026-07-28 mechanisms.
4. Confirm all "shipped (vX.Y.Z)" annotations are byte-identical to before.
5. Confirm section numbering and heading text are unchanged.
6. Every date/number in the new prose (2026-07-28, 2.4.0, 2026-10-23, ~2027-01-27, Node 20+,
   zod ^4.2.0, SEP-2322, SEP-2567, `io.modelcontextprotocol/tasks`, `subscriptions/listen`)
   appears in `docs/research/sdk-v2-2026-10.md`.
