import importlib.util
import json
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("change_notes", Path(__file__).with_name("change-notes.py"))
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)


class Reports(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, self.old)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.test")
        self.git("config", "commit.gpgsign", "false")
        Path("editor.txt").write_text("old")
        self.commit("Existing editor")
        self.fork = self.git("rev-parse", "HEAD")
        Path("editor.txt").write_text("new")
        self.commit("Add import review <@everyone>")
        Path("with spaces.txt").write_text("new")
        self.commit("Fix multi-file import")
        self.review = Path("review.json")
        self.review.write_text(json.dumps({"changes": [
            {"kind": "feature", "summary": "Review mixed imports <@everyone>", "files": ["editor.txt"]},
            {"kind": "fix", "summary": "Handle filenames with spaces", "files": ["with spaces.txt"]}
        ]}))

    def git(self, *args):
        return subprocess.check_output(["git", *args], text=True).strip()

    def commit(self, subject):
        self.git("add", "--all")
        self.git("commit", "-qm", subject)

    def test_complete_candidate_evidence_and_slack_status(self):
        notes.report(self.fork, self.review, "out")
        report = Path("out/changes.md").read_text()
        self.assertIn("Features and behavior", report)
        self.assertIn("Fixes", report)
        self.assertIn("Add import review", report)
        self.assertIn("Fix multi-file import", report)
        self.assertIn("with spaces.txt", report)
        self.assertNotIn("Existing editor", report)
        held = notes.slack("https://github.com/o/r/pull/1", "", "true", "review hold",
                           "https://github.com/o/r/actions/runs/1", "out/changes.txt")["text"]
        self.assertIn("nothing landed", held)
        self.assertIn("Proposed changes", held)
        self.assertIn("&lt;@everyone&gt;", held)
        self.assertNotIn("<@everyone>", held)
        landed = notes.slack("https://github.com/o/r/pull/1", "yes", "false", "passed",
                             "https://github.com/o/r/actions/runs/1", "out/changes.txt")["text"]
        self.assertIn("Changes landed in the fork", landed)
        self.assertIn("deployment not verified", landed)
        self.assertNotIn("held for review", landed)

    def test_unavailable_or_unsupported_summary_is_explicit(self):
        for review in ("{}", "not json", '{"changes":[{"kind":"feature","summary":"Imaginary","files":["missing"]}]}'):
            self.review.write_text(review)
            notes.report(self.fork, self.review, "out")
            text = Path("out/changes.md").read_text()
            self.assertIn("Feature summary unavailable", text)
            self.assertIn("Fix multi-file import", text)
            self.assertNotIn("Imaginary", text)
        text = notes.slack("", "", "true", "", "https://example.test/run", "missing")["text"]
        self.assertIn("failed before opening a PR", text)
        self.assertIn("report unavailable", text)

    def test_long_slack_report_links_unabridged_notes(self):
        changes = [{"kind": "feature", "summary": f"Feature {i} " + "x" * 200,
                    "files": ["editor.txt"]} for i in range(80)]
        self.review.write_text(json.dumps({"changes": changes}))
        notes.report(self.fork, self.review, "out")
        self.assertIn("Feature 79", Path("out/changes.md").read_text())
        text = notes.slack("https://example.test/pr", "", "true", "hold",
                           "https://example.test/run", "out/changes.txt")["text"]
        self.assertLess(len(text), 4000)
        self.assertIn("More changes", text)
        self.assertIn("Unabridged", text)

    def test_no_net_changes_and_post_landing_failure(self):
        self.review.write_text('{"changes":[]}')
        notes.report(self.git("rev-parse", "HEAD"), self.review, "out")
        self.assertIn("No net file changes", Path("out/changes.md").read_text())
        text = notes.slack("https://example.test/pr", "yes", "true", "passed",
                           "https://example.test/run", "out/changes.txt")["text"]
        self.assertIn("landed", text)
        self.assertIn("step failed", text)
        self.assertNotIn("nothing landed", text)


if __name__ == "__main__":
    unittest.main()
