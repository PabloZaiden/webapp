import { z } from "zod";
import { findRouteCatalogEntry, type RouteCatalogEntry } from "../server/route-catalog";
import {
  forceRefreshCliAuth,
  resolveCliAuth,
  type CliAuthSource,
} from "./auth-resolution";
import type {
  DeviceCredentialsStore,
  StoredDeviceCredentials,
} from "./device-auth";
import type { CliEnvironment } from "./environment-auth";
import { readOption, type CliCommandResult } from "./runtime";

export type ApiCliCredentialsStore = DeviceCredentialsStore & {
  read(): Promise<StoredDeviceCredentials | undefined>;
};

export interface ApiCliCommandOptions {
  catalog: readonly RouteCatalogEntry[];
  args: string[];
  mode?: "api" | "schema";
  baseUrl?: string;
  responseFormat?: "envelope" | "body";
  credentials?: ApiCliCredentialsStore;
  envPrefix?: string;
  environment?: CliEnvironment;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

function schemaJson(schema: unknown): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodTypeAny);
  } catch {
    return schema;
  }
}

function listOutput(catalog: readonly RouteCatalogEntry[]): string {
  return catalog
    .filter((entry) => entry.path.startsWith("/api/"))
    .map((entry) => `${entry.methods.join(", ")} ${entry.cliPath}${entry.description ? ` - ${entry.description}` : ""}`)
    .join("\n");
}

function schemaOutput(entry: RouteCatalogEntry): string {
  return JSON.stringify({
    path: entry.path,
    cliPath: entry.cliPath,
    methods: entry.methods,
    auth: entry.auth,
    sameOrigin: entry.sameOrigin,
    scopes: entry.scopes,
    description: entry.description,
    tags: entry.tags,
    querySchema: schemaJson(entry.querySchema),
    requestSchema: schemaJson(entry.requestSchema),
    responseSchema: schemaJson(entry.responseSchema),
  }, null, 2);
}

function endpointArg(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("--"));
}

interface ResolvedApiCliAuth {
  headers: Headers;
  source: CliAuthSource;
  baseUrl?: string;
  accessToken?: string;
}

async function resolveAuth(input: ApiCliCommandOptions): Promise<ResolvedApiCliAuth> {
  const auth = await resolveCliAuth({
    credentials: input.credentials,
    envPrefix: input.envPrefix,
    environment: input.environment,
    explicitBaseUrl: input.baseUrl,
    fetchFn: input.fetchFn,
    now: input.now,
  });
  auth.headers.set("accept", "application/json");
  return auth;
}

export async function runApiCliCommand(input: ApiCliCommandOptions): Promise<CliCommandResult> {
  const endpoint = endpointArg(input.args);
  if (!endpoint) {
    return { exitCode: 0, output: listOutput(input.catalog) };
  }
  const match = findRouteCatalogEntry(input.catalog, endpoint);
  if (!match) {
    return { exitCode: 1, error: `Unknown API endpoint: ${endpoint}` };
  }
  if (input.mode === "schema") {
    return { exitCode: 0, output: schemaOutput(match.entry) };
  }
  const method = (readOption(input.args, ["--method", "-X"]) ?? match.entry.methods[0] ?? "GET").toUpperCase();
  if (!match.entry.methods.includes(method as never)) {
    return { exitCode: 1, error: `Method ${method} is not available for ${match.entry.cliPath}` };
  }
  const payload = readOption(input.args, ["--payload", "--data", "-d"]);
  const auth = await resolveAuth(input);
  const baseUrl = (input.baseUrl ?? auth.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${match.path}`);
  const headers = auth.headers;
  const rejectedAccessToken = auth.accessToken;
  let body: string | undefined;
  if (payload !== undefined) {
    JSON.parse(payload) as unknown;
    body = payload;
    headers.set("content-type", "application/json");
  }
  const send = () => (input.fetchFn ?? fetch)(url, { method, headers, body });
  let response = await send();
  if (
    response.status === 401 &&
    auth.source === "device" &&
    input.credentials &&
    rejectedAccessToken
  ) {
    const refreshed = await forceRefreshCliAuth({
      credentials: input.credentials,
      rejectedAccessToken,
      fetchFn: input.fetchFn,
      now: input.now,
    });
    if (refreshed) {
      headers.set("authorization", refreshed.headers.get("authorization")!);
      response = await send();
    }
  }
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) as unknown : null;
  } catch {
    parsed = text || null;
  }
  const output = input.responseFormat === "body"
    ? text
    : JSON.stringify({
      status: { code: response.status, ok: response.ok, text: response.statusText },
      response: parsed,
    }, null, 2);
  return {
    exitCode: response.ok ? 0 : 1,
    output: output ?? "",
  };
}
