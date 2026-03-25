import { Command, Options } from "@effect/cli";
import { Effect, Layer } from "effect";
import * as clack from "@clack/prompts";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readConfig } from "./Config.js";
import { Display } from "./Display.js";
import { DEFAULT_MODEL } from "./Orchestrator.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import { scaffold } from "./InitService.js";
import { run } from "./run.js";
import { getAgentProvider } from "./AgentProvider.js";
import { AgentError, ConfigDirError, InitError } from "./errors.js";
import {
  DockerSandboxFactory,
  SandboxConfig,
  SandboxFactory,
} from "./SandboxFactory.js";
import { withSandboxLifecycle } from "./SandboxLifecycle.js";
import { resolveEnv } from "./EnvResolver.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const DEFAULT_IMAGE_NAME = "sandcastle:local";

const resolveImageName = (
  cliFlag: import("effect").Option.Option<string>,
  config?: import("./Config.js").SandcastleConfig,
): string =>
  cliFlag._tag === "Some"
    ? cliFlag.value
    : (config?.imageName ?? DEFAULT_IMAGE_NAME);

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
    imageName: imageNameOption,
    agent: agentOption,
  },
  ({ imageName: imageNameFlag, agent }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag);

      // Resolve agent provider: CLI flag > default
      const agentName = agent._tag === "Some" ? agent.value : "claude-code";
      const provider = yield* Effect.try({
        try: () => getAgentProvider(agentName),
        catch: (e) =>
          new InitError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      yield* d.spinner(
        "Scaffolding .sandcastle/ config directory...",
        Effect.tryPromise({
          try: () => scaffold(cwd, provider),
          catch: (e) =>
            new InitError({
              message: `${e instanceof Error ? e.message : e}`,
            }),
        }),
      );

      // Prompt user before building image
      const shouldBuild = yield* Effect.promise(() =>
        clack.confirm({
          message: "Build the default Docker image now?",
          initialValue: true,
        }),
      );

      if (shouldBuild === true) {
        const dockerfileDir = join(cwd, CONFIG_DIR);
        yield* d.spinner(
          `Building Docker image '${imageName}'...`,
          buildImage(imageName, dockerfileDir),
        );
        yield* d.status("Init complete! Image built successfully.", "success");
      } else {
        yield* d.status(
          "Init complete! Run `sandcastle build-image` to build the Docker image later.",
          "success",
        );
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const config = yield* readConfig(cwd);
      const imageName = resolveImageName(imageNameFlag, config);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;
      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const config = yield* readConfig(cwd);
      const imageName = resolveImageName(imageNameFlag, config);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
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
  ({
    iterations,
    imageName: imageNameFlag,
    prompt,
    promptFile,
    branch,
    model,
    agent,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
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
      const resolvedImageName = resolveImageName(imageNameFlag, config);

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
            imageName: resolvedImageName,
          }),
        catch: (e) =>
          new AgentError({
            message: `${e instanceof Error ? e.message : e}`,
          }),
      });

      if (result.wasCompletionSignalDetected) {
        yield* d.status(
          `Run complete: agent finished after ${result.iterationsRun} iteration(s).`,
          "success",
        );
      } else {
        yield* d.status(
          `Run complete: reached ${result.iterationsRun} iteration(s) without completion signal.`,
          "warn",
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
}): Effect.Effect<
  void,
  import("./errors.js").SandboxError,
  SandboxFactory | Display
> =>
  Effect.gen(function* () {
    const { hostRepoDir, sandboxRepoDir, config } = options;
    const resolvedModel = options.model ?? config.model ?? DEFAULT_MODEL;
    const factory = yield* SandboxFactory;
    const d = yield* Display;

    yield* factory.withSandbox(
      withSandboxLifecycle(
        { hostRepoDir, sandboxRepoDir, hooks: config?.hooks },
        (ctx) =>
          Effect.gen(function* () {
            // Get container ID for docker exec -it
            const hostnameResult = yield* ctx.sandbox.exec("hostname");
            const containerId = hostnameResult.stdout.trim();

            // Launch interactive Claude session with TTY passthrough
            yield* d.status("Launching interactive Claude session...", "info");

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

            yield* d.status(
              `Session ended (exit code ${exitCode}). Syncing changes back...`,
              "info",
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
  ({ imageName: imageNameFlag, model, agent }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      yield* requireConfigDir(hostRepoDir);

      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      // Resolve agent provider: CLI flag > config > default
      const config = yield* readConfig(hostRepoDir);
      const imageName = resolveImageName(imageNameFlag, config);
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

      const d = yield* Display;
      yield* d.summary("Sandcastle Interactive", { Image: imageName });

      const sandboxConfigLayer = Layer.succeed(SandboxConfig, {
        imageName,
        env,
      });
      const factoryLayer = Layer.provide(
        DockerSandboxFactory.layer,
        sandboxConfigLayer,
      );

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
    const d = yield* Display;
    yield* d.status("Sandcastle v0.0.1", "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    buildImageCommand,
    removeImageCommand,
    runCommand,
    interactiveCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
