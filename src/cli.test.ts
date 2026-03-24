import { exec } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("sandcastle CLI", () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("setup-sandbox");
    expect(stdout).toContain("cleanup-sandbox");
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
    expect(stdout).toContain("interactive");
    // sync-in and sync-out should not be exposed as CLI commands
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("setup-sandbox and cleanup-sandbox replace old setup/cleanup names", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    // New names present
    expect(stdout).toContain("setup-sandbox");
    expect(stdout).toContain("cleanup-sandbox");
    // Old names should not appear as standalone commands
    // (they may appear as substrings of the new names, so check that
    // "setup" only appears in the context of "setup-sandbox")
    const lines = stdout.split("\n");
    const setupLines = lines.filter(
      (l: string) => l.includes("setup") && !l.includes("setup-sandbox"),
    );
    expect(setupLines.length).toBe(0);
  });

  it("run command errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // No .sandcastle/ directory — run should fail
    try {
      await runCli("run", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });

  it("interactive command errors when .sandcastle/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // No .sandcastle/ directory — interactive should fail
    try {
      await runCli("interactive", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .sandcastle/ found");
    }
  });
});
