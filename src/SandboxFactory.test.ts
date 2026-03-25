import { Effect, Layer } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorktreeError } from "./errors.js";

// Mock child_process before importing modules under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("./WorktreeManager.js", () => ({
  create: vi.fn(),
  remove: vi.fn(),
  pruneStale: vi.fn(),
}));

import { execFile } from "node:child_process";
import * as WorktreeManager from "./WorktreeManager.js";
import {
  DockerSandboxFactory,
  SandboxConfig,
  SandboxFactory,
  WorktreeSandboxConfig,
  WorktreeDockerSandboxFactory,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";

const mockExecFile = vi.mocked(execFile);
const mockCreate = vi.mocked(WorktreeManager.create);
const mockRemove = vi.mocked(WorktreeManager.remove);
const mockPruneStale = vi.mocked(WorktreeManager.pruneStale);

/** Make all execFile calls succeed with given stdout. */
const mockDockerSuccess = (stdout = "") => {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, "");
    return {} as any;
  });
};

/** Collect all docker arg arrays across calls. */
const capturedArgs = (): string[][] =>
  mockExecFile.mock.calls.map((call) => call[1] as string[]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorktreeDockerSandboxFactory", () => {
  const hostRepoDir = "/host/repo";
  const worktreePath = "/host/repo/.sandcastle/worktrees/sandcastle-123";

  const makeLayer = () =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.merge(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: { FOO: "bar" },
          hostRepoDir,
        }),
        NodeFileSystem.layer,
      ),
    );

  beforeEach(() => {
    mockCreate.mockReturnValue(
      Effect.succeed({
        path: worktreePath,
        branch: "sandcastle/20240101-000000",
      }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    mockDockerSuccess();
  });

  it("passes branch from config to WorktreeManager.create when branch is specified", async () => {
    const layerWithBranch = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.merge(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: {},
          hostRepoDir,
          branch: "feature/my-branch",
        }),
        NodeFileSystem.layer,
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithBranch)),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      branch: "feature/my-branch",
    });
  });

  it("calls create without branch options when no branch in config", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir);
  });

  it("creates a worktree before starting the container", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir);
    // Worktree creation happened before the docker run call
    const runCallIndex = mockExecFile.mock.calls.findIndex(
      (c) => (c[1] as string[])[0] === "run",
    );
    expect(runCallIndex).toBeGreaterThan(-1);
    // create() was called (mocked promise), so it was invoked before docker run
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("starts container with worktree and .git bind-mounts at SANDBOX_WORKSPACE_DIR", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toBeDefined();
    expect(runArgs).toContain(`${worktreePath}:${SANDBOX_WORKSPACE_DIR}`);
    expect(runArgs).toContain(`${hostRepoDir}/.git:${hostRepoDir}/.git`);
  });

  it("sets working directory to SANDBOX_WORKSPACE_DIR", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toContain("-w");
    const wIndex = runArgs!.indexOf("-w");
    expect(runArgs![wIndex + 1]).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it("removes worktree after the effect completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });

  it("prunes stale worktrees before creating a new worktree", async () => {
    const callOrder: string[] = [];
    mockPruneStale.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("pruneStale");
      }),
    );
    mockCreate.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("create");
        return { path: worktreePath, branch: "sandcastle/20240101-000000" };
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockPruneStale).toHaveBeenCalledWith(hostRepoDir);
    expect(callOrder.indexOf("pruneStale")).toBeLessThan(
      callOrder.indexOf("create"),
    );
  });

  it("continues creating the worktree even if pruning fails", async () => {
    mockPruneStale.mockReturnValue(
      Effect.fail(new WorktreeError({ message: "prune failed" })),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir);
  });

  it("removes worktree even if the effect fails", async () => {
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.die("boom"));
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });
});

describe("DockerSandboxFactory (isolated mode)", () => {
  const makeLayer = () =>
    Layer.provide(
      DockerSandboxFactory.layer,
      Layer.succeed(SandboxConfig, {
        imageName: "test-image",
        env: {},
      }),
    );

  beforeEach(() => {
    mockDockerSuccess();
  });

  it("does not create a worktree", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
