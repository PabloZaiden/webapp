import { z } from "zod";

export const WEB_APP_CLIENT_CONFIG_PATH = "/webapp-client.json";

export const webAppClientBootstrapSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("integrated"),
    publicBasePath: z.string(),
  }).strict(),
  z.object({
    mode: z.literal("remote"),
    apiBaseUrl: z.string().optional(),
  }).strict(),
  z.object({
    mode: z.literal("external"),
  }).strict(),
]);

export type WebAppClientBootstrap = z.infer<typeof webAppClientBootstrapSchema>;
