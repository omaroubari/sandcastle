import { Effect, Layer, Ref } from "effect";
import { exec } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { ExecError } from "./errors.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";

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

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

const testDisplayLayer = SilentDisplay.layer(
  Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
);

const setup = async () => {
  const hostDir = await mkdtemp(join(tmpdir(), "host-"));
  const sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-"));
  const sandboxRepoDir = join(sandboxDir, "repo");
  const layer = FilesystemSandbox.layer(sandboxDir);
  return { hostDir, sandboxDir, sandboxRepoDir, layer };
};

describe("withSandboxLifecycle", () => {
  it("full lifecycle — callback commit syncs back to host", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, (ctx) =>
        Effect.gen(function* () {
          // Configure git in sandbox
          yield* ctx.sandbox.exec('git config user.email "test@test.com"', {
            cwd: ctx.sandboxRepoDir,
          });
          yield* ctx.sandbox.exec('git config user.name "Test"', {
            cwd: ctx.sandboxRepoDir,
          });

          // Create a commit in the sandbox
          yield* ctx.sandbox.exec(
            'sh -c "echo new-content > feature.txt && git add feature.txt && git commit -m \\"add feature\\""',
            { cwd: ctx.sandboxRepoDir },
          );
        }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    // Verify commit synced back to host
    const content = await readFile(join(hostDir, "feature.txt"), "utf-8");
    expect(content.trim()).toBe("new-content");

    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout).toContain("add feature");
  });

  it("onSandboxCreate hooks run before sync-in", async () => {
    const { hostDir, sandboxDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const markerPath = join(sandboxDir, "create-marker.txt");

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir,
          hooks: {
            onSandboxCreate: [{ command: `echo created > "${markerPath}"` }],
          },
        },
        () => Effect.void,
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    const marker = await readFile(markerPath, "utf-8");
    expect(marker.trim()).toBe("created");
  });

  it("onSandboxReady hooks run after sync-in", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await Effect.runPromise(
      withSandboxLifecycle(
        {
          hostRepoDir: hostDir,
          sandboxRepoDir,
          hooks: {
            onSandboxReady: [{ command: "echo ready > ready-marker.txt" }],
          },
        },
        (ctx) =>
          Effect.gen(function* () {
            // Verify marker exists (created by hook running in sandboxRepoDir)
            const result = yield* ctx.sandbox.exec("cat ready-marker.txt", {
              cwd: ctx.sandboxRepoDir,
            });
            expect(result.stdout.trim()).toBe("ready");
          }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("baseHead is correct", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const hostHead = await getHead(hostDir);

    await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, (ctx) =>
        Effect.gen(function* () {
          expect(ctx.baseHead).toBe(hostHead);
        }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );
  });

  it("callback return value passes through", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const result = await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
        Effect.succeed({ complete: true }),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.result).toEqual({ complete: true });
  });

  it("no hooks is fine", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    const result = await Effect.runPromise(
      withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
        Effect.succeed("ok"),
      ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
    );

    expect(result.result).toBe("ok");
  });

  it("hook failure aborts before callback", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    let callbackRan = false;

    await expect(
      Effect.runPromise(
        withSandboxLifecycle(
          {
            hostRepoDir: hostDir,
            sandboxRepoDir,
            hooks: {
              onSandboxCreate: [{ command: "exit 1" }],
            },
          },
          () =>
            Effect.sync(() => {
              callbackRan = true;
            }),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow();

    expect(callbackRan).toBe(false);
  });

  it("callback failure propagates (syncOut skipped)", async () => {
    const { hostDir, sandboxRepoDir, layer } = await setup();
    await initRepo(hostDir);
    await commitFile(hostDir, "file.txt", "original", "initial commit");

    await expect(
      Effect.runPromise(
        withSandboxLifecycle({ hostRepoDir: hostDir, sandboxRepoDir }, () =>
          Effect.fail(
            new ExecError({ command: "test", message: "callback failed" }),
          ),
        ).pipe(Effect.provide(Layer.merge(layer, testDisplayLayer))),
      ),
    ).rejects.toThrow("callback failed");

    // Host should be unchanged (no sync-out ran)
    const { stdout } = await execAsync("git log --oneline", { cwd: hostDir });
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });
});
