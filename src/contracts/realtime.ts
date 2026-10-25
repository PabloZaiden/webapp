import { z } from "zod";

export type RealtimeAction = "created" | "updated" | "changed" | "deleted";
export type RealtimeKind = "state" | "content" | "action";
export const MAX_REALTIME_SUBSCRIPTIONS = 128;
export type RealtimeTarget = {
  resource?: string;
  id?: string;
  scope?: string;
  userId?: string;
} & Record<string, string | undefined>;

export interface RealtimePublication<TEvent = unknown> {
  event: TEvent;
  target: Readonly<RealtimeTarget>;
  kind: RealtimeKind;
}

export interface ResourceRealtimeEvent<TPayload = unknown> {
  type: `${string}.${RealtimeAction}`;
  resource: string;
  action: RealtimeAction;
  id?: string;
  scope?: string;
  payload?: TPayload;
}

const name = z.string().min(1).max(256);
const names = z.array(name).min(1).max(128);
export const realtimeInterestSchema = z.strictObject({
  kinds: z.array(z.enum(["state", "content", "action"])).min(1).max(3),
  resources: names.optional(),
  actions: z.array(z.enum(["created", "updated", "changed", "deleted"])).min(1).max(4).optional(),
  ids: names.optional(),
  scopes: names.optional(),
  types: names.optional(),
  targets: z.record(name, z.union([name, names])).refine(
    value => Object.keys(value).length <= 32 && !Object.hasOwn(value, "userId"),
    "Targets cannot select ownership and must contain at most 32 dimensions",
  ).optional(),
}).refine(value => Boolean(
  value.resources || value.actions || value.ids || value.scopes || value.types
  || (value.targets && Object.keys(value.targets).length),
), "A subscription requires a concrete interest");

export type RealtimeInterest = z.infer<typeof realtimeInterestSchema>;
const identity = { subscriptionId: name, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
export const realtimeClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe"), ...identity, interest: realtimeInterestSchema }),
  z.strictObject({ type: z.literal("unsubscribe"), ...identity }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;
export const realtimeServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribed"), ...identity }),
  z.strictObject({ type: z.literal("unsubscribed"), ...identity }),
  z.strictObject({
    type: z.literal("event"),
    subscriptions: z.array(z.strictObject(identity)).min(1).max(MAX_REALTIME_SUBSCRIPTIONS),
    event: z.unknown(),
  }),
  z.strictObject({ type: z.literal("pong") }),
  z.strictObject({
    type: z.literal("error"),
    code: z.enum(["invalid_message", "subscription_limit", "stale_generation", "backpressure"]),
    message: z.string(),
  }),
]);
export type RealtimeServerMessage<TEvent = unknown> =
  | Exclude<z.infer<typeof realtimeServerMessageSchema>, { type: "event" }>
  | { type: "event"; subscriptions: { subscriptionId: string; generation: number }[]; event: TEvent };

export function realtimeInterestMatches(
  interest: RealtimeInterest,
  kind: RealtimeKind,
  event: unknown,
  target: Record<string, string | undefined>,
): boolean {
  if (!interest.kinds.includes(kind)) return false;
  const fields = typeof event === "object" && event !== null ? event as Record<string, unknown> : {};
  const selectors = [["resources", "resource"], ["actions", "action"], ["ids", "id"], ["scopes", "scope"], ["types", "type"]] as const;
  for (const [selector, field] of selectors) {
    const values: readonly string[] | undefined = interest[selector];
    const value = fields[field] ?? target[field];
    if (values && (typeof value !== "string" || !values.includes(value))) return false;
  }
  for (const [key, selected] of Object.entries(interest.targets ?? {})) {
    const value = target[key];
    if (value === undefined || !(Array.isArray(selected) ? selected.includes(value) : selected === value)) return false;
  }
  return true;
}
