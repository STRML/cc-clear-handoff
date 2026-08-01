# Hermes support for cc-clear-handoff

This `hermes/` directory is the Hermes delivery of this repo: self-contained Hermes skills
that reproduce the curated-handoff → auto-resume workflow without Claude Code's
`/compact`-lossiness.

- `clear-handoff/` — save a curated handoff (cwd-scoped `.tmp/handoff-*.md` + a
  `$HERMES_HOME/handoffs/latest.md` registry copy) so nothing is lost across `/new`/`/clear`.
- `resume-handoff/` — load the latest handoff on `resume`/`go` and continue from its next steps.

## Install in Hermes

```bash
hermes skills install ./hermes/clear-handoff ./hermes/resume-handoff
```

### Mapping vs the Claude Code plugin

Claude Code arms a one-shot SessionStart hook that auto-injects the handoff after `/clear`.
Hermes has no hook parity, so the load half is the explicit `resume` trigger reading
`$HERMES_HOME/handoffs/latest.md` — same durable, copy-paste-free outcome via a word instead
of a hook. The handoff template and capture rules are unchanged.
