# @ai-hero/sandcastle

## 0.2.1

### Patch Changes

- fc62054: Fixed npm global install permission error in PI and Codex agent Dockerfiles by running `npm install -g` as root before switching to the `agent` user.

## 0.2.0

### Minor Changes

- 674e426: Add `{ mode: 'none' }` worktree variant that bind-mounts the host working directory directly into the sandbox container. No worktree is created, pruned, or cleaned up, and no merge step runs after iterations complete. Commits go directly onto the host's checked-out branch. `copyToSandbox` throws a runtime error with `mode: 'none'`. Both `SOURCE_BRANCH` and `TARGET_BRANCH` built-in prompt arguments resolve to the host's current branch.

### Patch Changes

- 77765bb: Add codex agent provider: `codex(model)` factory, stream parser for Codex CLI's `--json` JSONL output, Dockerfile template, init scaffolding, and CLI support
- 1f2134d: Add pi as a supported agent provider. `pi(model)` factory function is exported from `@ai-hero/sandcastle`. Pi's `--mode json` JSONL output is parsed correctly (message_update, tool_execution_start, agent_end events). `sandcastle init --agent pi` scaffolds a working setup with pi's Dockerfile and correct `main.ts`. `sandcastle interactive --agent pi` launches an interactive pi session.
- 3aff5f5: Refactor AgentProvider to runtime-only factory pattern. `run()` now requires `agent: claudeCode("model")` instead of `model: "..."`. The `claudeCode` factory and `AgentProvider` type are now exported from the package. Removed: `getAgentProvider`, `parseStreamJsonLine`, `formatToolCall`, `DEFAULT_MODEL` from public API.
- 75b4400: Bump default idle timeout from 5 minutes to 10 minutes to reduce spurious TimeoutError failures during long agent operations
- c62b429: Wire CLI interactive command for multi-agent support. The `interactive` command now accepts `--agent` and `--model` flags, uses the provider's `buildInteractiveArgs()` for docker exec, and displays the provider name in status messages.
- b1dd427: Add `createSandbox()` programmatic API for reusable sandboxes across multiple `run()` calls
- 54e76e0: Decouple init scaffolding from runtime providers. `envManifest` and `dockerfileTemplate` removed from `AgentProvider` interface. `sandcastle init` now has `--agent` and `--model` flags with interactive agent selection. Dockerfile templates owned by init's internal registry. Each template carries a static `.env.example` file copied as-is during scaffold. Scaffolded `main.ts` is rewritten with the selected agent factory and model.
- f35fa48: Log periodic idle warnings every minute of agent inactivity
- fabf0f7: Use run name instead of agent name in worktree and branch naming. When a `name` is provided to `run()`, worktree directories and temp branches now include the run name (e.g. `sandcastle/<name>/<timestamp>`) instead of the agent provider name. Renamed `sanitizeAgentName` to `sanitizeName`.
- cce183a: Replace top-level `branch` option on `RunOptions` with a `worktree` discriminated union that explicitly models two workspace modes: `{ mode: 'temp-branch' }` (default) and `{ mode: 'branch', branch: string }`. This is a breaking change — the old `branch` field is removed.

## 0.1.8

### Patch Changes

- 783b4cd: Base worktree cleanup on uncommitted changes rather than run success/failure.

  Previously, worktrees were always preserved on failure and always removed on success. Now the decision is based on whether the worktree has uncommitted changes (unstaged modifications, staged changes, or untracked files):
  - Success + clean worktree: remove silently (same as before)
  - Success + dirty worktree: preserve and print "uncommitted changes" message
  - Failure + clean worktree: remove and print "no uncommitted changes" message
  - Failure + dirty worktree: preserve with current preservation message

  `RunResult` now includes an optional `preservedWorktreePath` field set when a successful run leaves a worktree behind due to uncommitted changes. `TimeoutError.preservedWorktreePath` and `AgentError.preservedWorktreePath` are only set when the worktree is actually preserved (dirty), not on every failure.

## 0.1.7

### Patch Changes

- 5eef716: Inject `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` as built-in prompt arguments. These are available in any prompt without passing them via `promptArgs`. Passing either key in `promptArgs` now fails with an error.
- 78ef034: Fix sandbox crash on macOS by setting `HOME=/home/agent` in the container environment. Previously, Docker's `--user` flag caused `HOME` to default to `/`, making `git config --global` fail with a permission error on `//.gitconfig`.
- fed9a66: Replace wall-clock timeout with idle-based timeout that resets on each agent output event.
  - Rename `timeoutSeconds` → `idleTimeoutSeconds` in `RunOptions` and `OrchestrateOptions`
  - Change default from 1200s (20 min) to 300s (5 min)
  - Timeout now tracks from last received message (text or tool call), not run start
  - Error message updated to: "Agent idle for N seconds — no output received. Consider increasing the idle timeout with --idle-timeout."

- b16e0e0: Support multiple completion signals via `completionSignal: string | string[]`. The result field `wasCompletionSignalDetected: boolean` is replaced by `completionSignal?: string` — the matched signal string, or `undefined` if none fired.
- 0f48ef8: Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

  When a run session ends in failure, the sandbox (Docker container) is removed but the
  worktree is now preserved on the host. A message is printed with the worktree path and
  manual cleanup instructions. On successful completion, both the sandbox and worktree
  are removed as before.

  `TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
  so programmatic callers can inspect or build on the preserved worktree.

## 0.1.6

### Patch Changes

- 1cd8bdb: Remove single-branch shortcut in parallel-planner template; always use the merge agent

## 0.1.5

### Patch Changes

- 1cd8bdb: Close GitHub issue when single-branch merge is performed directly in parallel-planner template

## 0.1.4

### Patch Changes

- 8e08f7e: Document custom completion signal in the Early termination README section
- 6f9d3be: Fix CLI option tables to show correct default `--image-name` as `sandcastle:<repo-dir-name>` instead of `sandcastle:local`
- 4c94c5f: Fix README incorrectly describing `.sandcastle/prompt.md` as a default for `promptFile`. Neither `prompt` nor `promptFile` has a default — omitting both causes an error. The `.sandcastle/prompt.md` path is a convention scaffolded by `sandcastle init`, not an automatic fallback.
- 0d93587: Include run name in log filename to prevent overwrites in multi-agent workflows. When `name` is passed to `run()`, it is appended to the log filename (e.g. `main-implementer.log` instead of `main.log`).
- 26683b5: Lead the API section with a simple run() example before the full options reference.
- 3e32b7b: Remove `sandcastle interactive` CLI command documentation from README
- 762642e: Remove stale `patches/` entry from scaffolded `.sandcastle/.gitignore`. Nothing in Sandcastle creates a `.sandcastle/patches/` directory — the worktree-based architecture eliminated patch-based sync.

## 0.1.3

### Patch Changes

- 8b43a04: Remove pnpm/corepack from default sandbox Dockerfile template. The base Node.js image already includes npm, so the `corepack enable` step is unnecessary overhead. All init templates now use `npm install` and `npm run` instead of pnpm equivalents.
- 925506d: Replace pnpm with npm in README documentation
- 74b3f3b: Replace pnpm with npm in scaffold templates. All generated prompt files and main.ts hooks now use `npm install` and `npm run` instead of pnpm, consistent with the project's migration to npm.

## 0.1.2

### Patch Changes

- 3ece5cb: Removed unused `mkdir -p /home/agent/repos` from Dockerfile template. The workspace is bind-mounted at `/home/agent/workspace`, so this directory was never used.

## 0.1.1

### Patch Changes

- 0f61f59: Filter issue lists by `Sandcastle` label in all templates. `sandcastle init` now offers to create the label on the repo.

## 0.1.0

### Minor Changes

- a5cff39: Hide `agent` option from public API. The `agent` field has been removed from `RunOptions` and the `--agent` CLI flag has been removed from `init` and `interactive` commands. Agent selection is now hardcoded to `claude-code` internally. The agent provider system remains as an internal implementation detail.

### Patch Changes

- f11fd90: Add JSDoc comments to all public-facing type properties: `RunResult`, `LoggingOption`, and `PromptArgs`.
- 1fc5e32: Add kitchen-sink `run()` example to README with inline JSDoc-style comments on every option. Also updates the `RunOptions` table to remove the hidden `agent` field, fix the `maxIterations` default (1, not 5), fix the `timeoutSeconds` default (1200, not 900), update the `imageName` default, and add the missing `name` and `copyToSandbox` fields. Removes the removed `--agent` flag from the `sandcastle init` and `sandcastle interactive` CLI tables.
- b713226: Migrate from npm to pnpm across the project (issue #168).
  - Added `packageManager: "pnpm@10.7.0"` to `package.json`
  - Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
  - Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
  - Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
  - Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
  - Updated `README.md` development and hooks examples to use pnpm
  - Updated `InitService.ts` next-steps text to reference pnpm

- cd429c0: Replace --ff-only with regular merge for worktree merge-back (issue #162)

  When the agent finishes, Sandcastle now uses `git merge` instead of `git merge --ff-only` to integrate the temp branch back into the host branch. This allows users to make commits on the host branch while Sandcastle is running without causing merge-back failures. Fast-forward still happens naturally when the host branch hasn't moved; only the requirement that it _must_ fast-forward is removed.

- db3adec: Show run name instead of provider name in log-to-file summary (issue #160).

  When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.

- df9fe6c: Surface tool calls in run logs (issues #163, #164, #165, #166).

  `parseStreamJsonLine` now returns an array of events per line. Assistant messages may produce `text` and/or `tool_call` items. Tool calls are filtered to an allowlist (Bash, WebSearch, WebFetch, Agent) with per-tool arg extraction, and displayed interleaved with agent text output. The Display service gains a `toolCall(name, formattedArgs)` method rendered as a dim-styled step in terminal mode and a plain log line in log-to-file mode.

- dbe5989: Update 'How it works' section in README to describe the worktree-based architecture, replacing the outdated sync-in/sync-out description. Also fix related references to sync-in/sync-out throughout the README.
