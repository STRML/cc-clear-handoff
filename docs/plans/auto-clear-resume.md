# Plan: auto-clear and auto-resume for /clear-handoff

Branch: `feat/auto-clear-resume`. Prior art: seanperkins/cc-build-handoff (`hooks/register.ts`),
which automates the same two keypresses for a Mnemopi build handoff. Revision 2 adopts every
finding of the Gemini 4 Neon review (round 1).

## Goal

`/clear-handoff [directive]` finishes with no keypress. The turn that saves the handoff ends, the
session runs `/clear`, and the fresh session starts working. `/clear-handoff build it` means: save
the handoff, clear, and build it in the fresh session.

Out of scope: model routing (cc-build-handoff's `turn.step` rewrite), Mnemopi, Hermes delivery.
The Python SessionStart loader stays the only thing that injects the handoff. A person's own
`/clear` and a plain `claude` startup keep working with the mod absent or mid-reload.

## Shape

```
/clear-handoff turn (main loop)                    fresh session
───────────────────────────────                    ─────────────
1 Write handoff; "## Directive" = $ARGUMENTS
2 Bash arms sentinel, prints                       5 clear-handoff-load.py injects the
  "clear-handoff armed: <abs path>"                  handoff; its context says a
  → tool.call hook: armed = {path, turnId}           Directive, when present, runs first
3 turn.complete(reason answer, same turn,          6 mod submits, as the user:
  no helpers running)                                "Resume from <path>"
4 $.command.run('clear') from clock.after(0)
```

Parts:

1. `hooks/register.ts`: a mod module (function hooks), listed under `modules` in
   `hooks/hooks.json` beside the existing classic SessionStart hook. `claude plugin validate .`
   passes with both entries.
2. `commands/clear-handoff.md`:
   - The arm step appends `&& echo "clear-handoff armed: $HF"` in the same Bash call.
   - When `$ARGUMENTS` is present, the handoff's first section is `## Directive`, holding it
     verbatim. Nothing about the directive goes on the wire: the resume prompt is always
     `Resume from <path>`, and the handoff file carries the intent.
   - The closing print says the session clears itself, and the turn ends right after it.
3. `hooks/clear-handoff-load.py`: its `additionalContext` tells the model to carry out a
   `## Directive` first when the handoff has one. This covers a manual `/clear` too.
4. README: the flow, what cancels it, the helpers rule, the `--plugin-dir` dev loop, and tests.

## Arming rules

The mod arms on a `tool.call` for `Bash` only when all of these hold:

- the call is the main loop's (no `agentId`);
- `e.command` contains `pending-handoffs` (the arm step), so unrelated output that happens to
  print the marker never arms;
- the result is not denied and not an error;
- the last line starting with `clear-handoff armed: ` holds an absolute path (spaces allowed);
- the mod saw this turn's `turn.start`. After a mid-turn reload it has not, so it does not arm
  and toasts that `/clear` loads the handoff by hand.

An arm command that fails or is denied disarms an earlier arm in the same turn. It never falls
back to an older handoff.

## Helpers rule (replaces the round-1 wait gate)

A background subagent's result arrives as a task notification, which starts a new main-loop turn
in the old session. Work done in that turn is missing from the handoff already written, so
clearing after it would discard it. The mod therefore never waits.

On the armed turn's `turn.complete`, when `$.agent.list()` holds any main-loop child (no
`parentId`) whose `taskStatus` is `running` or `pending`, the mod skips the auto-clear, keeps the
sentinel armed, and toasts "N helpers running; not auto-clearing. Run /clear when ready."

Background `Bash` tasks are not agents and are not checked: the handoff records where their output
lands, and the command's rules already say so.

## Cancellation rules

Only a person cancels: a `prompt.submit` whose origin is `composer` or `bridge`, or a person's
`/clear`. A `task-notification` or other non-person prompt never cancels by itself; if it starts a
new main-loop turn while our `/clear` is queued, `turn.start` aborts the launch.

- A person's prompt while armed disarms, whatever turn it names.
- A person's `/clear` while our launch is in flight sets the abort, so the queued `/clear` never
  runs a second time on the fresh session.
- Another plugin's `/clear` while ours is queued is let through, and the SessionStart it raises
  is not ours to consume (ported `foreignClear` guard).
- An abort that reaches SessionStart after our `/clear` already ran toasts that the resume was not
  sent.

## Failure matrix

Each row becomes a red test in `hooks/register.test.ts` (`claude plugin test .`) before the code
it covers changes.

| # | Situation | Expected |
|---|---|---|
| 1 | Arm Bash succeeds, turn ends with `answer`, no helpers | One `/clear`, then `Resume from <path>` submitted after SessionStart(clear) |
| 2 | Arm Bash fails or is denied | Nothing armed, no clear |
| 3 | Bash output prints the marker but the command has no `pending-handoffs` | Not armed |
| 4 | Marker printed by a subagent's Bash | Ignored |
| 5 | Marker path is relative | Not armed |
| 6 | Marker path has spaces; two marker lines | Last line's full path is used |
| 7 | Second arm in the turn fails after a first succeeded | Disarmed; no clear |
| 8 | Arm without a seen `turn.start` (mid-turn reload) | Not armed; toast says /clear by hand |
| 9 | Turn ends `aborted` (Esc), `error`, or `refusal` | No clear; toast says run /clear |
| 10 | Helpers running at turn end | No clear; toast; sentinel untouched |
| 11 | Person prompt during the armed turn, with or without `turnId` | No clear; their prompt runs |
| 12 | Task notification during the armed turn | Still clears at turn end |
| 13 | Person prompt after the turn, before the queued /clear runs | Our /clear is dropped |
| 14 | A new main-loop turn starts while our /clear is queued | Our /clear is dropped |
| 15 | Person runs /clear while armed, before the launch | Mod stands down; loader still injects; no auto prompt |
| 16 | Person runs /clear while our launch is in flight | Exactly one /clear runs; no auto prompt |
| 17 | Another plugin's /clear while ours is queued | Its SessionStart is skipped; ours still submits |
| 18 | SessionStart with source `startup`, `compact`, or `resume` while launching | No submit |
| 19 | Abort reaches SessionStart after our /clear ran | No submit; toast |
| 20 | SessionStart(clear) over 2 minutes after our /clear was queued | No submit |
| 21 | Person types in the fresh session before our submit | Our submit is skipped |
| 22 | Task notification in the fresh session before our submit | Our submit still goes |
| 23 | Our submit is refused or throws, box empty | Box filled with the prompt; toast says press Enter |
| 24 | Our submit is refused, box holds text | Box untouched; toast names `Resume from <path>` |
| 25 | `$.command.run` rejects | Toast; nothing left armed |
| 26 | Armed in turn t1; turn t2 starts with no launch | Armed state dropped |

## Verification

1. `claude plugin validate .`. `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which
   the engine writes when it loads the mod; `tsc -p .` runs locally after a load and is not a CI
   gate.
2. `claude plugin test .` with every row green, and `python3 -m pytest tests` still green.
3. Live run in `claude --plugin-dir .`: in a scratch repo, `/clear-handoff write hello.txt` ends in
   a fresh session that writes the file with no keypress. Record the transcript path.

## Ship

Bump to 0.3.0 in `plugin.json` and `marketplace.json`, open a PR to `main`, wait on CI and
CodeRabbit, then merge. Credit cc-build-handoff in the README, as it credits this repo.
