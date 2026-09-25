# ccflaky 🔧

**Which tools Claude actually uses — and which ones silently fail on you.**

A failing tool is invisible in normal use: Claude retries, works around it, and
you never learn that your test command errors 40% of the time. ccflaky pairs
every `tool_use` with its result and counts what happened.

Not a usage dashboard. `ccusage` already answers "what did I spend"; this
answers "what quietly didn't work" — which tool, how often, and with what
error text. Counting tool calls is not the point: each call is matched to its
result by `tool_use_id`, so a failure is attributed to the exact call that
produced it even when calls run in parallel.

```
$ ccflaky
=== ccflaky — 352 calls, 5.7% error ===

  Bash                 126 ████████████████████████  ⚠️ 16 err (12.7%)
  Write                 95 ██████████████████······  ⚠️ 1 err (1.1%)
  Edit                  63 ████████████············
  AskUserQuestion        6 █·······················  ⚠️ 3 err (50%)
```

That last line is the point: a tool failing half the time, discovered only because
something counted it.

> Also for Codex CLI, Gemini CLI and Cursor: [agstats](https://github.com/sue738/agstats) reads every agent's transcripts side by side (`npx agstats tools --suggest`, `npx agstats guards`).

```bash
ccflaky                    # all time
ccflaky --days 7           # recent
ccflaky --daily            # per-day breakdown (add --json for machine-readable)
ccflaky --project NAME     # only projects whose path matches NAME
ccflaky --failures         # show the actual error text
ccflaky --json
ccflaky --base-dir DIR     # scan a different transcript root

ccflaky --suggest                       # tools crossing a failure threshold,
                                            # errors clustered by type
ccflaky --suggest --min-calls 5 --min-rate 20   # threshold (these are the defaults)
ccflaky --suggest --memory-dir DIR      # flag whether each tool's name already
                                            # appears in DIR/*.md (optional)
```

### `--suggest`: which tools are worth actually fixing

Knowing a tool fails isn't the same as knowing *why*. `--suggest` flags tools
that cross a threshold (default: 5+ calls, 20%+ error rate — chosen from real
data, where normal tools sit under 1% and problem tools sit at 20%+, a wide
enough gap to separate noise from a real pattern) and groups their failures by
type — a JSON error's `code`/`name`, or the first line of its `message` with
IDs and numbers normalized out — so 20 identical failures show up as one
cluster of 20, not 20 lines to read.

It stops there deliberately: clustering is deterministic (no LLM, no
guessing), but summarizing *why* a cluster happens and deciding whether it's
worth a fix belongs to you or your agent, not a script. `--memory-dir` is the
one optional bridge — point it at wherever you keep notes on tools you've
already investigated, and already-flagged tools get marked so you don't
re-diagnose the same failure twice.

## Install

```sh
npm install -g ccflaky
```

Or run it once without installing: `npx ccflaky`. To build from source:
`git clone https://github.com/sue738/ccflaky.git && cd ccflaky && npm link`.

Output is English by default; set `CCFLAKY_LANG=ja` (or `LANG=ja_JP.UTF-8`) for Japanese.

## Notes

- Errors are matched by `tool_use_id`, so a result is attributed to the exact call
  that produced it — not guessed by position.
- Subagent (sidechain) tool calls are excluded; this is your main loop.
- Reads local transcript files under `~/.claude/projects` and nowhere else.
  Read-only, zero dependencies.

## Security & trust

A tool that inspects your sessions deserves maximum suspicion, so:

- **Zero dependencies, no postinstall, no build step** — read it first, it's short
- **Fully local** — nothing leaves your machine, no telemetry, no network calls
- **Read-only** — it never modifies a transcript
- Paranoid path: `git clone https://github.com/sue738/ccflaky.git && node ccflaky/bin/ccflaky.js`

## License
MIT
