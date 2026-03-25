import { Effect } from "effect";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock child_process before importing the module under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "node:child_process";
import { startContainer } from "./DockerLifecycle.js";

const mockExecFile = vi.mocked(execFile);

/**
 * Helper: make execFile succeed with the given stdout.
 * The mock is called as execFile(cmd, args, options, callback).
 */
const mockSuccess = (stdout = "") => {
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

describe("startContainer", () => {
  it("starts a container without optional flags", async () => {
    // First call: ps (container check) returns empty
    // Second call: run
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      });

    await Effect.runPromise(
      startContainer("test-container", "test-image", { FOO: "bar" }),
    );

    const [_psArgs, runArgs] = capturedArgs();
    expect(runArgs).toContain("run");
    expect(runArgs).toContain("-d");
    expect(runArgs).toContain("--name");
    expect(runArgs).toContain("test-container");
    expect(runArgs).toContain("test-image");
    // No volume or workdir flags
    expect(runArgs).not.toContain("-v");
    expect(runArgs).not.toContain("-w");
  });

  it("passes volume mounts to docker run", async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      });

    await Effect.runPromise(
      startContainer(
        "test-container",
        "test-image",
        {},
        {
          volumeMounts: ["/host/path:/workspace", "/host/.git:/repo/.git"],
        },
      ),
    );

    const args = capturedArgs();
    const runArgs = args[1]!;
    expect(runArgs).toContain("-v");
    // Check both volume mounts appear
    const vIndexes = runArgs.reduce<number[]>(
      (acc, arg, i) => (arg === "-v" ? [...acc, i] : acc),
      [],
    );
    expect(vIndexes).toHaveLength(2);
    expect(runArgs[vIndexes[0]! + 1]!).toBe("/host/path:/workspace");
    expect(runArgs[vIndexes[1]! + 1]!).toBe("/host/.git:/repo/.git");
  });

  it("passes working directory override to docker run", async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      });

    await Effect.runPromise(
      startContainer(
        "test-container",
        "test-image",
        {},
        {
          workdir: "/workspace",
        },
      ),
    );

    const args = capturedArgs();
    const runArgs = args[1]!;
    expect(runArgs).toContain("-w");
    const wIndex = runArgs.indexOf("-w");
    expect(runArgs[wIndex + 1]!).toBe("/workspace");
  });

  it("passes both volume mounts and workdir to docker run", async () => {
    mockExecFile
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      })
      .mockImplementationOnce((_cmd, _args, _opts, callback) => {
        (callback as Function)(null, "", "");
        return {} as any;
      });

    await Effect.runPromise(
      startContainer(
        "test-container",
        "test-image",
        {},
        {
          volumeMounts: ["/host:/workspace"],
          workdir: "/workspace",
        },
      ),
    );

    const [_psArgs, runArgs] = capturedArgs();
    expect(runArgs).toContain("-v");
    expect(runArgs).toContain("/host:/workspace");
    expect(runArgs).toContain("-w");
    expect(runArgs).toContain("/workspace");
  });
});
