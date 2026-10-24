# Plan: Ignore local-only SSSF factory scaffolding in git

## Goal

`adws/`, `justfile`, and `.env.sample` must never appear as untracked in git status.
Only `.gitignore` may change. Nothing on disk is deleted, moved, or modified; nothing is committed.

## Current state (verified)

- `git status --short` shows:
  ```
   M .gitignore
  ?? .env.sample
  ?? adws/
  ?? justfile
  ```
- `.gitignore` already carries a `# sssf runtime` block, but it only ignores
  session data (`adws/adw_data/sessions/`, `adws/adw_data/sssf.db*`, `.env`,
  `__pycache__/`, `*.pyc`) — not the three scaffolding paths.
- `git check-ignore adws/ justfile .env.sample` currently exits 1 (none ignored).

## Changes

### File: `.gitignore` (only file touched)

Extend the existing `# sssf runtime` block so the whole factory scaffolding is
ignored. Replace the block:

```
# sssf runtime
adws/adw_data/sessions/
adws/adw_data/sssf.db*
.env
__pycache__/
*.pyc
```

with:

```
# sssf runtime
adws/
justfile
.env.sample
.env
__pycache__/
*.pyc
```

Notes:
- `adws/` ignores the entire directory, which subsumes the old
  `adws/adw_data/sessions/` and `adws/adw_data/sssf.db*` entries, so those two
  lines are dropped (keeping them is also acceptable — they are redundant but
  harmless; prefer the clean form above).
- Do not touch the earlier entries in the file (`node_modules/`, `dist/`,
  `*.log`, `.DS_Store`, `.pi/`).
- Use an in-place edit (read + write or a small patch); do not run
  `git add`, `git commit`, or any file moves/deletes.

## Verify (all must pass)

1. `git status --short` — output is exactly ` M .gitignore` and nothing else
   (no `??` lines).
2. `git check-ignore adws/ justfile .env.sample` — exits 0 and lists all three
   paths. (`git check-ignore -v ...` shows the matching `.gitignore` lines.)
3. Files still on disk and unchanged: `ls adws justfile .env.sample` succeeds;
   `git diff --stat` shows only `.gitignore` modified.

## Out of scope

- Deleting or moving any sssf files.
- Changing anything outside `.gitignore`.
- Committing the scaffolding itself (the only dirty file after this work is
  `.gitignore`, and committing it is a separate decision).
