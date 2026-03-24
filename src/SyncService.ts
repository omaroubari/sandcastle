import { Effect } from "effect";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { type FailedStep, buildRecoveryMessage } from "./RecoveryMessage.js";
import type { HookDefinition } from "./Config.js";
import {
  type ExecResult,
  Sandbox,
  SandboxError,
  type SandboxService,
} from "./Sandbox.js";

const execHost = (
  command: string,
  cwd: string,
): Effect.Effect<string, SandboxError> =>
  Effect.async<string, SandboxError>((resume) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resume(
            Effect.fail(
              new SandboxError(
                "execHost",
                `${command}: ${stderr?.toString() || error.message}`,
              ),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString()));
        }
      },
    );
  });

export const execOk = (
  sandbox: SandboxService,
  command: string,
  options?: { cwd?: string },
): Effect.Effect<ExecResult, SandboxError> =>
  Effect.flatMap(sandbox.exec(command, options), (result) =>
    result.exitCode !== 0
      ? Effect.fail(
          new SandboxError(
            "exec",
            `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr}`,
          ),
        )
      : Effect.succeed(result),
  );

export const runHooks = (
  hooks: readonly HookDefinition[] | undefined,
  options?: { cwd?: string },
): Effect.Effect<void, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    if (!hooks || hooks.length === 0) return;
    const sandbox = yield* Sandbox;
    for (const hook of hooks) {
      yield* execOk(sandbox, hook.command, options);
    }
  });

export const syncIn = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  options?: { branch?: string },
): Effect.Effect<{ branch: string }, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Get current branch from host
    const hostBranch = (yield* execHost(
      "git rev-parse --abbrev-ref HEAD",
      hostRepoDir,
    )).trim();

    // The branch to check out in the sandbox
    const branch = options?.branch ?? hostBranch;

    // Create git bundle on host
    const bundleDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-bundle-")),
    );
    const bundleHostPath = join(bundleDir, "repo.bundle");
    yield* execHost(`git bundle create "${bundleHostPath}" --all`, hostRepoDir);

    // Detect if --branch target exists on the host
    const branchExistsOnHost =
      branch !== hostBranch
        ? yield* Effect.map(
            Effect.either(
              execHost(
                `git rev-parse --verify "refs/heads/${branch}"`,
                hostRepoDir,
              ),
            ),
            (either) => either._tag === "Right",
          )
        : true; // hostBranch always exists

    // Create temp dir in sandbox for the bundle
    const sandboxTmpDir = (yield* execOk(
      sandbox,
      "mktemp -d -t sandcastle-XXXXXX",
    )).stdout.trim();
    const bundleSandboxPath = `${sandboxTmpDir}/repo.bundle`;

    // Copy bundle into sandbox
    yield* sandbox.copyIn(bundleHostPath, bundleSandboxPath);

    // Check if sandbox repo already initialized
    const gitCheck = yield* sandbox.exec(
      `test -d "${sandboxRepoDir}/.git" && echo yes || echo no`,
    );
    const repoExists = gitCheck.stdout.trim() === "yes";

    // Determine the ref to fetch and sync to
    const fetchRef = branchExistsOnHost ? branch : hostBranch;
    const isNewBranch = !branchExistsOnHost;

    if (repoExists) {
      // Fetch bundle into temp ref, reset to match host
      yield* execOk(
        sandbox,
        `git fetch "${bundleSandboxPath}" "${fetchRef}:refs/sandcastle/sync" --force`,
        { cwd: sandboxRepoDir },
      );
      if (isNewBranch) {
        // Create new branch from host HEAD
        yield* execOk(
          sandbox,
          `git checkout -B "${branch}" refs/sandcastle/sync`,
          { cwd: sandboxRepoDir },
        );
      } else {
        yield* execOk(
          sandbox,
          `git checkout -B "${branch}" refs/sandcastle/sync`,
          { cwd: sandboxRepoDir },
        );
        yield* execOk(sandbox, "git reset --hard refs/sandcastle/sync", {
          cwd: sandboxRepoDir,
        });
      }
      yield* execOk(sandbox, "git clean -fdx -e node_modules", {
        cwd: sandboxRepoDir,
      });
    } else {
      // Clone from bundle
      yield* execOk(
        sandbox,
        `git clone "${bundleSandboxPath}" "${sandboxRepoDir}"`,
      );
      if (branchExistsOnHost) {
        yield* execOk(sandbox, `git checkout "${branch}"`, {
          cwd: sandboxRepoDir,
        });
      } else {
        yield* execOk(sandbox, `git checkout "${hostBranch}"`, {
          cwd: sandboxRepoDir,
        });
        // Create new branch from host HEAD
        yield* execOk(sandbox, `git checkout -b "${branch}"`, {
          cwd: sandboxRepoDir,
        });
      }
    }

    // Configure remotes from host
    const hostRemotes = (yield* execHost("git remote -v", hostRepoDir)).trim();
    if (hostRemotes.length > 0) {
      // Parse unique remote names and their fetch URLs
      const remotes = new Map<string, string>();
      for (const line of hostRemotes.split("\n")) {
        const match = line.match(/^(\S+)\t(\S+)\s+\(fetch\)$/);
        if (match) {
          remotes.set(match[1]!, match[2]!);
        }
      }

      // Get existing sandbox remotes
      const sandboxRemotes = (yield* execOk(sandbox, "git remote", {
        cwd: sandboxRepoDir,
      })).stdout
        .trim()
        .split("\n")
        .filter((r) => r.length > 0);

      for (const [name, url] of remotes) {
        if (sandboxRemotes.includes(name)) {
          yield* execOk(sandbox, `git remote set-url "${name}" "${url}"`, {
            cwd: sandboxRepoDir,
          });
        } else {
          yield* execOk(sandbox, `git remote add "${name}" "${url}"`, {
            cwd: sandboxRepoDir,
          });
        }
      }

      // Remove sandbox remotes that don't exist on host
      for (const name of sandboxRemotes) {
        if (!remotes.has(name)) {
          yield* execOk(sandbox, `git remote remove "${name}"`, {
            cwd: sandboxRepoDir,
          });
        }
      }
    }

    // Clean up temp files
    yield* sandbox.exec(`rm -rf "${sandboxTmpDir}"`);
    yield* Effect.promise(() => rm(bundleDir, { recursive: true }));

    // Verify sync succeeded — compare against the ref we synced to
    const expectedHead = (yield* execHost(
      `git rev-parse "refs/heads/${fetchRef}"`,
      hostRepoDir,
    )).trim();
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (expectedHead !== sandboxHead) {
      yield* Effect.fail(
        new SandboxError(
          "syncIn",
          `HEAD mismatch after sync: host=${expectedHead} sandbox=${sandboxHead}`,
        ),
      );
    }

    return { branch };
  });

export const syncOut = (
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
  options?: { branch?: string },
): Effect.Effect<void, SandboxError, Sandbox> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;

    // Determine if we need worktree-based sync
    const targetBranch = options?.branch;
    const hostBranch = targetBranch
      ? (yield* execHost("git rev-parse --abbrev-ref HEAD", hostRepoDir)).trim()
      : undefined;
    const useWorktree = targetBranch != null && targetBranch !== hostBranch;

    if (useWorktree) {
      yield* syncOutViaWorktree(
        sandbox,
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        targetBranch,
      );
    } else {
      yield* syncOutDirect(sandbox, hostRepoDir, sandboxRepoDir, baseHead);
    }
  });

/** Format a timestamp as YYYYMMDD-HHMMSS */
const formatTimestamp = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

/** Create a unique timestamped directory under .sandcastle/patches/ */
const createPatchDir = async (hostRepoDir: string): Promise<string> => {
  const base = formatTimestamp(new Date());
  const patchesDir = join(hostRepoDir, ".sandcastle", "patches");
  await mkdir(patchesDir, { recursive: true });

  // Ensure uniqueness by appending a counter if the dir already exists
  let dir = join(patchesDir, base);
  let counter = 0;
  while (true) {
    try {
      await mkdir(dir);
      return dir;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        counter++;
        dir = join(patchesDir, `${base}-${counter}`);
      } else {
        throw e;
      }
    }
  }
};

/** Eagerly save all patch artifacts to .sandcastle/patches/<timestamp>/ */
const saveArtifacts = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<
  {
    patchDir: string;
    hasCommits: boolean;
    hasDiff: boolean;
    hasUntracked: boolean;
  },
  SandboxError
> =>
  Effect.gen(function* () {
    const patchDir = yield* Effect.promise(() => createPatchDir(hostRepoDir));

    let hasCommits = false;
    let hasDiff = false;
    let hasUntracked = false;

    // --- 1. Save committed patches ---
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (sandboxHead !== baseHead) {
      const countResult = yield* execOk(
        sandbox,
        `git rev-list "${baseHead}..HEAD" --count`,
        { cwd: sandboxRepoDir },
      );
      const commitCount = parseInt(countResult.stdout.trim(), 10);

      if (commitCount > 0) {
        hasCommits = true;
        const hostPatchDir = yield* generateAndCopyPatches(
          sandbox,
          sandboxRepoDir,
          baseHead,
        );
        // Move patch files into the persistent directory
        const patchFiles = (yield* Effect.promise(() =>
          readdir(hostPatchDir),
        )).filter((f) => f.endsWith(".patch"));
        for (const file of patchFiles) {
          yield* Effect.promise(() =>
            copyFile(join(hostPatchDir, file), join(patchDir, file)),
          );
        }
        yield* Effect.promise(() => rm(hostPatchDir, { recursive: true }));
      }
    }

    // --- 2. Save uncommitted diff ---
    const diffCheck = yield* sandbox.exec("git diff HEAD --quiet", {
      cwd: sandboxRepoDir,
    });
    if (diffCheck.exitCode !== 0) {
      hasDiff = true;
      const sandboxDiffDir = (yield* execOk(
        sandbox,
        "mktemp -d -t sandcastle-diff-XXXXXX",
      )).stdout.trim();
      const sandboxDiffFile = `${sandboxDiffDir}/changes.patch`;
      yield* execOk(sandbox, `git diff HEAD > "${sandboxDiffFile}"`, {
        cwd: sandboxRepoDir,
      });
      yield* sandbox.copyOut(sandboxDiffFile, join(patchDir, "changes.patch"));
      yield* sandbox.exec(`rm -rf "${sandboxDiffDir}"`);
    }

    // --- 3. Save untracked files ---
    const untrackedResult = yield* sandbox.exec(
      "git ls-files --others --exclude-standard",
      { cwd: sandboxRepoDir },
    );
    if (
      untrackedResult.exitCode === 0 &&
      untrackedResult.stdout.trim().length > 0
    ) {
      const untrackedFiles = untrackedResult.stdout
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);

      if (untrackedFiles.length > 0) {
        hasUntracked = true;
        const untrackedDir = join(patchDir, "untracked");
        yield* Effect.promise(() => mkdir(untrackedDir, { recursive: true }));

        for (const file of untrackedFiles) {
          const destPath = join(untrackedDir, file);
          const destDir = join(
            untrackedDir,
            file.split("/").slice(0, -1).join("/"),
          );
          if (destDir !== untrackedDir) {
            yield* Effect.promise(() => mkdir(destDir, { recursive: true }));
          }
          yield* sandbox.copyOut(`${sandboxRepoDir}/${file}`, destPath);
        }
      }
    }

    return { patchDir, hasCommits, hasDiff, hasUntracked };
  });

/** Apply patches directly to the host's current branch (existing behavior) */
const syncOutDirect = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Check if there's anything to do
    const diffCheck = yield* sandbox.exec("git diff HEAD --quiet", {
      cwd: sandboxRepoDir,
    });
    const untrackedResult = yield* sandbox.exec(
      "git ls-files --others --exclude-standard",
      { cwd: sandboxRepoDir },
    );
    const hasAnyChanges =
      sandboxHead !== baseHead ||
      diffCheck.exitCode !== 0 ||
      (untrackedResult.exitCode === 0 &&
        untrackedResult.stdout.trim().length > 0);

    if (!hasAnyChanges) return;

    // Phase 1: Eagerly save all artifacts
    const { patchDir, hasCommits, hasDiff, hasUntracked } =
      yield* saveArtifacts(sandbox, hostRepoDir, sandboxRepoDir, baseHead);

    // Phase 2: Apply from the saved directory, tracking which step we're on
    let currentStep: FailedStep | undefined;

    const applyEffect = Effect.gen(function* () {
      // Apply committed patches
      if (hasCommits) {
        currentStep = "commits";
        const patchFiles = (yield* Effect.promise(() => readdir(patchDir)))
          .filter((f) => f.endsWith(".patch") && f !== "changes.patch")
          .sort();

        // Abort any leftover git am session
        yield* Effect.ignore(execHost("git am --abort", hostRepoDir));

        for (const file of patchFiles) {
          yield* execHost(
            `git am --3way "${join(patchDir, file)}"`,
            hostRepoDir,
          );
        }
      }

      // Apply uncommitted diff
      if (hasDiff) {
        currentStep = "diff";
        yield* execHost(
          `git apply "${join(patchDir, "changes.patch")}"`,
          hostRepoDir,
        );
      }

      // Copy untracked files
      if (hasUntracked) {
        currentStep = "untracked";
        const untrackedDir = join(patchDir, "untracked");
        const files = yield* Effect.promise(() => readdir(untrackedDir));
        for (const file of files) {
          const src = join(untrackedDir, file);
          const dest = join(hostRepoDir, file);
          yield* Effect.promise(() => copyFile(src, dest));
        }
      }
    });

    // On success, clean up the patch directory. On failure, generate recovery message.
    yield* Effect.matchEffect(applyEffect, {
      onSuccess: () =>
        Effect.promise(() => rm(patchDir, { recursive: true, force: true })),
      onFailure: (error) => {
        const relativePatchDir = relative(hostRepoDir, patchDir);
        const recovery = currentStep
          ? buildRecoveryMessage({
              patchDir: relativePatchDir,
              failedStep: currentStep,
              hasCommits,
              hasDiff,
              hasUntracked,
            })
          : "";
        const errorMsg = error.message + (recovery ? `\n\n${recovery}` : "");
        return Effect.fail(new SandboxError(error.operation, errorMsg));
      },
    });
  });

/** Apply committed patches to a target branch via a temporary git worktree */
const syncOutViaWorktree = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
  targetBranch: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    // Check if there are new commits to apply
    const sandboxHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    if (sandboxHead === baseHead) {
      // No commits — nothing to do
      return;
    }

    const countResult = yield* execOk(
      sandbox,
      `git rev-list "${baseHead}..HEAD" --count`,
      { cwd: sandboxRepoDir },
    );
    const commitCount = parseInt(countResult.stdout.trim(), 10);
    if (commitCount === 0) return;

    // Phase 1: Eagerly save patches to persistent timestamped directory
    const patchDir = yield* Effect.promise(() => createPatchDir(hostRepoDir));
    const hostPatchDir = yield* generateAndCopyPatches(
      sandbox,
      sandboxRepoDir,
      baseHead,
    );
    // Move patch files into the persistent directory
    const patchFiles = (yield* Effect.promise(() =>
      readdir(hostPatchDir),
    )).filter((f) => f.endsWith(".patch"));
    for (const file of patchFiles) {
      yield* Effect.promise(() =>
        copyFile(join(hostPatchDir, file), join(patchDir, file)),
      );
    }
    yield* Effect.promise(() => rm(hostPatchDir, { recursive: true }));

    // Phase 2: Create worktree, apply patches
    const worktreeDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-worktree-")),
    );

    const applyEffect = Effect.ensuring(
      // Try: create worktree and apply patches
      Effect.gen(function* () {
        // Check if target branch already exists on host
        const branchExists = yield* Effect.map(
          Effect.either(
            execHost(
              `git rev-parse --verify "refs/heads/${targetBranch}"`,
              hostRepoDir,
            ),
          ),
          (either) => either._tag === "Right",
        );

        if (branchExists) {
          yield* execHost(
            `git worktree add "${worktreeDir}/wt" "${targetBranch}"`,
            hostRepoDir,
          );
        } else {
          yield* execHost(
            `git worktree add "${worktreeDir}/wt" -b "${targetBranch}" HEAD`,
            hostRepoDir,
          );
        }

        // Abort any leftover git am session
        yield* Effect.ignore(execHost("git am --abort", `${worktreeDir}/wt`));

        // Apply patches in the worktree
        const sortedFiles = (yield* Effect.promise(() => readdir(patchDir)))
          .filter((f) => f.endsWith(".patch"))
          .sort();

        for (const file of sortedFiles) {
          yield* execHost(
            `git am --3way "${join(patchDir, file)}"`,
            `${worktreeDir}/wt`,
          );
        }
      }),
      // Finally: always clean up worktree (but not patches)
      Effect.gen(function* () {
        yield* Effect.ignore(
          execHost(
            `git worktree remove "${worktreeDir}/wt" --force`,
            hostRepoDir,
          ),
        );
        yield* Effect.promise(() =>
          rm(worktreeDir, { recursive: true, force: true }),
        );
      }),
    );

    // On success, clean up patch dir. On failure, generate recovery message.
    yield* Effect.matchEffect(applyEffect, {
      onSuccess: () =>
        Effect.promise(() => rm(patchDir, { recursive: true, force: true })),
      onFailure: (error) => {
        const relativePatchDir = relative(hostRepoDir, patchDir);
        const recovery = buildRecoveryMessage({
          patchDir: relativePatchDir,
          failedStep: "commits",
          hasCommits: true,
          hasDiff: false,
          hasUntracked: false,
          branch: targetBranch,
        });
        const errorMsg = error.message + `\n\n${recovery}`;
        return Effect.fail(new SandboxError(error.operation, errorMsg));
      },
    });
  });

/** Generate format-patch files in sandbox and copy them to host temp dir */
const generateAndCopyPatches = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<string, SandboxError> =>
  Effect.gen(function* () {
    const sandboxPatchDir = (yield* execOk(
      sandbox,
      "mktemp -d -t sandcastle-patches-XXXXXX",
    )).stdout.trim();

    yield* execOk(
      sandbox,
      `git format-patch "${baseHead}..HEAD" -o "${sandboxPatchDir}"`,
      { cwd: sandboxRepoDir },
    );

    const hostPatchDir = yield* Effect.promise(() =>
      mkdtemp(join(tmpdir(), "sandcastle-patches-")),
    );

    const patchListResult = yield* execOk(
      sandbox,
      `ls "${sandboxPatchDir}"/*.patch`,
    );
    const patchFiles = patchListResult.stdout
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);

    for (const sandboxPatchPath of patchFiles) {
      const filename = sandboxPatchPath.split("/").pop()!;
      const hostPatchPath = join(hostPatchDir, filename);
      yield* sandbox.copyOut(sandboxPatchPath, hostPatchPath);
    }

    yield* sandbox.exec(`rm -rf "${sandboxPatchDir}"`);

    return hostPatchDir;
  });

/** Apply patches directly to a host repo dir */
const applyPatches = (
  sandbox: SandboxService,
  hostRepoDir: string,
  sandboxRepoDir: string,
  baseHead: string,
): Effect.Effect<void, SandboxError> =>
  Effect.gen(function* () {
    const countResult = yield* execOk(
      sandbox,
      `git rev-list "${baseHead}..HEAD" --count`,
      { cwd: sandboxRepoDir },
    );
    const commitCount = parseInt(countResult.stdout.trim(), 10);

    if (commitCount > 0) {
      const hostPatchDir = yield* generateAndCopyPatches(
        sandbox,
        sandboxRepoDir,
        baseHead,
      );

      // Abort any leftover git am session
      yield* Effect.ignore(execHost("git am --abort", hostRepoDir));

      // Apply patches in order
      const sortedFiles = (yield* Effect.promise(() => readdir(hostPatchDir)))
        .filter((f) => f.endsWith(".patch"))
        .sort();

      for (const file of sortedFiles) {
        yield* execHost(
          `git am --3way "${join(hostPatchDir, file)}"`,
          hostRepoDir,
        );
      }

      yield* Effect.promise(() => rm(hostPatchDir, { recursive: true }));
    }
  });
