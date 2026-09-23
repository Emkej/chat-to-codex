import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, makeGitRepo, git, cleanup } from "../../../../../tests/helpers.js";
import { runGit } from "../../../../../src/workspace/git.js";
import { discoverDerivedWorktrees, resolveDerivedWorktree, worktreeIdFor } from "../../../../../src/workspace/worktrees.js";

const base = makeTmpDir("change-001-conformance");
const main = path.join(base, "main");
const linked = path.join(base, "linked");
fs.mkdirSync(main);
try {
  makeGitRepo(main);
  git(main, "worktree", "add", "-b", "review", linked);
  const gitDir = git(linked, "rev-parse", "--git-dir").trim();
  const reverseFile = path.join(gitDir, "gitdir");
  const originalReverse = fs.readFileSync(reverseFile, "utf8");
  const windowsRoot = "C:/review/linked";
  fs.writeFileSync(path.join(linked, ".git"), `gitdir: //wsl$/Ubuntu${gitDir}\n`);
  const options = {
    allowCrossNamespace: true,
    wslDistro: "Ubuntu",
    resolveWslPath: (value: string) => value === windowsRoot ? linked : value === `${windowsRoot}/.git` ? path.join(linked, ".git") : null,
  };
  const results = [];
  for (const [form, value] of [
    ["native-posix", originalReverse],
    ["windows-drive", `${windowsRoot}/.git\n`],
    ["current-distro-unc", `//wsl$/Ubuntu${linked}/.git\n`],
  ]) {
    fs.writeFileSync(reverseFile, value);
    const explicit = runGit({ root: linked, gitDir }, ["rev-parse", "--show-toplevel"]);
    let selection = "accepted";
    try {
      resolveDerivedWorktree(main, worktreeIdFor(path.join(main, ".git"), linked), undefined, options);
    } catch (error) {
      selection = (error as { code: string }).code;
    }
    results.push({ form, explicitGitValid: explicit.ok && explicit.stdout.trim() === linked,
      discoveredCount: discoverDerivedWorktrees(main, undefined, options).length, selection });
  }
  console.log(JSON.stringify({
    nativeReverseHasGitdirPrefix: originalReverse.startsWith("gitdir:"),
    expected: { discoveredCount: 1, selection: "accepted" }, results,
  }, null, 2));
} finally {
  cleanup(base);
}
