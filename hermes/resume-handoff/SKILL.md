---
name: resume-handoff
description: "Resume work from a saved clear-handoff file automatically."
version: 1.0.0
author: Hermes Agent (port of STRML/cc-clear-handoff)
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [handoff, resume, context, session]
    related_skills: [clear-handoff, hermes-agent]
---

# Resume-Handoff

Load the most recent `clear-handoff` and pick the work back up. Trigger on a bare
`resume`, `go`, "pick up where we left off", or "continue from the handoff". This is the
load half of the [STRML/cc-clear-handoff](https://github.com/strml/cc-clear-handoff)
workflow, mapped to Hermes: the handoff file IS the resume state, so nothing is lost across
`/new` or `/clear`.

## Steps

1. **Locate the handoff.** Resolve `$HERMES_HOME/handoffs/latest.md` (ask the user only if
   it's missing and you can't find a `.tmp/handoff-*.md` in the cwd). Project-scoped handoffs
   may also live at `$(pwd)/.tmp/handoff-*.md` — prefer the most recently modified one.
2. **Read it fully.** Do not act on a summary; read the actual file.
3. **Recap, then act.** Open with a one-line recap naming what we were working on (the
   handoff's mission line), then immediately continue from its **Next steps** — act on them,
   don't re-print the whole handoff back.
4. **Read referenced files before acting.** The handoff points at files by `path:line`; read
   them rather than re-deriving.
5. **In-flight work caveat.** Any background jobs listed in the handoff belonged to the
   PREVIOUS session. Old IDs don't route here. Check the output locations they named (files,
   branches, PRs) instead — `process(action='list')` shows only *this* session's background
   runs. Don't drive stale IDs.

## Notes

- A handoff is single-use intent, not a transcript — if the user says "start fresh" instead
  of resuming, don't force it. If they want to keep resuming repeatedly, offer to fold the
  still-relevant remainder into a fresh `clear-handoff`.
