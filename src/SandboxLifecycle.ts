import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import type { SandboxError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";
import { execOk, syncIn, syncOut } from "./SyncService.js";

const execAsync = promisify(exec);

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandcastleConfig["hooks"];
  readonly branch?: string;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, hooks, branch } = options;

    // Setup: onSandboxCreate hooks, sync-in, onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        if (hooks?.onSandboxCreate?.length) {
          for (const hook of hooks.onSandboxCreate) {
            message(hook.command);
            yield* execOk(sandbox, hook.command);
          }
        }

        message("Syncing repo into sandbox");
        const syncResult = yield* syncIn(
          hostRepoDir,
          sandboxRepoDir,
          branch ? { branch } : undefined,
        );
        resolvedBranch = syncResult.branch;

        if (hooks?.onSandboxReady?.length) {
          for (const hook of hooks.onSandboxReady) {
            message(hook.command);
            yield* execOk(sandbox, hook.command, { cwd: sandboxRepoDir });
          }
        }
      }),
    );

    // Record base HEAD
    const baseHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Record HEAD on the target branch before sync-out
    const targetBranch = branch ?? resolvedBranch;
    const headBeforeSyncOut = yield* Effect.promise(async () => {
      const { stdout } = await execAsync(
        `git rev-parse "refs/heads/${targetBranch}"`,
        { cwd: hostRepoDir },
      );
      return stdout.trim();
    });

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    // Sync-out
    yield* display.spinner(
      "Syncing commits back to host",
      syncOut(
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        branch ? { branch } : undefined,
      ),
    );

    // Collect commits applied during sync-out
    const commits = yield* Effect.promise(async () => {
      const { stdout } = await execAsync(
        `git rev-list "${headBeforeSyncOut}..refs/heads/${targetBranch}" --reverse`,
        { cwd: hostRepoDir },
      );
      const lines = stdout.trim();
      if (!lines) return [];
      return lines.split("\n").map((sha) => ({ sha }));
    });

    return { result, branch: targetBranch, commits };
  });
