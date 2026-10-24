# Plan: Commit the .gitignore change ignoring SSSF factory scaffolding

## Goal

Commit the already-made `.gitignore` edit so the local-only SSSF scaffolding
(`adws/`, `justfile`, `.env.sample`) is ignored by git. Only `.gitignore` goes
into the commit. No files are deleted, moved, or otherwise changed.

## Current state (verified by planner)

- `git status --short` shows exactly one line: ` M .gitignore` — no untracked
  scaffolding.
- `.gitignore` `# sssf runtime` block already contains:
  ```
  adws/
  justfile
  .env.sample
  .env
  __pycache__/
  *.pyc
  specs/
  ```
- `git check-ignore -v adws/ justfile .env.sample` exits 0 and maps each path
  to `.gitignore` lines 8–10.
- `git diff .gitignore` shows only the added `# sssf runtime` block; earlier
  entries (`node_modules/`, `dist/`, `*.log`, `.DS_Store`, `.pi/`) untouched.

## Steps

### 1. Verify the edit (before committing)

Run and confirm each:

1. `git status --short` → exactly ` M .gitignore`, nothing else.
2. `git check-ignore adws/ justfile .env.sample` → exits 0, lists all three
   paths.
3. `git diff .gitignore` → the only change is the `# sssf runtime` block;
   no other lines modified.

### 2. Adjust only if a path is missing

If step 1 shows any of `adws/`, `justfile`, `.env.sample` NOT ignored
(`git check-ignore` exit 1 or missing from output), add the missing entry to
the `# sssf runtime` block in `.gitignore`, then re-run all of step 1.
Do not make any other edit. (Planner verification indicates this should not be
needed.)

### 3. Commit .gitignore alone

```
git add .gitignore
git commit -m "Ignore local-only SSSF factory scaffolding"
```

- Stage `.gitignore` by name — never `git add -A` / `git add .`.
- The commit must contain exactly one file: `.gitignore`.

### 4. Post-commit verification

1. `git show --stat HEAD` → only `.gitignore` listed.
2. `git status --short` → empty output (clean tree).
3. `git check-ignore adws/ justfile .env.sample` → exit 0, all three listed.
4. `ls adws justfile .env.sample` → all still on disk.

## Out of scope

- Deleting or moving any sssf files.
- Changing anything outside `.gitignore`.
- Committing any of the scaffolding itself (adws/, justfile, .env.sample,
  specs/ stay untracked/ignored).
