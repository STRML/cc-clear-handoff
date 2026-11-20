---
description: Save a focused handoff file, then clear this session and resume from the handoff by itself (or arm it for a manual /clear). A precise, un-loseable alternative to the lossy /compact. Safe to run while subagents are working.
argument-hint: "[optional: what the next session should do, e.g. build it]"
allowed-tools: Bash, Read, TaskList, TaskGet, Write
---

You are producing a **handoff**: a curated file capturing exactly what a fresh session needs to resume this work with zero loss of intent, plus an armed one-shot hook that auto-injects it after `/clear`. This is a deliberate alternative to `/compact` — `/compact` summarizes the whole transcript lossily and unfocused; you are hand-picking only what the next session needs. You always save it to a file (so it can't get lost) and arm the auto-loader; the user gets one short line to copy as a manual fallback.

## Rules

- **Do not stop or wait for anything.** This command must work at any moment, including while subagents are mid-flight. Never call `TaskStop`, never block on a subagent finishing. Snapshot state as it is right now.
- **Capture, don't summarize the transcript.** Include the live working state (goal, decisions, next steps, gotchas), not a play-by-play of the conversation.
- **Reference, don't duplicate.** Point to files by `path:line`, PRs/issues by number, plans/PRDs/ADRs by path. Do not paste content that already lives in an artifact — the next session can read it.
- **No fabricated identifiers.** Every SHA, PR number, path, Task ID, and line number must come from a command you actually ran this turn (`git rev-parse HEAD`, `TaskList`, etc.) or from earlier in *this* conversation. Look it up or omit it.
- If `$ARGUMENTS` says not to clear (`don't clear` or `don’t clear`, `no clear` or `--no-clear` as a clause of its own, followed by nothing or by punctuation; `don't clear the cache` is a Directive, not this), the plugin leaves the session as it is: the user is handing off to another account or harness. Leave that phrase out of the Directive, and end with the manual line below instead of saying the session clears itself.
- If `$ARGUMENTS` is present, it is the user's instruction for the next session (`/clear-handoff build it`). Put it verbatim in a `## Directive` section right after the `**Resume this work.**` line, exactly as the template shows (the loader reads a Directive only there), and bias the rest of the handoff toward it. The fresh session carries out the Directive first. Without `$ARGUMENTS`, leave the section out.

## Gather (fast, parallel, read-only)

Run only what's relevant to this session:

- Running/recent subagents: `TaskList` — record each agent's job, status, and **where its output lands** (file/branch/PR). Background subagents keep running across `/clear` under the same IDs: their notifications reach the fresh session and `SendMessage` still works. Record the id too, so the next session can drive them instead of redoing their work. **Do not stop them.**
- Repo state (if in a git repo): current branch, `git rev-parse --short HEAD`, `git status --porcelain`, and open PRs if relevant (`gh pr list --author @me` per the resume-notes convention).
- Any plan file, scratchpad, or codemaps in play — reference by path.

## Emit

Build the handoff content using the template below. Fill in only the sections that apply — delete empty ones, don't pad. Keep it tight; this is a scalpel, not `/compact`. **Do not print the full block inline** — it goes in the file.

```markdown
# Handoff — <one-line mission>

**Resume this work.** Read the referenced files before acting. Outside Claude Code, first run `[ "$(cat "<sentinel-path>" 2>/dev/null)" = "<absolute-handoff-path>" ] && rm -f "<sentinel-path>"` (keep the quotes) so a later Claude Code session does not load this handoff again; it removes the sentinel only while it still names this handoff, never a newer one.

## Directive
<$ARGUMENTS verbatim; omit this section when there are none>

## Where we are
<2–4 sentences: what's done, what's in progress right now, what's blocked.>

## Running subagents (still alive after /clear)
- <agent type> `<task-id>` — <what it's doing> — output lands in <file / branch / PR>. It keeps running; its notification arrives in the fresh session, and `SendMessage` to `<task-id>` reaches it.
<omit section if none>
<record the id, what each was DOING, and WHERE its result lands. In Claude Code they survive /clear; in a harness where they don't (a new OMP/Codex session), the output location is how the next session picks up their work.>

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

1. **Resolve an absolute path under `.tmp/` in the cwd.** Name the file for the work, not for the act of handing off: take the mission line of the handoff title and turn it into a lowercase kebab-case slug of 2-5 words (`results-pages-redesign`, `internal-links-seo`). Never `handoff`, `session`, `work`, `wip` or a bare timestamp. Compute the target as `"$(pwd)/.tmp/<slug>-$(date +%Y%m%d-%H%M%S).md"`, and `mkdir -p "$(pwd)/.tmp"` first. Handoffs are ephemeral, single-use session state — `.tmp/` keeps them out of the repo root and (being gitignored) out of version control. Never a bare/relative name and never a system temp dir (`mktemp -t` lands in `$TMPDIR`, not the cwd — that's the bug this avoids). Capture the resolved value; you'll echo it back. Also resolve the sentinel path now, for the template's resume line: `"$HOME/.claude/tmp/pending-handoffs/$(python3 -c "import re,os;print(re.sub(r'[/.]','-',os.path.realpath(os.getcwd())).strip('-'))").path"` (quoted: the name keeps any spaces in the folder path), expanded to an absolute path.
2. **`Write` the handoff content to that absolute path.**
3. **Arm the auto-loader.** Drop a sentinel so the `clear-handoff-load.py` SessionStart hook injects this handoff into the next session in this directory (and then deletes itself — single use). Run, substituting the real absolute handoff path:
   ```bash
   HF="<absolute-handoff-path>"
   ENC=$(python3 -c "import re,os;print(re.sub(r'[/.]','-',os.path.realpath(os.getcwd())).strip('-'))")
   mkdir -p ~/.claude/tmp/pending-handoffs
   test -s "$HF" && printf '%s' "$HF" > ~/.claude/tmp/pending-handoffs/"$ENC".path
   ```
   Run it from the session's launch directory. The plugin clears the session by itself only when you wrote the handoff with the `Write` tool in this turn, under `.tmp/`, and this sentinel (named for the launch directory) holds exactly its path. Otherwise it tells the user to run `/clear` by hand, and the handoff still loads.
   The hook only consumes this on a `clear`/`startup` SessionStart in the directory you armed it in, or in a parent of it inside the same git repo (so a shell that drifted into a subdirectory or `.claude/worktrees/<name>` still hands off to the launch dir), and it expires after 24h — so arm it right before you `/clear`, not hours ahead.

Then print **only a very short prompt** — nothing else, no inline dump. Exactly:

> Handoff saved → `<absolute-handoff-path>`
> When this turn ends you'll be asked whether to clear and resume now. If you wait, run `/clear` later, or paste: **`Resume from <absolute-handoff-path>`**

When the user said not to clear, print this instead:

> Handoff saved → `<absolute-handoff-path>`
> Not clearing. In the fresh session (any account or harness), send: **`Resume from <absolute-handoff-path>`**

End the turn right after printing this. Do not call any more tools: the auto-clear waits for this turn to end.
