import type { UpdaterConfig } from "@pablozaiden/installer";
import type { RouteCatalogEntry } from "../server/route-catalog";
import { createBuiltInCommands } from "./built-in-commands";
import type { CliEnvironment } from "./environment-auth";
import {
  createCliProfileStore,
  type CliProfileStore,
} from "./profiles";
import {
  hasFlag,
  printCliResult,
  type CliCommandResult,
} from "./runtime";
import {
  type CliInput,
  type CliOutput,
  type CliSignalSource,
  type CliWebSocketFactory,
} from "./websocket-command";

export interface WebAppCliCommandContext<TAppContext = undefined> {
  command: string;
  args: string[];
  profile: string;
  profiles: CliProfileStore;
  envPrefix: string;
  environment: CliEnvironment;
  fetchFn: typeof fetch;
  stdin: CliInput;
  stdout: CliOutput;
  stderr: CliOutput;
  appContext: TAppContext;
}

export interface WebAppCliCommandDefinition<TAppContext = undefined> {
  description: string;
  usage?: string;
  override?: boolean;
  handler(
    context: WebAppCliCommandContext<TAppContext>,
  ): CliCommandResult | Promise<CliCommandResult>;
}

export type WebAppCliCommandMap<TAppContext = undefined> = Record<
  string,
  WebAppCliCommandDefinition<TAppContext>
>;

export interface CreateWebAppCliOptions<TAppContext = undefined> {
  appName: string;
  commandName: string;
  envPrefix: string;
  version: string;
  appDirectoryName?: string;
  realtimePath?: string;
  routeCatalog?:
    | readonly RouteCatalogEntry[]
    | (() => readonly RouteCatalogEntry[] | Promise<readonly RouteCatalogEntry[]>);
  profileStore?: CliProfileStore;
  environment?: CliEnvironment;
  fetchFn?: typeof fetch;
  stdin?: CliInput;
  stdout?: CliOutput;
  stderr?: CliOutput;
  webSocketFactory?: CliWebSocketFactory;
  signals?: CliSignalSource;
  start?: () => unknown | Promise<unknown>;
  config?: () => unknown | Promise<unknown>;
  update?: UpdaterConfig;
  commands?: WebAppCliCommandMap<TAppContext>;
  appContext?: TAppContext;
  clientId?: string;
}

export interface WebAppCli<TAppContext = undefined> {
  readonly commands: Readonly<WebAppCliCommandMap<TAppContext>>;
  help(command?: string): string;
  execute(args?: string[]): Promise<CliCommandResult>;
  run(args?: string[]): Promise<number>;
}

interface ParsedCliArgs {
  command?: string;
  args: string[];
  profile?: string;
}

function defaultInput(): CliInput {
  return Bun.stdin.stream() as unknown as CliInput;
}

function profileOption(args: readonly string[]): {
  profile?: string;
  remaining: string[];
  error?: string;
} {
  const remaining: string[] = [];
  let profile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--profile") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { remaining, error: "--profile requires a profile name" };
      }
      if (profile !== undefined) {
        return { remaining, error: "--profile may only be specified once" };
      }
      profile = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      if (profile !== undefined) {
        return { remaining, error: "--profile may only be specified once" };
      }
      profile = arg.slice("--profile=".length);
      if (!profile) {
        return { remaining, error: "--profile requires a profile name" };
      }
      continue;
    }
    remaining.push(arg);
  }
  return { profile, remaining };
}

function parseArgs(args: string[]): ParsedCliArgs | CliCommandResult {
  const global = profileOption(args);
  if (global.error) return { exitCode: 1, error: global.error };
  const [command, ...rest] = global.remaining;
  return { command, args: rest, profile: global.profile };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWebAppCli<TAppContext = undefined>(
  input: CreateWebAppCliOptions<TAppContext>,
): WebAppCli<TAppContext> {
  const environment = input.environment ?? process.env;
  const fetchFn = input.fetchFn ?? fetch;
  const stdin = input.stdin ?? defaultInput();
  const stdout = input.stdout ?? process.stdout;
  const stderr = input.stderr ?? process.stderr;
  const profiles = input.profileStore ?? createCliProfileStore({
    appDirectoryName: input.appDirectoryName ?? `.${input.commandName}`,
    envHome: `${input.envPrefix}_CLI_HOME`,
  });
  const realtimePath = input.realtimePath ?? "/api/ws";
  const appContext = input.appContext as TAppContext;

  async function contextFor(
    command: string,
    args: string[],
    explicitProfile?: string,
  ): Promise<WebAppCliCommandContext<TAppContext>> {
    return {
      command,
      args,
      profile: await profiles.selectedName(explicitProfile),
      profiles,
      envPrefix: input.envPrefix,
      environment,
      fetchFn,
      stdin,
      stdout,
      stderr,
      appContext,
    };
  }

  async function routeCatalog(): Promise<readonly RouteCatalogEntry[]> {
    if (typeof input.routeCatalog === "function") {
      return await input.routeCatalog();
    }
    return input.routeCatalog ?? [];
  }

  const builtIns = createBuiltInCommands({
    input,
    profiles,
    environment,
    fetchFn,
    stdin,
    stdout,
    stderr,
    realtimePath,
    routeCatalog,
    help: (command) => help(command),
    commandExists: (command) => Boolean(commands[command]),
  });

  const commands: WebAppCliCommandMap<TAppContext> = { ...builtIns };
  for (const [name, definition] of Object.entries(input.commands ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`Invalid CLI command name: ${name}`);
    }
    if (commands[name] && definition.override !== true) {
      throw new Error(`Command ${name} already exists; set override: true to replace it`);
    }
    commands[name] = definition;
  }

  function help(command?: string): string {
    if (command) {
      const definition = commands[command];
      if (!definition) return `Unknown command: ${command}`;
      return [
        `Usage: ${input.commandName} [--profile NAME] ${definition.usage ?? command}`,
        "",
        definition.description,
      ].join("\n");
    }
    const width = Math.max(...Object.keys(commands).map((name) => name.length));
    const lines = Object.entries(commands)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => `  ${name.padEnd(width)}  ${definition.description}`);
    return [
      `Usage: ${input.commandName} [--profile NAME] <command> [options]`,
      "",
      "Commands:",
      ...lines,
      "",
      "Global options:",
      "  --profile NAME  Select a credential profile for this command.",
      "  -h, --help      Show help.",
    ].join("\n");
  }

  async function execute(args = Bun.argv.slice(2)): Promise<CliCommandResult> {
    const parsed = parseArgs(args);
    if ("exitCode" in parsed) return parsed;
    if (
      parsed.command === undefined
      || parsed.command === "--help"
      || parsed.command === "-h"
    ) {
      return {
        exitCode: parsed.command === undefined ? 1 : 0,
        output: help(),
      };
    }
    const definition = commands[parsed.command];
    if (!definition) {
      return {
        exitCode: 1,
        error: `Unknown command: ${parsed.command}`,
        output: help(),
      };
    }
    if (hasFlag(parsed.args, ["--help", "-h"])) {
      return { exitCode: 0, output: help(parsed.command) };
    }
    try {
      return await definition.handler(
        await contextFor(parsed.command, parsed.args, parsed.profile),
      );
    } catch (error) {
      return { exitCode: 1, error: errorMessage(error) };
    }
  }

  return {
    commands,
    help,
    execute,
    async run(args) {
      return printCliResult(await execute(args), {
        log: (message) => stdout.write(`${String(message)}\n`),
        error: (message) => stderr.write(`${String(message)}\n`),
      });
    },
  };
}
