/**
 * Sync-out: extract changes from an isolated sandbox back to the host.
 *
 * Three-prong approach:
 * 1. Committed changes: `git format-patch` + `git am --3way`
 * 2. Uncommitted changes (staged + unstaged): `git diff HEAD` + `git apply`
 * 3. Untracked files: `git ls-files --others` + `copyOut` each file
 */

import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IsolatedSandboxHandle } from "./SandboxProvider.js";
import { execHost, execOk } from "./sandboxExec.js";

/**
 * Check if a patch file is empty or header-only.
 * Merge commits produce patches with headers but no diff content.
 * A patch is considered empty if it has no lines starting with "diff --git".
 */
const isEmptyPatch = async (patchPath: string): Promise<boolean> => {
  const info = await stat(patchPath);
  if (info.size === 0) return true;

  const content = await readFile(patchPath, "utf-8");
  return !content.includes("diff --git");
};

/**
 * Sync committed changes from an isolated sandbox back to the host repo.
 *
 * Compares the sandbox HEAD against the host HEAD to determine new commits,
 * generates patches via `git format-patch`, transfers them to the host via
 * `copyOut`, filters out empty patches, and applies them with `git am --3way`.
 *
 * No-op if the sandbox has no new commits.
 */
export const syncOut = async (
  hostRepoDir: string,
  handle: IsolatedSandboxHandle,
): Promise<void> => {
  const workspacePath = handle.workspacePath;

  const hostHead = (await execHost("git rev-parse HEAD", hostRepoDir)).trim();
  const sandboxHead = (
    await execOk(handle, "git rev-parse HEAD", { cwd: workspacePath })
  ).stdout.trim();

  // --- Prong 1: Committed changes via format-patch ---
  if (hostHead !== sandboxHead) {
    const mkTempResult = await execOk(
      handle,
      "mktemp -d -t sandcastle-patches-XXXXXX",
    );
    const sandboxPatchDir = mkTempResult.stdout.trim();

    await execOk(
      handle,
      `git format-patch "${hostHead}..HEAD" -o "${sandboxPatchDir}"`,
      { cwd: workspacePath },
    );

    const lsResult = await execOk(handle, `ls -1 "${sandboxPatchDir}"`);
    const patchNames = lsResult.stdout
      .trim()
      .split("\n")
      .filter((name) => name.length > 0);

    if (patchNames.length > 0) {
      const hostPatchDir = await mkdtemp(join(tmpdir(), "sandcastle-patches-"));
      try {
        const nonEmptyPatches: string[] = [];

        for (const patchName of patchNames) {
          const sandboxPatchPath = `${sandboxPatchDir}/${patchName}`;
          const hostPatchPath = join(hostPatchDir, patchName);
          await handle.copyOut(sandboxPatchPath, hostPatchPath);

          if (!(await isEmptyPatch(hostPatchPath))) {
            nonEmptyPatches.push(hostPatchPath);
          }
        }

        if (nonEmptyPatches.length > 0) {
          const patchArgs = nonEmptyPatches.map((p) => `"${p}"`).join(" ");
          await execHost(`git am --3way ${patchArgs}`, hostRepoDir);
        }
      } finally {
        await rm(hostPatchDir, { recursive: true, force: true });
        await handle.exec(`rm -rf "${sandboxPatchDir}"`);
      }
    }
  }

  // --- Prong 2: Uncommitted changes (staged + unstaged) via git diff ---
  const diffResult = await handle.exec("git diff HEAD", { cwd: workspacePath });
  if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
    const hostDiffDir = await mkdtemp(join(tmpdir(), "sandcastle-diff-"));
    const hostDiffPath = join(hostDiffDir, "uncommitted.patch");
    try {
      // Write the diff to a file in the sandbox, then copyOut
      const sandboxDiffPath = "/tmp/sandcastle-uncommitted.patch";
      await execOk(handle, `git diff HEAD > "${sandboxDiffPath}"`, {
        cwd: workspacePath,
      });
      await handle.copyOut(sandboxDiffPath, hostDiffPath);
      await handle.exec(`rm -f "${sandboxDiffPath}"`);

      await execHost(`git apply "${hostDiffPath}"`, hostRepoDir);
    } finally {
      await rm(hostDiffDir, { recursive: true, force: true });
    }
  }

  // --- Prong 3: Untracked files via git ls-files ---
  const lsFilesResult = await handle.exec(
    "git ls-files --others --exclude-standard",
    { cwd: workspacePath },
  );
  if (lsFilesResult.exitCode === 0 && lsFilesResult.stdout.trim().length > 0) {
    const untrackedFiles = lsFilesResult.stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    for (const relPath of untrackedFiles) {
      const sandboxFilePath = `${workspacePath}/${relPath}`;
      const hostFilePath = join(hostRepoDir, relPath);
      await mkdir(dirname(hostFilePath), { recursive: true });
      await handle.copyOut(sandboxFilePath, hostFilePath);
    }
  }
};
