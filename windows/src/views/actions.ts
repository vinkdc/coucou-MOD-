// One-tap AI actions for the cockpit. Each is a prebuilt prompt that carries
// what the island already knows (folder, branch, how dirty the tree is) and
// asks the assistant to look with its own tools — every command or file read
// still shows the usual Allow/Deny card, so nothing runs unseen.

import type { RepoStatus } from "../core/bridge";

export interface Chip {
  label: string;
  /** Tooltip. */
  hint: string;
  prompt: string;
}

export function chipsFor(repo: RepoStatus, cwd: string): Chip[] {
  const files = `${repo.changed} uncommitted file${repo.changed === 1 ? "" : "s"}`;
  const where = `the repository at ${cwd} (branch ${repo.branch}, ${files})`;
  const chips: Chip[] = [];

  if (repo.changed > 0) {
    chips.push({
      label: "Diff",
      hint: "Summarise my uncommitted changes",
      prompt: `Summarise my uncommitted changes in ${where}. Run git status and git diff, group the changes by purpose, and flag anything risky or unfinished. Be brief.`,
    });
    chips.push({
      label: "Commit msg",
      hint: "Draft a commit message for my changes",
      prompt: `Draft a commit message for my uncommitted changes in ${where}. Run git diff --staged first, and git diff if nothing is staged. Give a subject line of at most 72 characters and a short body explaining why. Do not commit anything.`,
    });
  }
  chips.push({
    label: "Review",
    hint: "Review this branch against main",
    prompt: `Review the current branch in ${where} against its base branch. Run git log and git diff against main (or master), then list bugs, risks and missing tests, most important first. Be specific about files and lines.`,
  });
  chips.push({
    label: "Explain",
    hint: "Explain the latest error or failing check",
    prompt: `Find the most recent error, failing test or failing build in ${where} and explain the cause and the fix. Run whatever you need to reproduce it, such as the project's test or build command, and keep the answer short.`,
  });
  return chips.slice(0, 3);
}
