import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildCompletionMessage,
  buildLogFilename,
  buildRunSummaryRows,
  DEFAULT_MAX_ITERATIONS,
  printFileDisplayStartup,
  run,
  sanitizeBranchForFilename,
  type RunOptions,
  type RunResult,
} from "./run.js";
import { claudeCode } from "./AgentProvider.js";
import { defaultImageName } from "./sandboxes/docker.js";
import * as sandcastle from "./SandboxProvider.js";
import { createBindMountSandboxProvider } from "./SandboxProvider.js";

const testSandbox = createBindMountSandboxProvider({
  name: "test",
  create: async () => ({
    workspacePath: "/home/agent/workspace",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    execStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    close: async () => {},
  }),
});

describe("printFileDisplayStartup", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.FORCE_COLOR = "1";
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env.FORCE_COLOR;
  });

  it("does not use clack (no @clack/prompts calls)", async () => {
    const clack = await import("@clack/prompts");
    const clackSpy = vi
      .spyOn(clack.log, "success")
      .mockImplementation(() => {});
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(clackSpy).not.toHaveBeenCalled();
    clackSpy.mockRestore();
  });

  it("uses console.log for output", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("shows '[Agent] Started' when no name is provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[Agent]");
    expect(allOutput).toContain("Started");
  });

  it("shows custom agent name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      agentName: "my-run",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("[my-run]");
  });

  it("shows branch name when provided", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
      branch: "sandcastle/issue-124-file-logging",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("sandcastle/issue-124-file-logging");
  });

  it("shows tail command with relative log path", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    expect(allOutput).toContain("tail -f");
  });

  it("uses bold styling for the agent name bracket", () => {
    printFileDisplayStartup({
      logPath: "/project/.sandcastle/logs/main.log",
    });
    const allOutput = consoleSpy.mock.calls.flat().join(" ");
    // Bold ANSI escape code
    expect(allOutput).toContain("\u001b[1m");
  });
});

describe("buildCompletionMessage", () => {
  it("returns success message when completion signal was detected", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 3);
    expect(result.message).toBe(
      "Run complete: agent finished after 3 iteration(s).",
    );
    expect(result.severity).toBe("success");
  });

  it("returns warn message when max iterations reached without signal", () => {
    const result = buildCompletionMessage(undefined, 5);
    expect(result.message).toBe(
      "Run complete: reached 5 iteration(s) without completion signal.",
    );
    expect(result.severity).toBe("warn");
  });

  it("reflects the correct iteration count for 1 iteration", () => {
    const result = buildCompletionMessage("<promise>COMPLETE</promise>", 1);
    expect(result.message).toContain("1 iteration(s)");
  });
});

describe("RunResult", () => {
  it("includes logFilePath when logging to a file", () => {
    const result: RunResult = {
      iterationsRun: 1,
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
      logFilePath: "/path/to/sandcastle.log",
    };
    expect(result.logFilePath).toBe("/path/to/sandcastle.log");
  });

  it("allows logFilePath to be absent when logging to stdout", () => {
    const result: RunResult = {
      iterationsRun: 1,
      completionSignal: undefined,
      stdout: "",
      commits: [],
      branch: "main",
    };
    expect(result.logFilePath).toBeUndefined();
  });
});

describe("DEFAULT_MAX_ITERATIONS", () => {
  it("is 1", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(1);
  });
});

describe("RunOptions", () => {
  it("requires agent field typed as AgentProvider", () => {
    // @ts-expect-error agent is required
    const _opts: RunOptions = { prompt: "test" };
  });

  it("requires sandbox field typed as SandboxProvider", () => {
    // @ts-expect-error sandbox is required
    const _opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      prompt: "test",
    };
  });

  it("allows idleTimeoutSeconds to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      idleTimeoutSeconds: 120,
    };
    expect(opts.idleTimeoutSeconds).toBe(120);
  });

  it("allows idleTimeoutSeconds to be omitted (uses default)", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.idleTimeoutSeconds).toBeUndefined();
  });

  it("allows name to be specified", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
      name: "my-run",
    };
    expect(opts.name).toBe("my-run");
  });

  it("allows name to be omitted", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    expect(opts.name).toBeUndefined();
  });

  it("does not accept a worktree field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error worktree is no longer a valid field on RunOptions
    expect(opts.worktree).toBeUndefined();
  });

  it("does not accept a top-level branch field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error branch is no longer a valid field on RunOptions
    expect(opts.branch).toBeUndefined();
  });

  it("does not accept a top-level imageName field", () => {
    const opts: RunOptions = {
      agent: claudeCode("claude-opus-4-6"),
      sandbox: testSandbox,
      prompt: "test",
    };
    // @ts-expect-error imageName is no longer a valid field on RunOptions
    expect(opts.imageName).toBeUndefined();
  });
});

describe("copyToSandbox with head branch strategy", () => {
  it("throws a runtime error when copyToSandbox is provided with head strategy", async () => {
    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: testSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
        copyToSandbox: [".env"],
      }),
    ).rejects.toThrow(
      "copyToSandbox is not supported with head branch strategy",
    );
  });
});

describe("branchStrategy on RunOptions", () => {
  it("throws when head strategy is used with an isolated provider", async () => {
    const isolatedSandbox = sandcastle.createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => ({
        workspacePath: "/workspace",
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        execStreaming: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        copyIn: async () => {},
        copyOut: async () => {},
        close: async () => {},
      }),
    });

    await expect(
      run({
        agent: claudeCode("claude-opus-4-6"),
        sandbox: isolatedSandbox,
        prompt: "test",
        branchStrategy: { type: "head" },
      }),
    ).rejects.toThrow(
      "head branch strategy is not supported with isolated providers",
    );
  });
});

describe("buildRunSummaryRows", () => {
  it("uses the custom name as Agent when name is provided", () => {
    const rows = buildRunSummaryRows({
      name: "Implementer #202",
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 3,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("Implementer #202");
  });

  it("falls back to agentName when no name is provided", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Agent"]).toBe("claude-code");
  });

  it("includes sandbox name, max iterations, and branch", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 5,
      branch: "sandcastle/issue-160",
    });
    expect(rows["Sandbox"]).toBe("docker");
    expect(rows["Max iterations"]).toBe("5");
    expect(rows["Branch"]).toBe("sandcastle/issue-160");
  });

  it("does not include a Model row", () => {
    const rows = buildRunSummaryRows({
      agentName: "claude-code",
      sandboxName: "docker",
      maxIterations: 1,
      branch: "main",
    });
    expect(rows["Model"]).toBeUndefined();
  });
});

describe("sanitizeBranchForFilename", () => {
  it("passes through a simple branch name unchanged", () => {
    expect(sanitizeBranchForFilename("main")).toBe("main");
  });

  it("replaces forward slashes with dashes", () => {
    expect(sanitizeBranchForFilename("sandcastle/issue-87-log-file")).toBe(
      "sandcastle-issue-87-log-file",
    );
  });

  it("replaces backslashes with dashes", () => {
    expect(sanitizeBranchForFilename("feature\\branch")).toBe("feature-branch");
  });

  it("replaces all problematic filesystem characters", () => {
    expect(sanitizeBranchForFilename('feat:name*?"><|')).toBe(
      "feat-name------",
    );
  });

  it("handles nested slashes like a typical sandcastle branch", () => {
    expect(
      sanitizeBranchForFilename("sandcastle/issue-87-log-file-branch-name"),
    ).toBe("sandcastle-issue-87-log-file-branch-name");
  });
});

describe("defaultImageName", () => {
  it("returns sandcastle:<dir-name> for a typical repo path", () => {
    expect(defaultImageName("/home/user/my-project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("lowercases the directory name", () => {
    expect(defaultImageName("/home/user/MyProject")).toBe(
      "sandcastle:myproject",
    );
  });

  it("replaces characters invalid in Docker image tags with dashes", () => {
    expect(defaultImageName("/home/user/my project")).toBe(
      "sandcastle:my-project",
    );
  });

  it("handles paths with trailing slash gracefully", () => {
    expect(defaultImageName("/home/user/my-repo/")).toBe("sandcastle:my-repo");
  });
});

describe("buildLogFilename", () => {
  it("returns sanitized branch + .log when no target branch", () => {
    expect(buildLogFilename("main")).toBe("main.log");
  });

  it("prefixes with target branch when temp branch is used", () => {
    expect(buildLogFilename("sandcastle/20260325-142719", "main")).toBe(
      "main-sandcastle-20260325-142719.log",
    );
  });

  it("sanitizes target branch with slashes", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "feature/my-work"),
    ).toBe("feature-my-work-sandcastle-20260325-142719.log");
  });

  it("includes agent name when branch contains agent segment", () => {
    expect(
      buildLogFilename("sandcastle/claude-code/20260325-142719", "main"),
    ).toBe("main-sandcastle-claude-code-20260325-142719.log");
  });

  it("appends run name when name is provided", () => {
    expect(buildLogFilename("main", undefined, "implementer")).toBe(
      "main-implementer.log",
    );
  });

  it("appends run name after target branch prefix", () => {
    expect(
      buildLogFilename("sandcastle/20260325-142719", "main", "reviewer"),
    ).toBe("main-sandcastle-20260325-142719-reviewer.log");
  });

  it("sanitizes run name for filename use", () => {
    expect(buildLogFilename("main", undefined, "my review agent")).toBe(
      "main-my-review-agent.log",
    );
  });
});
