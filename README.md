# cc-clear-handoff

A focused, **un-loseable** alternative to `/compact` for [Claude Code](https://claude.com/claude-code).

`/compact` summarizes your whole transcript lossily and unfocused. `/clear-handoff` instead writes a **curated handoff** — only what the next session actually needs — saves it to a file, then **clears the session and resumes from the handoff by itself**. Nothing to copy, nothing to lose, no keypress.

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
   $(pwd)/.tmp/<work-slug>-<timestamp>.md • delete sentinel (single-use)
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

Or in one step: `/plugin install cc-clear-handoff --marketplace STRML/cc-clear-handoff`.

Requires `python3` (preinstalled on macOS and most Linux).

## Usage

When context is getting long, instead of `/compact`:

```
/clear-handoff
```

`/handoff` is an alias for the same command. Add `don't clear` (or `--no-clear`) to save the handoff without clearing, for example when you hand off to another account or harness: `/handoff don't clear`.

Other agent harnesses (OMP, Codex) get the same procedure from `shared-skills/clear-handoff` and its `handoff` alias: link both into `~/.agents/skills/`. There the handoff is saved and you start the fresh session yourself.

Add an instruction for the next session after the command. It goes into the handoff as its `## Directive`, and the fresh session carries it out first:

```
/clear-handoff build it
/clear-handoff finish the CR loop on PR 42
```

You don't run `/clear` yourself. When the turn that saved the handoff ends, the plugin clears the session and sends `Resume from <path>` as the fresh session's first prompt. If it ever doesn't, run `/clear` (the handoff still loads) or paste the fallback line the command prints.

## Hands-free clear and resume

```
you type /clear-handoff ─▶ this turn may clear       fresh session
Write .tmp/<name>.md ok   ─▶ handoff = that path      ─────────────
arm step writes sentinel                             clear-handoff-load.py injects
turn ends with an answer                               the handoff (as before)
  handoff non-empty, sentinel new + names it ─▶ /clear ─▶ plugin sends "Resume from <path>"
```

A function-hook module (`hooks/register.ts`) does the two keypresses. It decides from what it can observe, never from the model's text: your command, the `Write` tool's own result, and the files on disk at the moment of the clear. When any check fails it says so and leaves the `/clear` to you. Anything you do yourself wins over it:

| You do this | The plugin |
|---|---|
| Send a prompt (or ping from Slack) while the handoff turn runs | does not clear |
| Press Esc before the turn ends, or the turn ends in an error or refusal | does not clear; run `/clear` when ready |
| Run `/clear` yourself | stands down; the handoff still loads |
| Type in the fresh session before the resume prompt goes | does not send it |

Background subagents keep running across the clear, so the plugin does not wait for them. The handoff records where each one's output lands.

The approach comes from [cc-build-handoff](https://github.com/seanperkins/cc-build-handoff) by Sean Perkins, which automated the same two steps for a build handoff.

## Develop

```
claude --plugin-dir ~/git/oss/cc-clear-handoff   # a session with this working copy loaded
claude plugin validate .                          # manifest, command and hook module
claude plugin test .                              # the mod's tests (hooks/register.test.ts)
python3 -m unittest discover -s tests             # the loader's tests
```

## Files

```
cc-clear-handoff/
├── commands/clear-handoff.md      the /clear-handoff command
├── commands/handoff.md            /handoff, an alias for it
├── shared-skills/                 clear-handoff + handoff for OMP, Codex, any harness
├── hooks/clear-handoff-load.py    SessionStart auto-loader (one-shot, cwd-scoped)
├── hooks/register.ts              function hooks: auto /clear and resume prompt
├── hooks/register.test.ts         its tests (claude plugin test .)
└── hooks/hooks.json               registers the loader and the module
```

## License

MIT © Samuel Reed
