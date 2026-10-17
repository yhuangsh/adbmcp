# Contributing to adbmcp

Thanks for taking the time — bug reports and use-case-driven feature requests are what steer this
project. This document explains how to file issues that get acted on, what happens after you file,
and how to set up a development environment if you want to contribute code.

## Filing a bug

Open a [bug report](https://github.com/yhuangsh/adbmcp/issues/new?template=bug_report.yml). The
template asks for the things triage actually needs — the two that matter most:

1. **A minimal reproduction**: the exact tool call(s) or commands, what you got, and what you
   expected. If it only happens sometimes, say so.
2. **The environment**: adbmcp version, transport (stdio or HTTP), OS, Node version, and the device
   (model + Android version). Typed errors like `[DEVICE_UNAUTHORIZED]` are features, not bugs —
   paste them anyway, they tell us which path you hit.

Severity guidance: *blocks me entirely* → we treat it as P1; *workaround exists* → P2; *cosmetic or
documentation* → P3.

## Filing a feature request

Open a [feature request](https://github.com/yhuangsh/adbmcp/issues/new?template=feature_request.yml).
Lead with the **problem or use case**, not the imagined solution — "I need an agent to verify a UI
animation" produces a better design conversation than "add a video tool."

Two things the design doc already answers:

- **Non-goals** (§7): UI-test frameworks/assertion DSLs, iOS support, screen mirroring/scrcpy
  replacement, Android SDK/emulator lifecycle management, and adb protocol reimplementation are
  deliberately out of scope. Requests that fall inside a non-goal will be closed with a pointer to
  the section.
- **The deferred ledger** (§4.2): features like Streamable HTTP, screenrecord, bugreport, and
  emulator management are deferred *with written trigger conditions*. If your use case matches a
  trigger, say so — that's the strongest possible argument for pulling it forward. Otherwise the
  issue gets labeled `roadmap-deferred` with the condition that would change our mind.

## What happens after you file

This is a solo-maintainer project with an agent-assisted development loop, so the process is
consistent and fast, but not instant:

1. **Triage** — every issue gets read. Bugs are verified against the reproduction and given a
   priority (`P1`/`P2`/`P3`) and the `triaged` label. Feature requests are checked against the
   design doc's ledger and non-goals.
2. **Questions** — if the reproduction is unclear, we ask on the issue (`question` label) and wait.
   Issues that go quiet for 14 days with needed info missing may close as stale.
3. **Implementation** — accepted work goes through a fixed loop: implement → independent review
   against the issue's acceptance criteria → fix → full test suite → live verification on real
   hardware where the change touches device behavior.
4. **Release** — fixes and features ship in tagged releases (`patch` for fixes, `minor` for
   features) published automatically from CI with signed provenance. The commit that lands your
   issue closes it (`Fixes #N`), and the commit message is the changelog entry.

## Development setup

Requires Node.js ≥ 20. adb is only needed for the live smoke script — the unit tests fake it.

```bash
git clone https://github.com/yhuangsh/adbmcp.git && cd adbmcp
npm install
npm run build        # tsc, strict
npm test             # vitest — no device or adb binary required
node scripts/smoke.mjs   # optional: full live verification against an attached device
```

Project layout and the reasoning behind it: [`docs/design/product-design-v0.md`](docs/design/product-design-v0.md)
is the authoritative design document — tool surface, architecture, safety model, deferred ledger,
and the decisions behind all of it. `README.md` covers transports, configuration, and guardrails.

Conventions that keep reviews fast:

- Tools stay **thin wrappers over the adb binary** (spawn, no protocol reimplementation) with full
  MCP annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`)
- All input validation happens **pre-spawn** with actionable error messages; adb failures map to
  the typed error causes in `src/adb/errors.ts`
- Every risky path gets a test pin — including the refusal paths (what must *not* run)
- Guardrails are authoritative and fail closed; annotations are advisory

## Releases

Releases are tagged (`vX.Y.Z`) and published automatically: CI builds and tests on
Linux/macOS/Windows (Node 20 + 22), verifies the tag matches `package.json`, then publishes with
signed provenance via npm trusted publishing. No manual npm steps.
