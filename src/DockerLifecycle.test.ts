import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { chownInContainer, startContainer } from "./DockerLifecycle.js";

const mockExecFile = vi.mocked(execFile);

afterEach(() => {
  mockExecFile.mockReset();
});

describe("startContainer", () => {
  it("passes --network flag when network is a string", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: "my-network" }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    expect(runCall).toBeDefined();
    const runArgs = runCall![1] as string[];
    const networkIdx = runArgs.indexOf("--network");
    expect(networkIdx).toBeGreaterThan(-1);
    expect(runArgs[networkIdx + 1]).toBe("my-network");
  });

  it("passes multiple --network flags when network is an array", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      startContainer("ctr", "img", {}, { network: ["net1", "net2"] }),
    );

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    const firstIdx = runArgs.indexOf("--network");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(runArgs[firstIdx + 1]).toBe("net1");
    const secondIdx = runArgs.indexOf("--network", firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(runArgs[secondIdx + 1]).toBe("net2");
  });

  it("does not pass --network when network is omitted", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(startContainer("ctr", "img", {}));

    const runCall = mockExecFile.mock.calls.find(
      ([, args]) => Array.isArray(args) && args[0] === "run",
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--network");
  });
});

describe("chownInContainer", () => {
  it("succeeds silently when chown succeeds", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "", "");
      return undefined as any;
    });

    await Effect.runPromise(
      chownInContainer("ctr", "1000:1000", "/home/agent"),
    );
  });

  it("does not propagate error when chown fails", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      const err = new Error(
        "chown: changing ownership of '/workspace/.git/objects/pack': Read-only file system",
      );
      (err as any).code = 1;
      cb(err, "", "chown: Read-only file system");
      return undefined as any;
    });

    // Should NOT throw — chown failure is non-fatal
    await Effect.runPromise(
      chownInContainer("ctr", "1000:1000", "/home/agent"),
    );
  });

  it("logs a warning when chown fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      const err = new Error("chown failed");
      (err as any).code = 1;
      cb(err, "", "chown: Read-only file system");
      return undefined as any;
    });

    await Effect.runPromise(
      chownInContainer("ctr", "1000:1000", "/home/agent"),
    );

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("chown"));

    warnSpy.mockRestore();
  });
});
