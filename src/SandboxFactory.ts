import { Context, Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { DockerSandbox } from "./DockerSandbox.js";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "./DockerLifecycle.js";
import type { DockerError, WorktreeError } from "./errors.js";
import { Sandbox } from "./Sandbox.js";
import * as WorktreeManager from "./WorktreeManager.js";

/** The mount point inside the container where the project worktree is bound. */
export const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

export class SandboxConfig extends Context.Tag("SandboxConfig")<
  SandboxConfig,
  {
    readonly imageName: string;
    readonly env: Record<string, string>;
  }
>() {}

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree mode only). */
  readonly hostWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
    ) => Effect.Effect<A, E | DockerError | WorktreeError, Exclude<R, Sandbox>>;
    /** True in worktree mode — the repo is bind-mounted, so sync is unnecessary. */
    readonly skipSync: boolean;
  }
>() {}

/**
 * Synchronously force-remove a Docker container.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveContainerSync = (containerName: string): void => {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  } catch {
    // Best-effort — container may already be gone
  }
};

export class WorktreeSandboxConfig extends Context.Tag("WorktreeSandboxConfig")<
  WorktreeSandboxConfig,
  {
    readonly imageName: string;
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** When specified, the worktree checks out this branch. Otherwise a temp branch is created. */
    readonly branch?: string;
  }
>() {}

/**
 * Synchronously force-remove a git worktree.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveWorktreeSync = (
  worktreePath: string,
  repoDir: string,
): void => {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      stdio: "ignore",
      cwd: repoDir,
    });
  } catch {
    // Best-effort — worktree may already be gone
  }
};

/**
 * Worktree sandbox mode: creates a git worktree and bind-mounts it into the
 * container at SANDBOX_WORKSPACE_DIR. The host's .git directory is also bind-mounted at
 * its original host path so the worktree's .git file pointer resolves correctly.
 */
export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const { imageName, env, hostRepoDir, branch } =
        yield* WorktreeSandboxConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      return {
        skipSync: true,
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          A,
          E | DockerError | WorktreeError,
          Exclude<R, Sandbox>
        > => {
          const containerName = `sandcastle-${randomUUID()}`;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start container
            WorktreeManager.pruneStale(hostRepoDir)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    console.error(
                      "[sandcastle] Warning: failed to prune stale worktrees:",
                      e.message,
                    );
                  }),
                ),
              )
              .pipe(
                Effect.andThen(
                  branch
                    ? WorktreeManager.create(hostRepoDir, { branch })
                    : WorktreeManager.create(hostRepoDir),
                ),
              )
              .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
              .pipe(
                Effect.flatMap((worktreeInfo) => {
                  const gitDir = join(hostRepoDir, ".git");
                  const volumeMounts = [
                    `${worktreeInfo.path}:${SANDBOX_WORKSPACE_DIR}`,
                    `${gitDir}:${gitDir}`,
                  ];

                  const cleanup = () => {
                    forceRemoveContainerSync(containerName);
                    forceRemoveWorktreeSync(worktreeInfo.path, hostRepoDir);
                  };
                  const onSignal = () => {
                    cleanup();
                    process.exit(1);
                  };

                  const hostUid = process.getuid?.() ?? 1000;
                  const hostGid = process.getgid?.() ?? 1000;

                  return startContainer(containerName, imageName, env, {
                    volumeMounts,
                    workdir: SANDBOX_WORKSPACE_DIR,
                    user: `${hostUid}:${hostGid}`,
                  }).pipe(
                    Effect.andThen(
                      chownInContainer(
                        containerName,
                        `${hostUid}:${hostGid}`,
                        "/home/agent",
                      ),
                    ),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        process.on("exit", cleanup);
                        process.on("SIGINT", onSignal);
                        process.on("SIGTERM", onSignal);
                      }),
                    ),
                    Effect.map(() => ({ worktreeInfo, cleanup, onSignal })),
                  );
                }),
              ),
            // Use
            ({ worktreeInfo }) =>
              makeEffect({ hostWorktreePath: worktreeInfo.path }).pipe(
                Effect.provide(DockerSandbox.layer(containerName)),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            // Release: remove container, then remove worktree
            ({ worktreeInfo, cleanup, onSignal }) =>
              Effect.sync(() => {
                process.removeListener("exit", cleanup);
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
              }).pipe(
                Effect.andThen(removeContainer(containerName)),
                Effect.andThen(WorktreeManager.remove(worktreeInfo.path)),
                Effect.orDie,
              ),
          );
        },
      };
    }),
  ),
};

export const DockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const { imageName, env } = yield* SandboxConfig;
      return {
        skipSync: false,
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          A,
          E | DockerError | WorktreeError,
          Exclude<R, Sandbox>
        > => {
          const containerName = `sandcastle-${randomUUID()}`;

          const cleanup = () => forceRemoveContainerSync(containerName);
          const onSignal = () => {
            cleanup();
            process.exit(1);
          };

          return Effect.acquireUseRelease(
            startContainer(containerName, imageName, env).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  process.on("exit", cleanup);
                  process.on("SIGINT", onSignal);
                  process.on("SIGTERM", onSignal);
                }),
              ),
            ),
            () =>
              makeEffect({}).pipe(
                Effect.provide(DockerSandbox.layer(containerName)),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            () =>
              Effect.sync(() => {
                process.removeListener("exit", cleanup);
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
              }).pipe(
                Effect.andThen(removeContainer(containerName)),
                Effect.orDie,
              ),
          );
        },
      };
    }),
  ),
};
