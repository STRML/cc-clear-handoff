---
description: Save a focused handoff file for resuming this exact work in a fresh session, and arm a one-shot SessionStart hook that auto-loads it after /clear — a precise, un-loseable alternative to the lossy /compact. Safe to run while subagents are working.
argument-hint: "[optional: what the next session should focus on]"
allowed-tools: Bash, Read, TaskList, TaskGet, Write
---

You are producing a **handoff**: a curated file capturing exactly what a fresh session needs to resume this work with zero loss of intent, plus an armed one-shot hook that auto-injects it after `/clear`. This is a deliberate alternative to `/compact` — `/compact` summarizes the whole transcript lossily and unfocused; you are hand-picking only what the next session needs. You always save it to a file (so it can't get lost) and arm the auto-loader; the user gets one short line to copy as a manual fallback.

## Rules

- **Do not stop or wait for anything.** This command must work at any moment, including while subagents are mid-flight. Never call `TaskStop`, never block on a subagent finishing. Snapshot state as it is right now.
- **Capture, don't summarize the transcript.** Include the live working state (goal, decisions, next steps, gotchas), not a play-by-play of the conversation.
- **Reference, don't duplicate.** Point to files by `path:line`, PRs/issues by number, plans/PRDs/ADRs by path. Do not paste content that already lives in an artifact — the next session can read it.
- **No fabricated identifiers.** Every SHA, PR number, path, Task ID, and line number must come from a command you actually ran this turn (`git rev-parse HEAD`, `TaskList`, etc.) or from earlier in *this* conversation. Look it up or omit it.
- If `$ARGUMENTS` is present, treat it as the focus for the next session and bias the handoff toward it.

## Gather (fast, parallel, read-only)

Run only what's relevant to this session:

- Running/recent subagents: `TaskList` — record each agent's job, status, and **where its output lands** (file/branch/PR). Old Task IDs don't survive `/clear`, so capture the output location, not just the id. (A background subagent may still answer a bare-name `SendMessage` after `/clear`, but it's unreliable — the output location is what the next session should trust.) **Do not stop them.**
- Repo state (if in a git repo): current branch, `git rev-parse --short HEAD`, `git status --porcelain`, and open PRs if relevant (`gh pr list --author @me` per the resume-notes convention).
- Any plan file, scratchpad, or codemaps in play — reference by path.

## Emit

Build the handoff content using the template below. Fill in only the sections that apply — delete empty ones, don't pad. Keep it tight; this is a scalpel, not `/compact`. **Do not print the full block inline** — it goes in the file.

```markdown
# Handoff — <one-line mission>

**Resume this work.** Read the referenced files before acting.

## Where we are
<2–4 sentences: what's done, what's in progress right now, what's blocked.>

## Running subagents (drive via output, not old IDs)
- <agent type> — <what it's doing> — output lands in <file / branch / PR>. Old id `<task-id>` is dead after `/clear`; check the output instead.
<omit section if none>
<record what each was DOING and WHERE its result lands, not just the id — old Task IDs don't route after /clear. A background subagent may still reply to a bare-name SendMessage, but don't rely on it; trust the output location.>

## Key files & locations
- `path/to/file.ts:NN` — <why it matters>
- ...

## Decisions made (and why)
- <decision> — <rationale, so the next session doesn't relitigate it>

## Next steps (ordered)
1. <specific action> — <expected outcome>
2. ...

## Gotchas / dead ends
- <thing that bit us, or an approach already ruled out and why>

## Resume commands
```bash
cd <dir> && git checkout <branch>   # HEAD was <short-sha>
<any exact command to get back to work>
```

## Skills to invoke
- `<skill>` — <when/why>

## References (read, don't re-derive)
- Plan: <path>   PR: #<n>   Issue: #<n>   Codemaps: <dir>
```

## Save (always) + arm auto-load

You **always** save the handoff to a file and arm the SessionStart auto-loader — never print the full block inline, never skip the file.

1. **Resolve an absolute path under `.tmp/` in the cwd.** Compute the target as `"$(pwd)/.tmp/handoff-$(date +%Y%m%d-%H%M%S).md"`, and `mkdir -p "$(pwd)/.tmp"` first. Handoffs are ephemeral, single-use session state — `.tmp/` keeps them out of the repo root and (being gitignored) out of version control. Never a bare/relative name and never a system temp dir (`mktemp -t` lands in `$TMPDIR`, not the cwd — that's the bug this avoids). Capture the resolved value; you'll echo it back.
2. **`Write` the handoff content to that absolute path.**
3. **Arm the auto-loader.** Drop a sentinel so the `clear-handoff-load.py` SessionStart hook injects this handoff into the next session in this directory (and then deletes itself — single use). Run, substituting the real absolute handoff path:
   ```bash
   HF="<absolute-handoff-path>"
   ENC=$(python3 -c "import re,os;print(re.sub(r'[/.]','-',os.path.realpath(os.getcwd())).strip('-'))")
   mkdir -p ~/.claude/tmp/pending-handoffs
   printf '%s' "$HF" > ~/.claude/tmp/pending-handoffs/$ENC.path
   ```
   The hook only consumes this on a `clear`/`startup` SessionStart in the same directory, and it expires after 24h — so arm it right before you `/clear`, not hours ahead.

Then print **only a very short prompt** — nothing else, no inline dump. Exactly:

> Handoff saved → `<absolute-handoff-path>`
> Run `/clear` — it auto-loads in the fresh session. If it doesn't, paste: **`Resume from <absolute-handoff-path>`**
