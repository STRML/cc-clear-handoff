# Redesign: how the mod decides a handoff is armed

Review rounds 1-4 (`.git/review-gate/feat_auto-clear-resume/round-*.md`) each blocked on one
finding, C1/C16: "Arm marker is trusted without checking the handoff exists, then /clear fires
irreversibly". Every fix narrowed the check and the next round found another way through.

## The mistake behind all four rounds

The mod inferred two facts from evidence the model controls: the arm step's echoed text and file
timestamps.

| Round | Way through | Patch | Why the patch could not hold |
|---|---|---|---|
| 1 | Write fails, `printf` and `echo` still run | `test -s` + `$.fs.stat` | an old file at the path passes |
| 2 | `echo` naming README.md; stale handoff | `.tmp/` + mtime since turn start | freshness is not "this Write landed" |
| 3 | echo for any fresh `.tmp/*.md`, no sentinel | read the sentinel back | still trusts mtime for the handoff |
| 4 | old handoff touched earlier in the turn; sentinel in a subdirectory the loader never lists | (none: redesign) | same |

There are two facts to establish, and the mod can observe each directly instead of inferring it:

1. **This turn wrote the handoff.** The Write tool's own result proves it. A main-loop `Write`
   that the engine answered with no deny and no error, to an absolute `.../.tmp/*.md` path, is the
   content landing now. Echo text and mtimes are no longer read for this.
2. **The loader will consume the sentinel.** The loader (`clear-handoff-load.py`) lists only
   `*.path` files directly in `$HOME/.claude/tmp/pending-handoffs/`. The mod requires the
   sentinel's directory to equal that directory exactly (no subdirectory, no `..`), its name to
   end in `.path` with no `/`, and its content, read back, to equal the handoff path.

## Design

```
main-loop Write ok, path …/.tmp/*.md   ─▶ written = {path}       (this turn only)
Bash arm step ok, contains pending-handoffs, prints
  "clear-handoff armed: P" + "clear-handoff sentinel: S"
    P ∈ written                          ─┐
    dirname(S) == $HOME/.claude/tmp/pending-handoffs, S ends .path
    read(S).trim() == P                  ─┴▶ armed = P
turn.complete(answer, same turn)         ─▶ /clear ─▶ "Resume from P"
```

- `written` is a set reset on every main-loop `turn.start`. A Write by a subagent does not count.
- A later failed or denied Write to P in the same turn removes P from `written` and disarms.
- The mtime checks and `MTIME_SLACK_MS` are deleted. `test -s` stays in the command as a cheap
  shell-side guard, but the mod no longer relies on it.
- Every failed check toasts that nothing will auto-clear and to run `/clear` by hand.
- Cancellation, launch, and resume logic are unchanged from round 3 (they drew no blocking finding
  after round 1).

## Failure matrix (arming)

Each row is a red test before the code changes.

| # | Situation | Expected |
|---|---|---|
| A1 | Write ok to P, arm step ok, sentinel in the pending dir names P | armed; clears at turn end |
| A2 | No Write this turn; arm step echoes P (P exists on disk) | not armed; toast |
| A3 | Write to P fails or is denied; arm step echoes P | not armed; toast |
| A4 | Write ok to P in turn t1; arm step in turn t2 | not armed (set reset per turn) |
| A5 | Subagent Write to P; main-loop arm step | not armed |
| A6 | Write ok to P, then a failed Write to P, then arm step | not armed |
| A7 | Sentinel line missing | not armed |
| A8 | Sentinel in `pending-handoffs/sub/x.path` | not armed |
| A9 | Sentinel outside `$HOME/.claude/tmp/pending-handoffs` | not armed |
| A10 | Sentinel path contains `..` | not armed |
| A11 | Sentinel content names a different handoff | not armed |
| A12 | Sentinel unreadable (`$.fs.read` throws) | not armed; toast |
| A13 | `HOME` unset | not armed; toast |
| A14 | Write ok to P (path with spaces); arm ok | armed; resume prompt carries the full path |
| A15 | Write ok to a `.md` outside `.tmp/` named in the marker | not armed |

Rows 3-26 of `auto-clear-resume.md` (cancellation, launch, resume) keep their tests unchanged.

## What this costs

The mod now depends on the model calling the `Write` tool for the handoff, which the command
already instructs ("`Write` the handoff content to that absolute path"). A model that writes the
file through Bash (`cat > file`) will not arm, and the toast says to run `/clear` by hand. That
falls back to today's manual flow and never clears the wrong thing.

## Plan review (Gemini 4 Neon): rework, then revision 2

Neon rejected revision 1. Its findings and what revision 2 does about each:

| # | Finding | Revision 2 |
|---|---|---|
| P1 | The sentinel checks do not prove the loader picks this sentinel (name, repo, 24 h TTL, a newer competitor) | The mod computes the loader's own first-choice name, `encode(realpath(session cwd)).path`, and requires that file to be rewritten this turn. Verified: the mod's encoding equals `clear-handoff-load.py:21` byte for byte on this repo's path |
| P1 | A successful Write does not mean the file is still there and non-empty at clear time | All checks run in `turn.complete`, just before the launch: handoff non-empty, sentinel fresh, sentinel text equals the handoff path |
| P1 | Bash stdout still gates `/clear`, with no proof `/clear-handoff` ran | The mod reads no Bash output. A turn may clear only if the person submitted `/clear-handoff` or `/handoff` (`prompt.submit` with `command.name` matching) and that prompt started the turn |
| P2 | `..` in the handoff path | The handoff must sit directly in a directory named `.tmp`, with no `..` segment |
| P2 | Disarm after a later failed Write is underspecified | There is no separate arm step left: the last successful Write wins, and a failed Write to that path clears it |
| P2 | `turn.start` lacks an `agentId` guard | Not applied. A subagent raises no `turn.start` in this engine, and `turn.start`'s input has no `agentId` (tsc rejected it in round 1) |
| P3 | Spurious disarm on unrelated Bash | Gone with the Bash parsing |

Known limit: the loader picks the newest of the exact and in-repo descendant sentinels. A
second sentinel written later in the same turn for a subdirectory could win. The mod checks the
exact one only, and that is an accepted edge, not a gate.

Rows A7 to A10 now read: sentinel missing (A7), sentinel older than the turn (A8), sentinel
naming another handoff (A11), empty handoff (A12), handoff deleted before the turn ends (A13). A2
covers a turn not started by `/clear-handoff`. 45 tests.
