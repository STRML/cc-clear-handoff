# cc-clear-handoff

A focused, **un-loseable** alternative to `/compact` for [Claude Code](https://claude.com/claude-code).

`/compact` summarizes your whole transcript lossily and unfocused. `/clear-handoff` instead writes a **curated handoff** — only what the next session actually needs — saves it to a file, and **auto-loads it into the next session after you `/clear`**. Nothing to copy, nothing to lose.

## Why

The usual "context is getting long" options both hurt:

- **`/compact`** keeps everything, badly. It re-summarizes the entire transcript, drops the details that mattered, and you can't steer what survives.
- **Manual handoff docs** are focused but fragile. You write one, run `/clear`, and then have to remember to paste it back — and remember *where you saved it*.

`/clear-handoff` fixes both: you (well, the model) hand-pick the state that matters, and a one-shot `SessionStart` hook injects it automatically the moment you start the next session in that directory. Then it deletes itself, so it fires exactly once.

## How it works

```
/clear-handoff                         next session (after /clear)
─────────────                          ─────────────────────────────
1. gather live state (read-only):      SessionStart hook fires:
   TaskList, git branch/HEAD/status      • realpath(cwd) → find matching sentinel
2. write curated handoff to             • inject handoff into context + banner
   $(pwd)/.tmp/handoff-<timestamp>.md    • delete sentinel (single-use)
3. arm a sentinel keyed to the cwd     → you're resumed, automatically
   under ~/.claude/tmp/pending-handoffs
4. print a 2-line fallback prompt
```

The command is a prompt injection, so it runs **at any moment — even while subagents are still working** — and it never stops or blocks on them. It records what each subagent was doing and *where its output lands*, since old Task IDs don't survive a `/clear`.

### Design details worth knowing

- **cwd-scoped + single-use.** The sentinel is keyed to the working directory, so a handoff armed in project A never fires in project B. It's consumed once, then deleted.
- **realpath both sides.** The sentinel is armed under the physical cwd; the `SessionStart` payload usually carries the logical/symlinked path. Both are `realpath`'d before matching, so it works under `/tmp` → `/private/tmp`, iCloud/OneDrive, and symlinked repos.
- **Only `clear` / `startup`.** `compact` and `resume` keep the existing context — consuming the handoff there would be redundant and would steal the one-shot from the real post-`/clear` session.
- **24h TTL.** If you arm a handoff and never `/clear`, it expires instead of injecting stale "resuming X" context into some unrelated session days later.

## Install

Add the marketplace and install the plugin:

```
/plugin marketplace add STRML/cc-clear-handoff
/plugin install cc-clear-handoff
```

Requires `python3` (preinstalled on macOS and most Linux).

## Usage

When context is getting long, instead of `/compact`:

```
/clear-handoff
```

Optionally focus the handoff for the next session:

```
/clear-handoff finish the CR loop on PR 42
```

Then run `/clear`. The handoff loads automatically. (If it ever doesn't, the command also prints a one-line fallback you can paste: `Resume from <path>`.)

## Files

```
cc-clear-handoff/
├── commands/clear-handoff.md      the /clear-handoff command
├── hooks/clear-handoff-load.py    SessionStart auto-loader (one-shot, cwd-scoped)
└── hooks/hooks.json               registers the hook
```

## License

MIT © Samuel Reed
