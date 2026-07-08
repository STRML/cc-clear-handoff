#!/usr/bin/env python3
"""SessionStart hook: auto-load a pending /clear-handoff into the fresh session.

/clear-handoff writes the handoff to a file in the cwd AND drops a sentinel at
~/.claude/tmp/pending-handoffs/<encoded-cwd>.path containing that file's absolute
path. On the next `clear`/`startup` SessionStart in the SAME cwd, this hook finds
the sentinel, injects the handoff into context + shows a banner, then deletes the
sentinel so it fires exactly once. Can't get lost across a /clear.
"""
import json
import os
import re
import sys
import time

TTL_SECONDS = 24 * 3600  # stale sentinels expire — don't fire days later

def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)  # no/garbage input — do nothing

    # Only a genuine fresh session should consume the handoff. `compact` keeps
    # the existing context (injecting would be redundant + steal the one-shot),
    # and `resume` reattaches an old session — neither is the post-/clear case.
    if data.get("source") not in ("clear", "startup"):
        sys.exit(0)

    # realpath BOTH sides: os.getcwd() (used to arm) is physical, but the
    # SessionStart payload's cwd is often the logical/symlinked launch path.
    # Without this they mismatch under /tmp, iCloud/OneDrive, symlinked repos.
    cwd = os.path.realpath(data.get("cwd") or os.getcwd())
    encoded = re.sub(r"[/.]", "-", cwd).strip("-")
    sentinel = os.path.expanduser(
        f"~/.claude/tmp/pending-handoffs/{encoded}.path"
    )
    if not os.path.isfile(sentinel):
        sys.exit(0)  # nothing pending for this directory

    # Single-use: remove the sentinel now, whatever happens next.
    try:
        handoff_path = open(sentinel).read().strip()
        armed_at = os.path.getmtime(sentinel)
    except Exception:
        handoff_path, armed_at = "", 0.0
    try:
        os.remove(sentinel)
    except OSError:
        pass

    if not handoff_path or not os.path.isfile(handoff_path):
        sys.exit(0)

    age = time.time() - armed_at
    if age > TTL_SECONDS:
        sys.exit(0)  # stale — expired, don't inject wrong "resuming" context
    age_str = f"{int(age // 3600)}h ago" if age >= 3600 else f"{int(age // 60)}m ago"

    try:
        handoff = open(handoff_path).read()
    except Exception:
        sys.exit(0)

    banner = f"📋 Handoff loaded ({age_str}) from {handoff_path}. Say 'resume' to pick up where you left off."
    context = (
        f"A /clear-handoff (armed {age_str}) was pending for this directory and "
        "has been auto-loaded below. On the user's next message — even a bare "
        "'resume'/'go' — immediately continue from the handoff's Next steps: act, "
        "don't summarize the handoff back or re-orient. Read any referenced files "
        "before acting. NOTE: any subagents listed in the handoff belonged to the "
        "PREVIOUS session and are NOT reattachable after /clear — do not SendMessage "
        "or TaskGet their old IDs; instead check the outputs the handoff says they "
        f"were producing (files, branches, PRs).\n\n--- HANDOFF ({handoff_path}) ---\n{handoff}"
    )
    print(json.dumps({
        "systemMessage": banner,
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        },
    }))
    sys.exit(0)

if __name__ == "__main__":
    main()
