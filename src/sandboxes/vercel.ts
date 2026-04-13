/**
 * Vercel isolated sandbox provider — wraps `@vercel/sandbox` into a SandboxProvider.
 *
 * Usage:
 *   import { vercel } from "sandcastle/sandboxes/vercel";
 *   await run({ agent: claudeCode("claude-opus-4-6"), sandbox: vercel() });
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import {
  createIsolatedSandboxProvider,
  type ExecResult,
  type IsolatedSandboxHandle,
  type IsolatedSandboxProvider,
} from "../SandboxProvider.js";

/** Workspace path inside the Vercel sandbox. */
const VERCEL_WORKSPACE_PATH = "/vercel/sandbox/workspace";

/**
 * Options for creating a Vercel sandbox provider.
 *
 * All `@vercel/sandbox` `Sandbox.create()` options are accepted as pass-through,
 * plus Sandcastle-specific options for auth and branch strategy.
 */
export interface VercelOptions {
  /**
   * Vercel access token.
   *
   * Falls back to the SDK's default auth behavior, which reads
   * `VERCEL_OIDC_TOKEN` (recommended for Vercel-hosted environments) or
   * `VERCEL_TOKEN` from the environment.
   */
  readonly token?: string;

  // ---- Pass-through @vercel/sandbox Sandbox.create() options ----

  /**
   * The source of the sandbox (git repo, tarball, or snapshot).
   * Omit to start an empty sandbox.
   */
  readonly source?:
    | {
        type: "git";
        url: string;
        depth?: number;
        revision?: string;
        username?: string;
        password?: string;
      }
    | {
        type: "tarball";
        url: string;
      }
    | {
        type: "snapshot";
        snapshotId: string;
      };

  /** Array of port numbers to expose from the sandbox (up to 4). */
  readonly ports?: number[];

  /** Timeout in milliseconds before the sandbox auto-terminates. */
  readonly timeout?: number;

  /**
   * Resources to allocate to the sandbox.
   * Each vCPU gets 2048 MB of memory.
   */
  readonly resources?: {
    vcpus: number;
  };

  /**
   * The runtime of the sandbox (e.g. `"node24"`, `"node22"`, `"python3.13"`).
   * Defaults to `"node24"`.
   */
  readonly runtime?: string;

  /**
   * Network policy for the sandbox.
   * Defaults to full internet access if not specified.
   */
  readonly networkPolicy?: Record<string, unknown>;

  /**
   * Vercel project ID to associate sandbox operations with.
   */
  readonly projectId?: string;

  /**
   * Vercel team ID to associate sandbox operations with.
   */
  readonly teamId?: string;

  /**
   * Timeout in milliseconds (alias for `timeout`, kept for discoverability).
   */
  readonly timeoutMs?: number;

  /**
   * Sandbox template shorthand (e.g. `"node-22"`).
   * Maps to the `runtime` option.
   */
  readonly template?: string;
}

/**
 * Create a Vercel isolated sandbox provider.
 *
 * The returned provider creates Vercel Firecracker microVM sandboxes via
 * the `@vercel/sandbox` SDK. Each sandbox is ephemeral — one sandbox per run.
 *
 * Requires `@vercel/sandbox` to be installed as a peer dependency.
 */
export const vercel = (options?: VercelOptions): IsolatedSandboxProvider =>
  createIsolatedSandboxProvider({
    name: "vercel",
    create: async (createOptions): Promise<IsolatedSandboxHandle> => {
      // Dynamic import so the peer dependency is only loaded at runtime
      const { Sandbox } = await import("@vercel/sandbox");

      const createParams: Record<string, unknown> = {};

      // Pass through SDK options
      if (options?.source) createParams.source = options.source;
      if (options?.ports) createParams.ports = options.ports;
      if (options?.resources) createParams.resources = options.resources;
      if (options?.networkPolicy)
        createParams.networkPolicy = options.networkPolicy;
      // runtime takes precedence over the template convenience alias
      const resolvedRuntime = options?.runtime ?? options?.template;
      if (resolvedRuntime) createParams.runtime = resolvedRuntime;

      // Timeout: prefer explicit timeout, fall back to timeoutMs alias
      const timeoutValue = options?.timeout ?? options?.timeoutMs;
      if (timeoutValue !== undefined) createParams.timeout = timeoutValue;

      // Merge provider env with Sandcastle env
      createParams.env = createOptions.env;

      // Auth: pass token and team/project IDs if provided
      if (options?.token) createParams.token = options.token;
      if (options?.projectId) createParams.projectId = options.projectId;
      if (options?.teamId) createParams.teamId = options.teamId;

      const sandbox = await Sandbox.create(
        createParams as Parameters<typeof Sandbox.create>[0],
      );

      // Ensure workspace directory exists
      await sandbox.mkDir(VERCEL_WORKSPACE_PATH);

      const handle: IsolatedSandboxHandle = {
        workspacePath: VERCEL_WORKSPACE_PATH,

        exec: async (
          command: string,
          opts?: { cwd?: string },
        ): Promise<ExecResult> => {
          const result = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            cwd: opts?.cwd ?? VERCEL_WORKSPACE_PATH,
          });

          const stdout = await result.stdout();
          const stderr = await result.stderr();

          return {
            stdout,
            stderr,
            exitCode: result.exitCode,
          };
        },

        execStreaming: async (
          command: string,
          onLine: (line: string) => void,
          opts?: { cwd?: string },
        ): Promise<ExecResult> => {
          const stdoutLines: string[] = [];
          const stderrChunks: string[] = [];
          let partial = "";

          const stdoutWritable = new Writable({
            write(chunk, _encoding, callback) {
              const text = partial + chunk.toString();
              const lines = text.split("\n");
              partial = lines.pop() ?? "";
              for (const line of lines) {
                stdoutLines.push(line);
                onLine(line);
              }
              callback();
            },
            final(callback) {
              if (partial) {
                stdoutLines.push(partial);
                onLine(partial);
                partial = "";
              }
              callback();
            },
          });

          const stderrWritable = new Writable({
            write(chunk, _encoding, callback) {
              stderrChunks.push(chunk.toString());
              callback();
            },
          });

          const result = await sandbox.runCommand({
            cmd: "sh",
            args: ["-c", command],
            cwd: opts?.cwd ?? VERCEL_WORKSPACE_PATH,
            stdout: stdoutWritable,
            stderr: stderrWritable,
          });

          return {
            stdout: stdoutLines.join("\n"),
            stderr: stderrChunks.join(""),
            exitCode: result.exitCode,
          };
        },

        copyIn: async (
          hostPath: string,
          sandboxPath: string,
        ): Promise<void> => {
          const content = await readFile(hostPath);
          await sandbox.writeFiles([{ path: sandboxPath, content }]);
        },

        copyOut: async (
          sandboxPath: string,
          hostPath: string,
        ): Promise<void> => {
          const buffer = await sandbox.readFileToBuffer({
            path: sandboxPath,
          });
          if (!buffer) {
            throw new Error(`File not found in Vercel sandbox: ${sandboxPath}`);
          }
          await mkdir(dirname(hostPath), { recursive: true });
          await writeFile(hostPath, buffer);
        },

        close: async (): Promise<void> => {
          await sandbox.stop();
        },
      };

      return handle;
    },
  });
