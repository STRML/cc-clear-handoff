import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HOOK = os.path.join(os.path.dirname(__file__), "..", "hooks", "clear-handoff-load.py")


class HookTest(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.pending = os.path.join(self.home, ".claude", "tmp", "pending-handoffs")
        os.makedirs(self.pending)
        self.repo = os.path.join(self.home, "repo")
        self.worktree = os.path.join(self.repo, ".claude", "worktrees", "feature-x")

    def arm(self, armed_in, name="feature-x-work.md", age=0):
        os.makedirs(os.path.join(armed_in, ".tmp"), exist_ok=True)
        handoff = os.path.join(armed_in, ".tmp", name)
        with open(handoff, "w") as f:
            f.write("# Handoff — feature x\n\nNext steps: ship it\n")
        key = armed_in.replace("/", "-").replace(".", "-").strip("-")
        sentinel = os.path.join(self.pending, f"{key}.path")
        with open(sentinel, "w") as f:
            f.write(handoff)
        armed_at = time.time() - age
        os.utime(sentinel, (armed_at, armed_at))
        return handoff, sentinel

    def run_hook(self, cwd, source="clear"):
        env = dict(os.environ, HOME=self.home)
        out = subprocess.run([sys.executable, HOOK], input=json.dumps({"source": source, "cwd": cwd}),
                             capture_output=True, text=True, env=env, check=True).stdout
        return json.loads(out) if out.strip() else None

    def test_armed_in_launch_dir_loads(self):
        handoff, sentinel = self.arm(self.repo)
        out = self.run_hook(self.repo)
        self.assertIn(handoff, out["hookSpecificOutput"]["additionalContext"])
        self.assertFalse(os.path.exists(sentinel))

    def test_armed_in_worktree_loads_in_launch_dir(self):
        handoff, sentinel = self.arm(self.worktree)
        out = self.run_hook(self.repo)
        self.assertIn(handoff, out["hookSpecificOutput"]["additionalContext"])
        self.assertFalse(os.path.exists(sentinel))

    def test_newest_of_several_below_wins(self):
        self.arm(os.path.join(self.repo, "bench"), "older.md", age=600)
        newer, _ = self.arm(self.worktree, "newer.md")
        out = self.run_hook(self.repo)
        self.assertIn(newer, out["hookSpecificOutput"]["additionalContext"])

    def test_sibling_dir_does_not_load(self):
        _, sentinel = self.arm(os.path.join(self.home, "other-repo"))
        self.assertIsNone(self.run_hook(self.repo))
        self.assertTrue(os.path.exists(sentinel))

    def test_prefix_named_sibling_does_not_load(self):
        _, sentinel = self.arm(self.repo + "-fork")
        self.assertIsNone(self.run_hook(self.repo))
        self.assertTrue(os.path.exists(sentinel))

    def test_expired_sentinels_are_removed(self):
        _, stale = self.arm(os.path.join(self.home, "other-repo"), age=2 * 86400)
        self.assertIsNone(self.run_hook(self.repo))
        self.assertFalse(os.path.exists(stale))

    def test_compact_does_not_consume(self):
        _, sentinel = self.arm(self.repo)
        self.assertIsNone(self.run_hook(self.repo, source="compact"))
        self.assertTrue(os.path.exists(sentinel))


if __name__ == "__main__":
    unittest.main()
