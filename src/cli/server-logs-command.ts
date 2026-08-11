import type { RouteCatalogEntry } from "../server/route-catalog";
import { normalizeBaseUrl } from "./device-auth";
import { runApiCliCommand, type ApiCliCredentialsStore } from "./api-command";
import type { CliEnvironment } from "./environment-auth";
import { readOption, type CliCommandResult } from "./runtime";

const serverLogsRoute: RouteCatalogEntry = {
  path: "/api/server/logs",
  cliPath: "logs",
  methods: ["GET"],
  auth: "admin",
  sameOrigin: "never",
  scopes: [],
  description: "Retrieve the in-memory server log snapshot.",
  tags: ["server"],
};

export interface ServerLogsCliCommandOptions {
  envPrefix: string;
  args?: readonly string[];
  baseUrl?: string;
  fallbackBaseUrl?: string;
  credentials?: ApiCliCredentialsStore;
  environment?: CliEnvironment;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

export async function runServerLogsCliCommand(input: ServerLogsCliCommandOptions): Promise<CliCommandResult> {
  const requestedBaseUrl = input.baseUrl ?? readOption(input.args ?? [], ["--base-url"]);
  const baseUrl = requestedBaseUrl === undefined ? undefined : normalizeBaseUrl(requestedBaseUrl);
  return await runApiCliCommand({
    catalog: [serverLogsRoute],
    args: ["logs"],
    baseUrl,
    fallbackBaseUrl: input.fallbackBaseUrl,
    responseFormat: "body",
    credentials: input.credentials,
    envPrefix: input.envPrefix,
    environment: input.environment,
    fetchFn: input.fetchFn,
    now: input.now,
  });
}
