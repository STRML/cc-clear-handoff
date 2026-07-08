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

    # Pull the handoff's topic from its first markdown H1 (e.g.
    # "# Handoff — resolve the double-fire") so the banner and the resume recap
    # name the work, not just the file path. Strip a leading "Handoff —/-/:"
    # prefix so the topic reads cleanly on its own.
    topic = ""
    for line in handoff.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            topic = stripped[2:].strip()
            topic = re.sub(r"(?i)^handoff\s*[-—:]\s*", "", topic).strip()
            break

    topic_suffix = f": {topic}" if topic else ""
    banner = (
        f"📋 Handoff loaded ({age_str}){topic_suffix}. "
        f"Say 'resume' to pick up where you left off.\n   {handoff_path}"
    )
    recap_line = (
        f'open with a one-line recap naming what we were working on'
        f'{f" ({topic})" if topic else ""} so the user has their bearings, then '
    )
    context = (
        f"A /clear-handoff (armed {age_str}) was pending for this directory and "
        "has been auto-loaded below. On the user's next message — even a bare "
        f"'resume'/'go' — {recap_line}immediately continue from the handoff's Next "
        "steps: act on them, don't re-summarize the whole handoff back. Read any "
        "referenced files before acting. NOTE: any subagents listed in the handoff "
        "belonged to the PREVIOUS session. Their old Task IDs do NOT survive /clear "
        "(SendMessage rejects session-qualified ids and `claude agents --json` is "
        "empty), so don't drive them by id. A background subagent MAY still be alive "
        "and reachable by its bare name via SendMessage, but don't depend on it — the "
        "reply can lag minutes and it may have already exited. The reliable move is to "
        "check the outputs the handoff says they were producing (files, branches, PRs)."
        f"\n\n--- HANDOFF ({handoff_path}) ---\n{handoff}"
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
