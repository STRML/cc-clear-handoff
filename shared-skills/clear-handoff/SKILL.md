---
name: clear-handoff
description: Save a focused handoff file for resuming this exact work in a fresh session, a precise alternative to a lossy /compact. Works in any agent harness (OMP, Codex, Claude Code). Use when context is getting long, before /clear or /new, or when the user says "handoff", "clear-handoff", or "hand this off".
argument-hint: "[optional: what the next session should do]"
---

# Clear-handoff

Follow the procedure in `commands/clear-handoff.md` of the cc-clear-handoff repo this skill
ships in (if that file is not on disk, for a copied install, read it from
https://github.com/STRML/cc-clear-handoff/blob/main/commands/clear-handoff.md), with `$ARGUMENTS` as the user's instruction for the next session. This skill folder
is usually a symlink: resolve this SKILL.md's real path (`realpath`), and the command is
`../../commands/clear-handoff.md` from there. That file is the single source of truth for what goes in a handoff, where it
is saved, and how it is armed. Read it fully before acting.

Harness differences:

- **Claude Code** with the cc-clear-handoff plugin: the plugin's `/clear-handoff` command
  runs this procedure and clears the session by itself. Prefer the command there.
- **Any other harness** (OMP, Codex): run the same steps, including the arm step: the next
  Claude Code session started in this folder within 24 hours loads the handoff, and a resume
  anywhere else removes the sentinel first (the handoff's own resume line says how). Nothing clears or resumes by itself. End with:

  > Handoff saved → `<absolute-handoff-path>`
  > Start a fresh session (`/new` or `/clear`) and send: **`Resume from <absolute-handoff-path>`**

Ignore the command's Claude Code-only parts here: its closing message (use the one above), its line
about ending the turn for the auto-clear, and `TaskList`/`TaskGet` if the harness has no task list.
Use the tools the harness has for the same jobs: its file-write tool to write the handoff,
its shell to arm it, its task list (if any) to record running subagents.
