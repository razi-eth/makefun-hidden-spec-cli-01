# mend

One patch tool for every AI edit format. `mend` applies an AI-written
edit to a tree of text files, to SPEC.md v1 (see the kit's starter):
unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks,
V4A patches, and JSON tool calls. It finds the lines an edit names at
the first of three matching tiers (exact, trailing whitespace, leading
and trailing whitespace), and changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or
  `auto` (the default, which detects the format).
- `--check`: dry run — the same output and exit code, no writes.
- `--strict`: exact (tier 0) matching only.
- `PATCH`: the patch file, or `-`/absent for standard input.

Exit 0 prints one line per changed path (`A`/`D`/`M`/`R`) and
`ok: N files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: k of n edits`, and writes nothing. Exit 2
prints exactly one `error:` line (usage, no-patch, format, parse).

Node 22 and its standard library alone. `runner.ts` runs a trial:
when `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
