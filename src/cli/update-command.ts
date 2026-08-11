import {
  runUpdateCommand as runInstallerUpdateCommand,
  type UpdateCommandOptions,
} from "@pablozaiden/installer";
import type {
  CreateWebAppCliOptions,
  WebAppCliCommandDefinition,
} from "./create-web-app-cli";
import type { CliCommandResult } from "./runtime";
import type { CliOutput } from "./websocket-command";

interface UpdateCommandDependencies<TAppContext> {
  input: CreateWebAppCliOptions<TAppContext>;
  fetchFn: typeof fetch;
  stdout: CliOutput;
  stderr: CliOutput;
}

function parseUpdateArgs(
  args: readonly string[],
): UpdateCommandOptions | CliCommandResult {
  let checkOnly = false;
  let version: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--check") {
      if (checkOnly) {
        return { exitCode: 1, error: "update may only specify --check once" };
      }
      checkOnly = true;
      continue;
    }
    if (arg === "--version") {
      if (version !== undefined) {
        return { exitCode: 1, error: "update may only specify --version once" };
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { exitCode: 1, error: "--version requires a value" };
      }
      version = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--version=")) {
      if (version !== undefined) {
        return { exitCode: 1, error: "update may only specify --version once" };
      }
      const value = arg.slice("--version=".length);
      if (!value) {
        return { exitCode: 1, error: "--version requires a value" };
      }
      version = value;
      continue;
    }
    return { exitCode: 1, error: `Unknown update option: ${arg}` };
  }

  if (checkOnly && version !== undefined) {
    return { exitCode: 1, error: "Cannot combine --check with --version" };
  }
  return { checkOnly, version };
}

export function updateCommand<TAppContext>(
  dependencies: UpdateCommandDependencies<TAppContext>,
): WebAppCliCommandDefinition<TAppContext> {
  return {
    description: "Check for or install application release binaries.",
    usage: "update [--check] [--version VERSION]",
    handler: async ({ args }) => {
      const command = parseUpdateArgs(args);
      if ("exitCode" in command) return command;
      if (!dependencies.input.update) {
        return {
          exitCode: 1,
          error: "No application update configuration is configured",
        };
      }

      const exitCode = await runInstallerUpdateCommand(command, dependencies.input.update, {
        fetchFn: dependencies.fetchFn,
        out: (message) => dependencies.stdout.write(`${message}\n`),
        err: (message) => dependencies.stderr.write(`${message}\n`),
      });
      return { exitCode };
    },
  };
}
