import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readConfig } from "./Config.js";
import { DEFAULT_MODEL } from "./Orchestrator.js";
import {
  buildImage,
  cleanupContainer,
  startContainer,
} from "./DockerLifecycle.js";
import { scaffold } from "./InitService.js";
import { run } from "./run.js";
import { getAgentProvider } from "./AgentProvider.js";
import { AgentError, ConfigDirError, InitError } from "./errors.js";
import { DockerSandboxFactory, SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";
import { resolveEnv } from "./EnvResolver.js";

// --- Shared options ---

const containerOption = Options.text("container").pipe(
  Options.withDescription("Docker container name"),
  Options.withDefault("claude-sandbox"),
);

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.withDefault("sandcastle:local"),
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent provider to use (e.g. claude-code)"),
  Options.optional,
);

// --- Config directory check ---

const CONFIG_DIR = ".sandcastle";

const requireConfigDir = (cwd: string): Effect.Effect<void, ConfigDirError> =>
  Effect.tryPromise({
    try: () => access(join(cwd, CONFIG_DIR)),
    catch: () =>
      new ConfigDirError({
        message: "No .sandcastle/ found. Run `sandcastle init` first.",
      }),
  });

// --- Init command ---

const initCommand = Command.make(
  "init",
  {
    container: containerOption,
    imageName: imageNameOption,
    agent: agentOption,
  },
  ({ container, imageName, agent }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();

      // Resolve agent provider: CLI flag > default
      const agentName = agent._tag === "Some" ? agent.value : "claude-code";
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agentName),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      yield* Console.log("Scaffolding .sandcastle/ config directory...");
      yield* Effect.tryPromise({
        try: () => scaffold(cwd, provider),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });
      yield* Console.log("Config directory created.");

      // Resolve env vars and run agent provider's env check
      const env = yield* Effect.tryPromise({
        try: () => resolveEnv(cwd),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      yield* Effect.try({
        try: () => provider.envCheck(env),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      // Build image from .sandcastle/ directory
      const dockerfileDir = join(cwd, CONFIG_DIR);
      yield* Console.log(`Building Docker image '${imageName}'...`);
      yield* buildImage(imageName, dockerfileDir);

      // Start container
      yield* Console.log(`Starting container '${container}'...`);
      yield* startContainer(container, imageName, env);

      yield* Console.log(`Init complete! Container '${container}' is running.`);
    }),
);

// --- Setup-sandbox command ---

const setupSandboxCommand = Command.make(
  "setup-sandbox",
  {
    container: containerOption,
    imageName: imageNameOption,
    agent: agentOption,
  },
  ({ container, imageName, agent }) =>
    Effect.gen(function* () {
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      // Resolve agent provider: CLI flag > config > default
      const config = yield* readConfig(cwd);
      const agentName =
        agent._tag === "Some" ? agent.value : (config.agent ?? "claude-code");
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agentName),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      // Resolve env vars and run agent provider's env check
      const env = yield* Effect.tryPromise({
        try: () => resolveEnv(cwd),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      yield* Effect.try({
        try: () => provider.envCheck(env),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      const dockerfileDir = join(cwd, CONFIG_DIR);
      yield* Console.log(`Building Docker image '${imageName}'...`);
      yield* buildImage(imageName, dockerfileDir);

      yield* Console.log(`Starting container '${container}'...`);
      yield* startContainer(container, imageName, env);

      yield* Console.log(
        `Setup complete! Container '${container}' is running.`,
      );
    }),
);

// --- Cleanup-sandbox command ---

const cleanupSandboxCommand = Command.make(
  "cleanup-sandbox",
  {
    container: containerOption,
    imageName: imageNameOption,
  },
  ({ container, imageName }) =>
    Effect.gen(function* () {
      yield* Console.log(`Cleaning up container '${container}'...`);
      yield* cleanupContainer(container, imageName);
      yield* Console.log("Cleanup complete.");
    }),
);

// --- Run command ---

const iterationsOption = Options.integer("iterations").pipe(
  Options.withDescription("Number of agent iterations to run"),
  Options.optional,
);

const promptOption = Options.text("prompt").pipe(
  Options.withDescription("Inline prompt string for the agent"),
  Options.optional,
);

const promptFileOption = Options.file("prompt-file").pipe(
  Options.withDescription("Path to the prompt file for the agent"),
  Options.optional,
);

const branchOption = Options.text("branch").pipe(
  Options.withDescription("Target branch name for sandbox work"),
  Options.optional,
);

const modelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6)",
  ),
  Options.optional,
);

const runCommand = Command.make(
  "run",
  {
    iterations: iterationsOption,
    imageName: imageNameOption,
    prompt: promptOption,
    promptFile: promptFileOption,
    branch: branchOption,
    model: modelOption,
    agent: agentOption,
  },
  ({ iterations, imageName, prompt, promptFile, branch, model, agent }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      // Read config to resolve iterations: CLI flag > config > default (5)
      const config = yield* readConfig(hostRepoDir);
      const resolvedIterations =
        iterations._tag === "Some"
          ? iterations.value
          : (config.defaultMaxIterations ?? 5);

      const resolvedBranch = branch._tag === "Some" ? branch.value : undefined;
      const resolvedModel = model._tag === "Some" ? model.value : undefined;
      const resolvedAgent = agent._tag === "Some" ? agent.value : undefined;

      yield* Console.log(`=== SANDCASTLE RUN ===`);
      yield* Console.log(`Image:      ${imageName}`);
      yield* Console.log(`Iterations: ${resolvedIterations}`);
      if (resolvedBranch) {
        yield* Console.log(`Branch:     ${resolvedBranch}`);
      }
      if (resolvedModel) {
        yield* Console.log(`Model:      ${resolvedModel}`);
      }
      yield* Console.log(``);

      const result = yield* Effect.tryPromise({
        try: () =>
          run({
            prompt: prompt._tag === "Some" ? prompt.value : undefined,
            promptFile:
              promptFile._tag === "Some"
                ? resolve(promptFile.value)
                : undefined,
            maxIterations: resolvedIterations,
            branch: resolvedBranch,
            model: resolvedModel,
            agent: resolvedAgent,
            _imageName: imageName,
          }),
        catch: (e) =>
          new AgentError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      if (result.complete) {
        yield* Console.log(
          `\nRun complete: agent finished after ${result.iterationsRun} iteration(s).`,
        );
      } else {
        yield* Console.log(
          `\nRun complete: reached ${result.iterationsRun} iteration(s) without completion signal.`,
        );
      }
    }),
);

// --- Interactive command ---

const SANDBOX_REPOS_DIR = "/home/agent/repos";

const interactiveSession = (options: {
  hostRepoDir: string;
  sandboxRepoDir: string;
  config: import("./Config.js").SandcastleConfig;
  model?: string;
}): Effect.Effect<void, import("./errors.js").SandboxError, SandboxFactory> =>
  Effect.gen(function* () {
    const { hostRepoDir, sandboxRepoDir, config } = options;
    const resolvedModel = options.model ?? config.model ?? DEFAULT_MODEL;
    const factory = yield* SandboxFactory;

    yield* factory.withSandbox(
      withSandboxLifecycle(
        { hostRepoDir, sandboxRepoDir, hooks: config?.hooks },
        (ctx) =>
          Effect.gen(function* () {
            // Get container ID for docker exec -it
            const hostnameResult = yield* ctx.sandbox.exec("hostname");
            const containerId = hostnameResult.stdout.trim();

            // Launch interactive Claude session with TTY passthrough
            yield* Console.log("Launching interactive Claude session...");
            yield* Console.log("");

            const exitCode = yield* Effect.async<number, AgentError>(
              (resume) => {
                const proc = spawn(
                  "docker",
                  [
                    "exec",
                    "-it",
                    "-w",
                    ctx.sandboxRepoDir,
                    containerId,
                    "claude",
                    "--dangerously-skip-permissions",
                    "--model",
                    resolvedModel,
                  ],
                  { stdio: "inherit" },
                );

                proc.on("error", (error) => {
                  resume(
                    Effect.fail(
                      new AgentError({
                        message: `Failed to launch Claude: ${error.message}`,
                      }),
                    ),
                  );
                });

                proc.on("close", (code) => {
                  resume(Effect.succeed(code ?? 0));
                });
              },
            );

            yield* Console.log("");
            yield* Console.log(
              `Session ended (exit code ${exitCode}). Syncing changes back...`,
            );
          }),
      ),
    );
  });

const interactiveCommand = Command.make(
  "interactive",
  {
    imageName: imageNameOption,
    model: modelOption,
    agent: agentOption,
  },
  ({ imageName, model, agent }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      // Resolve agent provider: CLI flag > config > default
      const config = yield* readConfig(hostRepoDir);
      const agentName =
        agent._tag === "Some" ? agent.value : (config.agent ?? "claude-code");
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agentName),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      // Resolve env vars and run agent provider's env check
      const env = yield* Effect.tryPromise({
        try: () => resolveEnv(hostRepoDir),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      yield* Effect.try({
        try: () => provider.envCheck(env),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      const resolvedModel = model._tag === "Some" ? model.value : undefined;

      yield* Console.log("=== SANDCASTLE (Interactive) ===");
      yield* Console.log(`Image: ${imageName}`);
      yield* Console.log("");

      const factoryLayer = DockerSandboxFactory.layer(imageName, env);

      yield* interactiveSession({
        hostRepoDir,
        sandboxRepoDir,
        config,
        model: resolvedModel,
      }).pipe(Effect.provide(factoryLayer));
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Sandcastle v0.0.1");
    yield* Console.log("Use --help to see available commands.");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    setupSandboxCommand,
    cleanupSandboxCommand,
    runCommand,
    interactiveCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
