import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";
import { createSandbox } from "./createSandbox.js";
import { Sandbox } from "./SandboxFactory.js";
import { makeLocalSandboxLayer } from "./testSandbox.js";

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

/** Format a mock agent result as stream-json lines (mimicking Claude's output) */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

const testProvider = claudeCode("test-model");

/**
 * Create a mock sandbox layer that intercepts `claude` commands and runs a
 * mock script instead. All other commands pass through to the local sandbox.
 */
const makeMockAgentLayer = (
  sandboxDir: string,
  mockAgentBehavior: (sandboxRepoDir: string) => Promise<string>,
): Layer.Layer<Sandbox> => {
  const fsLayer = makeLocalSandboxLayer(sandboxDir);

  return Layer.succeed(Sandbox, {
    exec: (command, options) => {
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          return { stdout: output, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.exec(command, options),
      ).pipe(Effect.provide(fsLayer));
    },
    execStreaming: (command, onStdoutLine, options) => {
      if (command.startsWith("claude ")) {
        return Effect.gen(function* () {
          const cwd = options?.cwd ?? sandboxDir;
          const output = yield* Effect.promise(() => mockAgentBehavior(cwd));
          const streamOutput = toStreamJson(output);
          for (const line of streamOutput.split("\n")) {
            onStdoutLine(line);
          }
          return { stdout: streamOutput, stderr: "", exitCode: 0 };
        });
      }
      return Effect.flatMap(Sandbox, (real) =>
        real.execStreaming(command, onStdoutLine, options),
      ).pipe(Effect.provide(fsLayer));
    },
    copyIn: (hostPath, sandboxPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyIn(hostPath, sandboxPath),
      ).pipe(Effect.provide(fsLayer)),
    copyOut: (sandboxPath, hostPath) =>
      Effect.flatMap(Sandbox, (real) =>
        real.copyOut(sandboxPath, hostPath),
      ).pipe(Effect.provide(fsLayer)),
  });
};

describe("createSandbox", () => {
  it("creates a sandbox with branch and worktreePath properties", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-branch",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      expect(sandbox.branch).toBe("test-branch");
      expect(sandbox.worktreePath).toContain(".sandcastle/worktrees");
      expect(existsSync(sandbox.worktreePath)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() invokes agent and returns SandboxRunResult", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-run-branch",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async () => "agent output"),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "do something",
        maxIterations: 1,
      });

      expect(result.iterationsRun).toBe(1);
      expect(typeof result.stdout).toBe("string");
      expect(Array.isArray(result.commits)).toBe(true);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() removes worktree when clean, returns no preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-clean-close",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    const worktreePath = sandbox.worktreePath;
    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBeUndefined();
    expect(existsSync(worktreePath)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("sandbox.close() preserves worktree when dirty, returns preservedWorktreePath", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-dirty-close",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    // Make the worktree dirty
    await writeFile(join(sandbox.worktreePath, "dirty.txt"), "uncommitted");

    const closeResult = await sandbox.close();

    expect(closeResult.preservedWorktreePath).toBe(sandbox.worktreePath);
    expect(existsSync(sandbox.worktreePath)).toBe(true);

    // Clean up manually
    await rm(sandbox.worktreePath, { recursive: true, force: true });
    await execAsync(`git worktree prune`, { cwd: hostDir });
    await rm(hostDir, { recursive: true, force: true });
  });

  it("Symbol.asyncDispose works via await using", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    let worktreePath: string;
    {
      await using sandbox = await createSandbox({
        branch: "test-dispose-branch",
        _test: {
          hostRepoDir: hostDir,
          buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
        },
      });
      worktreePath = sandbox.worktreePath;
      expect(existsSync(worktreePath)).toBe(true);
    }
    // After block exit, worktree should be cleaned up
    expect(existsSync(worktreePath!)).toBe(false);
    await rm(hostDir, { recursive: true, force: true });
  });

  it("errors when branch is already checked out in another worktree", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox1 = await createSandbox({
      branch: "collision-branch",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    try {
      await expect(
        createSandbox({
          branch: "collision-branch",
          _test: {
            hostRepoDir: hostDir,
            buildSandboxLayer: (sandboxDir) =>
              makeLocalSandboxLayer(sandboxDir),
          },
        }),
      ).rejects.toThrow(/already checked out/);
    } finally {
      await sandbox1.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.run() returns commits made during the run", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-commits-branch",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) =>
          makeMockAgentLayer(sandboxDir, async (cwd) => {
            await writeFile(join(cwd, "agent-created.txt"), "new file");
            await execAsync("git add agent-created.txt", { cwd });
            await execAsync('git commit -m "agent commit"', { cwd });
            return "done";
          }),
      },
    });

    try {
      const result = await sandbox.run({
        agent: testProvider,
        prompt: "create a file",
        maxIterations: 1,
      });

      expect(result.commits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await sandbox.close();
      await rm(hostDir, { recursive: true, force: true });
    }
  });

  it("sandbox.close() is idempotent", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "init.txt", "init", "initial commit");

    const sandbox = await createSandbox({
      branch: "test-idempotent-close",
      _test: {
        hostRepoDir: hostDir,
        buildSandboxLayer: (sandboxDir) => makeLocalSandboxLayer(sandboxDir),
      },
    });

    const result1 = await sandbox.close();
    const result2 = await sandbox.close();

    expect(result1.preservedWorktreePath).toBeUndefined();
    expect(result2.preservedWorktreePath).toBeUndefined();
    await rm(hostDir, { recursive: true, force: true });
  });
});
