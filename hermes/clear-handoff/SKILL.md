---
name: clear-handoff
description: "Save a curated handoff so a fresh session can resume work."
version: 1.0.0
author: Hermes Agent (port of STRML/cc-clear-handoff)
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [handoff, resume, context, compact, session]
    related_skills: [resume-handoff, hermes-agent]
---

# Clear-Handoff (Hermes port)

Save a **curated handoff file** — exactly what a fresh session needs to resume this work
with zero loss of intent — so it can be loaded after `/new` or `/clear`. A deliberate
alternative to lossy `/compact`: you hand-pick only what the next session needs, save it to
disk (so it can't get lost), and the companion `resume-handoff` skill auto-loads it.

**Hermes-native port of [STRML/cc-clear-handoff](https://github.com/strml/cc-clear-handoff).**
This subdirectory is the Hermes delivery of this repo. Because Hermes has no one-shot
SessionStart-hook parity, the "auto-load" is a durable file in a well-known place that
`resume-handoff` picks up on the user's `resume`/`go` — lossless, copy-paste-free.

## When to use

- Context is getting long and you'd otherwise reach for `/compact`. Use this instead.
- Handing a long-running chunk of work to a fresh session without losing the thread.

## Rules

- **Don't stop or wait.** This must work at any moment, including while background delegations
  are still running. Snapshot state as it is right now; never block on a subagent.
- **Capture intent, don't summarize the transcript.** Working state (goal, decisions, next
  steps, gotchas), not a play-by-play.
- **Reference, don't duplicate.** Point to files by `path:line`, PRs/issues by number. Don't
  paste content that already lives in an artifact — the fresh session can read it.
- **No fabricated identifiers.** Every SHA, PR number, path, and line number must come from a
  command you actually ran this turn, or earlier in this conversation. Look it up or omit it.
- If the user supplied a focus phrase, bias the handoff toward it.

## Gather (fast, parallel, read-only)

- **Running/background work:** `process(action='list')` for background `terminal` runs; note
  any in-flight `delegate_task` delegations you know about. Record each one's job, status, and
  **where its output lands** (file/branch/PR) — old Task IDs don't survive a fresh session, so
  trust the output location, not the id. Don't stop them.
- **Repo state** (if in a git repo): current branch, `git rev-parse --short HEAD`,
  `git status --porcelain`, open PRs (`gh pr list --author @me`) if relevant.
- Any plan file, scratchpad, or skill in play — reference by path.

## Emit

Build the handoff with the template below. Fill only sections that apply — delete empty ones,
keep it tight (a scalpel, not `/compact`). **Write it to the file; don't dump the full block
inline.**

```
# Handoff — <one-line mission>

**Resume this work.** Read the referenced files before acting.

## Where we are
<2-4 sentences: what's done, what's in progress right now, what's blocked.>

## In-flight work (drive via output, not old IDs)
- <job> — <what it's doing> — output lands in <file / branch / PR>. Old id <task-id> is dead after /new; check the output instead.
<omit section if none>

## Key files & locations
- `path/to/file.ts:NN` — <why it matters>

## Decisions made (and why)
- <decision> — <rationale, so the next session doesn't relitigate it>

## Next steps (ordered)
1. <specific action> — <expected outcome>

## Gotchas / dead ends
- <thing that bit us, or an approach already ruled out and why>

## Resume commands
cd <dir> && git checkout <branch>   # HEAD was <short-sha>

## Skills to invoke
- <skill> — <when/why>

## References (read, don't re-derive)
- Plan: <path>   PR: #<n>   Issue: #<n>
```

## Save

Always write to disk — never print the full block, never skip the file.

1. **cwd-scoped copy:** `$(pwd)/.tmp/handoff-$(date +%Y%m%d-%H%M%S).md` (mkdir -p first). Keeps
   it out of the repo root and out of git. Never a bare/relative name, never `mktemp -t`.
2. **Hermes registry copy:** also write to `$HERMES_HOME/handoffs/latest.md` (mkdir -p) so
   `resume-handoff` can find it from any cwd. Note the timestamp so `latest.md` is regenerate-able.

## Prompt

Print only a short fallback (never the full block):

> Handoff saved → `<absolute path>`
> Next session: say **resume** — it loads automatically.
