"""Render candidate change evidence and status-aware Slack messages. Runs no candidate code."""
import argparse
import html
import json
from pathlib import Path
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def report(fork, review_path, output):
    head = git("rev-parse", "HEAD")
    # -z preserves spaces, tabs and newlines in paths. No limit on commits or changed files.
    files = subprocess.check_output([
        "git", "diff", "--name-only", "-z", fork, head
    ]).decode().rstrip("\0").split("\0")
    files = [name for name in files if name]
    commits = git("log", "--reverse", "--no-merges", "--format=%H %s", f"{fork}..{head}")
    try:
        changes = json.loads(Path(review_path).read_text())["changes"]
        if not isinstance(changes, list) or (files and not changes):
            raise ValueError("Missing change descriptions")
        for change in changes:
            if (change["kind"] not in ("feature", "fix", "maintenance")
                    or not isinstance(change["summary"], str) or not change["summary"].strip()
                    or not isinstance(change["files"], list) or not change["files"]
                    or not all(name in files for name in change["files"])):
                raise ValueError("Change description lacks changed-file evidence")
    except (OSError, ValueError, KeyError, TypeError):
        changes = None

    lines = ["## Changes in this sync candidate", "",
             f"Compared with released fork `{fork}`; candidate `{head}`.", "",
             "These changes are proposed until the sync lands on `braintrance`. Landing there does "
             "not itself prove the consuming app has deployed the editor.", ""]
    brief = []
    if changes is None:
        brief.append("Feature summary unavailable; inspect the complete commit and file inventory in the PR.")
        lines.extend([brief[0], ""])
    else:
        for kind, title in (("feature", "Features and behavior"), ("fix", "Fixes"),
                            ("maintenance", "Dependencies and maintenance")):
            group = [change for change in changes if change["kind"] == kind]
            if not group:
                continue
            lines.extend([f"### {title}", ""])
            for change in group:
                summary = " ".join(change["summary"].split())
                evidence = ", ".join(f"`{name}`" for name in change["files"])
                lines.append(f"- {summary} ({evidence})")
                brief.append(f"• [{kind}] {summary}")
            lines.append("")
        if not files:
            lines.extend(["No net file changes relative to the released fork.", ""])
            brief.append("No net file changes relative to the released fork.")

    summary = "\n".join(lines)
    inventory_start = len(lines)
    lines.extend(["<details><summary>Complete incoming commit inventory</summary>", "",
                  "Commit history can include intermediate or reverted changes; the feature notes "
                  "above describe the final candidate diff.", ""])
    lines.extend(f"- {line}" for line in commits.splitlines())
    lines.extend(["", "</details>", "", "<details><summary>Complete changed file inventory</summary>", ""])
    lines.extend(f"- `{name}`" for name in files)
    lines.extend(["", "</details>", ""])
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.md").write_text(summary)
    (output / "inventory.md").write_text("\n".join(lines[inventory_start:]))
    (output / "changes.md").write_text("\n".join(lines))
    (output / "changes.txt").write_text("\n".join(brief))


def slack(pr, landed, failed, checks, run, notes_path):
    if landed == "yes":
        status = ":white_check_mark: SuperSplat sync landed on `braintrance`."
        if failed == "true":
            status = ":warning: SuperSplat sync landed on `braintrance`, but a workflow step failed."
        heading = "Changes landed in the fork (consuming-app deployment not verified):"
    elif pr:
        status = ":warning: SuperSplat sync is held for review; nothing landed on `braintrance`."
        heading = "Proposed changes in the held PR:"
    else:
        status = ":x: SuperSplat sync failed before opening a PR; no release confirmed."
        heading = "Candidate changes, if available:"
    escape = lambda value: html.escape(value, quote=False)
    parts = [status, f"<{pr}|Sync PR>" if pr else f"<{run}|Workflow run>"]
    if checks:
        parts.append(escape(checks))
    try:
        notes = Path(notes_path).read_text().strip()
    except OSError:
        notes = "Change report unavailable; inspect the PR or workflow run."
    # Keep Slack below its recommended 4,000-character text size. The PR and artifact are complete.
    limit = 3000
    shown = []
    for line in notes.splitlines():
        safe = escape(line)
        if len("\n".join([*shown, safe])) > limit:
            shown.append("… More changes in the full report linked below.")
            break
        shown.append(safe)
    parts.extend([heading, "\n".join(shown),
                  f"Full feature notes and complete commit/file inventories: <{pr or run}|report>. "
                  f"Unabridged `sync-changes` artifact: <{run}|workflow run>."])
    return {"text": "\n".join(parts), "link_names": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    report_parser = commands.add_parser("report")
    for name in ("fork", "review", "output"):
        report_parser.add_argument(f"--{name}", required=True)
    slack_parser = commands.add_parser("slack")
    for name in ("pr", "landed", "failed", "checks", "run", "notes"):
        slack_parser.add_argument(f"--{name}", default="")
    args = parser.parse_args()
    if args.command == "report":
        report(args.fork, args.review, args.output)
    else:
        print(json.dumps(slack(args.pr, args.landed, args.failed, args.checks, args.run, args.notes)))
