import { expect, test } from "bun:test";
import { memoryWebAppStore } from "../src/server";
import type {
  AuditEventRecord,
  StoredPasskey,
  UserRecord,
  UserSetupLinkRecord,
} from "../src/server/auth/store";

const timestamp = "2026-01-01T00:00:00.000Z";

function user(id: string, username: string, role: UserRecord["role"] = "user"): UserRecord {
  return {
    id,
    username,
    role,
    authVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    passkeyConfigured: false,
  };
}

function passkey(id: string, userId: string, credentialId: string): StoredPasskey {
  return {
    id,
    userId,
    name: "Security key",
    credentialId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    transports: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

// This public store contract protects the one-time setup and auth-version
// boundary without requiring a live WebAuthn ceremony.
test("keeps a setup link and auth version unchanged on credential conflict", () => {
  const store = memoryWebAppStore();
  store.createUser(user("owner-id", "owner", "owner"));
  store.createUser(user("member-id", "member"));
  store.savePasskey(passkey("owner-passkey", "owner-id", "shared-credential"));

  const link: UserSetupLinkRecord = {
    id: "setup-id",
    userId: "member-id",
    tokenHash: "setup-token-hash",
    kind: "invite",
    createdByUserId: "owner-id",
    createdAt: timestamp,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  store.createSetupLink(link);

  const conflict = store.completeSetupLink(
    link.tokenHash,
    link.userId,
    passkey("member-passkey", "member-id", "shared-credential"),
    timestamp,
  );
  expect(conflict).toEqual({ kind: "conflict" });
  expect(store.getSetupLinkByTokenHash(link.tokenHash)?.consumedAt).toBeUndefined();
  expect(store.getUserById(link.userId)?.authVersion).toBe(1);

  const completed = store.completeSetupLink(
    link.tokenHash,
    link.userId,
    passkey("member-passkey", "member-id", "member-credential"),
    timestamp,
  );
  expect(completed.kind).toBe("completed");
  expect(store.getUserById(link.userId)).toMatchObject({
    authVersion: 2,
    passkeyConfigured: true,
  });
  expect(store.completeSetupLink(
    link.tokenHash,
    link.userId,
    passkey("replacement-passkey", "member-id", "replacement-credential"),
    timestamp,
  )).toEqual({ kind: "consumed" });
});

// An in-memory audit log must stay bounded for long-running processes.
test("retains only the newest 1,000 audit events", () => {
  const store = memoryWebAppStore();
  for (let index = 0; index <= 1_000; index += 1) {
    const event: AuditEventRecord = {
      id: `event-${index}`,
      eventType: "test",
      metadata: {},
      createdAt: new Date(index).toISOString(),
    };
    store.saveAuditEvent(event);
  }

  const events = store.listAuditEvents(1_001);
  expect(events).toHaveLength(1_000);
  expect(events[0]?.id).toBe("event-1000");
  expect(events.at(-1)?.id).toBe("event-1");
});
