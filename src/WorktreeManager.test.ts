import { exec } from "node:child_process";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { create, pruneStale, remove } from "./WorktreeManager.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getBranch = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
    cwd: dir,
  });
  return stdout.trim();
};

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "wt-repo-"));
  await initRepo(repoDir);
  await commitFile(repoDir, "hello.txt", "hello", "initial commit");
  return repoDir;
};

describe("WorktreeManager.create", () => {
  it("creates a worktree at .sandcastle/worktrees/<name>/", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);
    expect(path).toContain(join(repoDir, ".sandcastle", "worktrees"));
    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
  });

  it("returns the branch name", async () => {
    const repoDir = await setupRepo();
    const { branch } = await create(repoDir);
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });

  it("creates a sandcastle/<timestamp> branch when no branch is specified", async () => {
    const repoDir = await setupRepo();
    const { branch } = await create(repoDir);
    expect(branch).toMatch(/^sandcastle\/\d{8}-\d{6}$/);
  });

  it("checks out the specified branch when branch is given", async () => {
    const repoDir = await setupRepo();
    // Create a branch first
    await execAsync("git checkout -b feature/my-feature", { cwd: repoDir });
    await commitFile(repoDir, "feature.txt", "x", "feature commit");
    await execAsync("git checkout main", { cwd: repoDir });

    const { path, branch } = await create(repoDir, {
      branch: "feature/my-feature",
    });
    expect(branch).toBe("feature/my-feature");
    expect(await getBranch(path)).toBe("feature/my-feature");
  });

  it("the worktree directory is on the correct branch", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);
    // The worktree should have a valid git repo
    const { stdout } = await execAsync("git rev-parse --abbrev-ref HEAD", {
      cwd: path,
    });
    expect(stdout.trim()).toMatch(/^sandcastle\//);
  });

  it("fails with a clear error when branch is already checked out", async () => {
    const repoDir = await setupRepo();
    // Create a branch
    await execAsync("git checkout -b my-branch", { cwd: repoDir });
    await commitFile(repoDir, "x.txt", "x", "branch commit");
    await execAsync("git checkout main", { cwd: repoDir });

    // Create first worktree on that branch
    await create(repoDir, { branch: "my-branch" });

    // Try to create a second worktree on the same branch — should fail clearly
    await expect(create(repoDir, { branch: "my-branch" })).rejects.toThrow(
      /already checked out/i,
    );
  });
});

describe("WorktreeManager.remove", () => {
  it("removes the worktree directory", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);

    await remove(path);

    await expect(stat(path)).rejects.toThrow();
  });

  it("removes git worktree metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);

    await remove(path);

    // After removal, the worktree should not appear in git worktree list
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });
});

describe("WorktreeManager.pruneStale", () => {
  it("runs git worktree prune to clean up stale metadata", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);

    // Manually delete the worktree directory (simulating a crash)
    const { execSync } = await import("node:child_process");
    execSync(`rm -rf "${path}"`);

    // pruneStale should not throw
    await expect(pruneStale(repoDir)).resolves.not.toThrow();

    // Git metadata should be cleaned up
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoDir,
    });
    expect(stdout).not.toContain(path);
  });

  it("removes orphaned directories under .sandcastle/worktrees/", async () => {
    const repoDir = await setupRepo();
    const worktreesDir = join(repoDir, ".sandcastle", "worktrees");
    await mkdir(worktreesDir, { recursive: true });

    // Create an orphaned directory (not backed by a git worktree)
    const orphanDir = join(worktreesDir, "orphan-dir");
    await mkdir(orphanDir);

    await pruneStale(repoDir);

    const entries = await readdir(worktreesDir).catch(() => []);
    expect(entries).not.toContain("orphan-dir");
  });

  it("does not remove active worktrees", async () => {
    const repoDir = await setupRepo();
    const { path } = await create(repoDir);
    const name = path.split("/").pop()!;

    await pruneStale(repoDir);

    const s = await stat(path);
    expect(s.isDirectory()).toBe(true);
    // cleanup
    await remove(path);
    // suppress unused var warning
    void name;
  });
});
