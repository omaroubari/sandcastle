import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Format a timestamp as YYYYMMDD-HHMMSS */
const formatTimestamp = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

const execGit = async (args: string[], cwd: string): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout;
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(err.stderr?.trim() || err.message || String(e));
  }
};

export interface WorktreeInfo {
  path: string;
  branch: string;
}

/**
 * Creates a git worktree at `.sandcastle/worktrees/<name>/`.
 *
 * - If `branch` is specified, checks out that branch.
 * - If not, creates a temporary `sandcastle/<timestamp>` branch.
 *
 * Fails with a clear error if the branch is already checked out in another worktree.
 */
export const create = async (
  repoDir: string,
  opts?: { branch?: string },
): Promise<WorktreeInfo> => {
  const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
  await mkdir(worktreesDir, { recursive: true });

  let branch: string;
  let worktreeName: string;

  if (opts?.branch) {
    branch = opts.branch;
    worktreeName = branch.replace(/\//g, "-");
  } else {
    const timestamp = formatTimestamp(new Date());
    branch = `sandcastle/${timestamp}`;
    worktreeName = `sandcastle-${timestamp}`;
  }

  const worktreePath = join(worktreesDir, worktreeName);

  try {
    if (opts?.branch) {
      await execGit(["worktree", "add", worktreePath, branch], repoDir);
    } else {
      await execGit(
        ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
        repoDir,
      );
    }
  } catch (e: unknown) {
    const msg = String((e as Error).message ?? e);
    // git says "already checked out at" when the branch is live in another worktree,
    // or "already exists" when the worktree path already exists (same thing from our POV)
    if (msg.includes("already checked out") || msg.includes("already exists")) {
      throw new Error(
        `Branch '${branch}' is already checked out in another worktree`,
      );
    }
    throw e;
  }

  return { path: worktreePath, branch };
};

/**
 * Removes a worktree and its git metadata.
 *
 * The `worktreePath` must be a path inside `.sandcastle/worktrees/` so that
 * the main repository directory can be derived from it.
 */
export const remove = async (worktreePath: string): Promise<void> => {
  // Derive the main repo dir: worktreePath = <repoDir>/.sandcastle/worktrees/<name>
  const repoDir = join(worktreePath, "..", "..", "..");
  await execGit(["worktree", "remove", "--force", worktreePath], repoDir);
};

/**
 * Prunes stale git worktree metadata and removes orphaned directories under
 * `.sandcastle/worktrees/`.
 */
export const pruneStale = async (repoDir: string): Promise<void> => {
  // Let git clean up metadata for worktrees whose directories are gone
  await execGit(["worktree", "prune"], repoDir);

  const worktreesDir = join(repoDir, ".sandcastle", "worktrees");

  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    // Directory doesn't exist — nothing to prune
    return;
  }

  // Get the list of active worktree paths from git
  const worktreeList = await execGit(
    ["worktree", "list", "--porcelain"],
    repoDir,
  );
  const activeWorktreePaths = new Set(
    worktreeList
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim()),
  );

  // Remove any directory under .sandcastle/worktrees/ that is not an active worktree
  for (const entry of entries) {
    const entryPath = join(worktreesDir, entry);
    const isDir = await stat(entryPath)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir && !activeWorktreePaths.has(entryPath)) {
      await rm(entryPath, { recursive: true, force: true });
    }
  }
};
