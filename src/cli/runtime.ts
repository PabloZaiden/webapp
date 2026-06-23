export interface CliCommandResult {
  exitCode: number;
  output?: string;
  error?: string;
}

export type CliCommandHandler = (args: string[]) => CliCommandResult | Promise<CliCommandResult>;

export function printCliResult(result: CliCommandResult, output: Pick<Console, "log" | "error"> = console): number {
  if (result.output) {
    output.log(result.output);
  }
  if (result.error) {
    output.error(result.error);
  }
  return result.exitCode;
}

export function readOption(args: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    for (const name of names) {
      if (arg === name) return args[index + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

export function hasFlag(args: readonly string[], names: readonly string[]): boolean {
  return args.some((arg) => names.includes(arg));
}

export async function dispatchCliCommand(input: {
  args: string[];
  commands: Record<string, CliCommandHandler>;
  defaultCommand?: string;
  help: string;
}): Promise<CliCommandResult> {
  const [rawCommand, ...rest] = input.args;
  const command = rawCommand && !rawCommand.startsWith("-") ? rawCommand : input.defaultCommand;
  if (!command || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return { exitCode: rawCommand ? 0 : 1, output: input.help };
  }
  const handler = input.commands[command];
  if (!handler) {
    return { exitCode: 1, error: `Unknown command: ${command}`, output: input.help };
  }
  return await handler(rawCommand === command ? rest : input.args);
}
