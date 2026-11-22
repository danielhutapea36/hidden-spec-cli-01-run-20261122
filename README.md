# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/danielhutapea36/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/danielhutapea36/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
("Build mend, one patch tool for every AI edit format", $100 total, top 10 × $10).
Deadline for entries: 24 Nov 2026 21:00 WIB. Built 22 Nov 2026, in one agent
session, from the kit's `SPEC.md` (version 1) alone — no other entry, repo or
site was read or copied.

## What it is

`node main.ts [options] [PATCH]` applies an AI-written edit to a tree of text
files, in one of four formats — unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, or text-editor tool calls as JSON — to a
single written specification. It finds the lines an edit names at the first of
three matching tiers (exact; trailing whitespace ignored; leading and trailing
whitespace ignored, with new lines re-indented), and changes every file or
none: any failed edit blocks all writes, and every failure is reported.

## Files

- `main.ts` — the CLI. Node 22, standard library only (`node:fs`, `node:path`),
  no install step, no randomness, no clock. The kit's `runner.ts` beside it is
  handed over to when `MAKEFUN_ENV_URL` is set (trial mode).
- `runner.ts` — the kit's runner, kept as it is. It reads a trial's checks from
  the env, runs `node main.ts` on each in a fresh directory, and posts exit
  code, stdout and files.
- `check.ts` — the kit's practice checker (runs `main.ts` on the 100 public
  practice checks in `program/generator/practice.json`).
- `LICENSE` — MIT (OSI-approved, as the bounty requires).

## Story / sources / decisions

- The kit's starter already implements SPEC.md §§1–4 (invocation, output,
  paths, format detection), §9 (JSON edits) and §10 (order and atomicity);
  that part is kept as handed out. §§5–8 (three-tier matching, unified diffs,
  SEARCH/REPLACE, V4A) and the move (`R`) output lines of §2 are written here,
  in this session, from SPEC.md alone.
- **Matching (§5).** Tiers are tried in order 0, 1, 2; the first tier with an
  occurrence wins. Context lines are always written as the file's own matched
  line, never the patch's. At tier 2, non-context new lines that start with
  the old first line's leading whitespace get that prefix replaced by the
  file's first matched line's leading whitespace (this also covers the case
  where the old first line has no leading whitespace, so the file's indent is
  prepended).
- **Unified (§6).** A section is one edit: create / delete / move / change.
  Hunks apply in order to the result of the ones before; a hunk with old
  lines takes the occurrence nearest to `A - 1 + d` (ties: the earlier one),
  where `d` is the running line-count drift; an empty old side inserts after
  the first `A + d` lines. A `\` line after the last context or `+` line
  removes the result's final line break when the hunk touches the end of the
  file (or the insertion is at the end); otherwise the file's final break
  stays. A created file ends with a line break unless a `\` line follows its
  last `+` line. A `--- ` line not followed by `+++ ` inside a section header
  is `error: parse <the line after it>`; a malformed `diff --git` or `@@`
  line is `error: parse <its line>`.
- **SEARCH/REPLACE (§7).** The path is the nearest non-blank, non-fence line
  before the `SEARCH` line (after the previous block's `REPLACE`); a block
  with none takes the previous block's path, and the first block with none is
  `error: parse <its SEARCH line>`. Old lines must occur at their tier
  exactly once, else `ambiguous`; empty old lines create the file.
- **V4A (§8).** The first non-blank line must be `*** Begin Patch` and the
  last non-blank line `*** End Patch`, else `error: parse <that line>` /
  `error: parse <patch lines + 1>`. Blank lines at the end of a section are
  not part of it (a whitespace-only line counts as blank — this is what makes
  the practice `v-cursor` check work). Chunks run with a cursor: an anchor
  moves the cursor past the first matching line at or after it; a chunk takes
  the first occurrence of its old lines at or after the cursor; an
  end-of-file chunk takes only an occurrence ending at the file's last line.
  An Update section with no chunk and no `*** Move to:` is a parse error at
  its Update line. A Move to with no chunks is a pure move.
- **Output (§2) and atomicity (§10).** Rows are `A` / `D` / `M`, plus one `R
  <old> -> <new>` line per move edit whose old path existed before the patch
  and is gone after it and whose new path did not exist before it and exists
  after it; rows sort in UTF-8 byte order of the path (new path for `R`).
  Every path an edit names is checked for safety before anything else about
  that edit. A failed edit changes nothing, later edits still run, and when
  any edit failed no file is written. `--check` prints the same output and
  exit code and writes nothing. Parse errors are raised while reading the
  whole patch, before any file is looked at.
- **Files and line breaks (§3).** A file's break (CRLF vs LF) is taken from
  its first line feed; a changed file keeps its own break and its final break
  unless §6 says otherwise; a created file uses LF and ends with a break
  unless its format says otherwise; a JSON `create` writes `file_text` byte
  for byte.

## Verification

Run from this directory (Node 22+; the practice set lives in the kit):

```
node check.ts ../hidden-spec-cli-01-run-20261122-kit/unpacked/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json
```

Results, 22 Nov 2026:

- **Practice set: 100 of 100 passed — practice score 1000.**
  (unified 30, search_replace 20, v4a 20, json 15, cli 15.)
- **36 extra hand-made checks passed** (kept in `/tmp/mend-extra.mjs`, not
  part of the entry): created files with/without a final break, hunks
  touching the end of a file, `--- ` without `+++ ` in a header, malformed
  `diff --git`, rename-only moves, `deleted file mode`, multi-file output
  sorting with a move, SEARCH/REPLACE creation and previous-path reuse,
  V4A Add/Delete/pure-move/no-chunk cases, anchor and end-of-file failures,
  usage errors, `--check` writing nothing, atomicity (one failing edit blocks
  the good one), unsafe move paths, JSON `create` byte-for-byte.
- **Determinism:** the full practice run twice gives byte-identical output,
  and one single case run twice in fresh directories gives byte-identical
  files and stdout.
- **Limits:** `main.ts` is 32,573 bytes (925 lines); the whole tree is
  41,554 bytes — inside the 1 MiB per file / 4 MiB total limits. No
  dependency outside the Node standard library and the kit's own `runner.ts`;
  no `.git` directory inside the entry.

## What is NOT done here (left to the parent run)

- No GitHub repository has been created for this entry, no commit, no
  `makefun bundle`, no submit. Those steps are blocked pending the user's
  approval (user said "Skip dulu" 21 Nov 2026); the parent agent owns the
  repo (via the GitHub Contents API), the bundle and the submit in a later
  run if approval comes.
