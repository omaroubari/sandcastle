import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execFile } from "node:child_process";
import { chownInContainer } from "./DockerLifecycle.js";

const mockExecFile = vi.mocked(execFile);

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
