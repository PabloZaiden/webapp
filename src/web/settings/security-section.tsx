import { startRegistration } from "@simplewebauthn/browser";
import { useCallback, useState } from "react";
import type { ApiKeySummary, CreatedApiKeyResponse, WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { useAsyncOperation } from "../async-operation";
import { ActionMenu, Button, CodeValue, ConfirmDialog, EmptyState } from "../components";
import { DateTimeValue } from "../date-time";
import { SettingsFieldRow } from "./settings-section";
import { log } from "../logger";
import { useLiveQuery } from "../realtime/useRealtime";
import { ResourceState } from "./resource-state";

export interface SecuritySectionProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
}

export function SecuritySection({ config, refresh }: SecuritySectionProps) {
  const [error, setError] = useState<string>();
  const [createdToken, setCreatedToken] = useState<string>();
  const [apiKeyToDelete, setApiKeyToDelete] = useState<ApiKeySummary>();
  const [confirmDeletePasskey, setConfirmDeletePasskey] = useState(false);
  const {
    pending: createKeyPending,
    start: startCreateKey,
    isCurrent: isCreateKeyCurrent,
    isMounted: isCreateKeyMounted,
    finish: finishCreateKey,
  } = useAsyncOperation({ abortOnUnmount: false });

  const loadApiKeys = useCallback(
    () => config.apiKeys.enabled
      ? appJson<ApiKeySummary[]>("/api/api-keys")
      : Promise.resolve<ApiKeySummary[]>([]),
    [config.apiKeys.enabled],
  );
  const { data: apiKeys, error: apiKeysLoadError, loading: apiKeysLoading, refresh: refreshApiKeys } = useLiveQuery<ApiKeySummary[]>({ load: loadApiKeys, realtime: false });

  async function createKey() {
    const operationToken = startCreateKey();
    if (!operationToken) {
      return;
    }
    setError(undefined);
    try {
      const result = await appJson<CreatedApiKeyResponse>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: "Browser key", scopes: ["*"] }),
        signal: operationToken.signal,
      });
      if (!isCreateKeyCurrent(operationToken)) {
        await revokeUnpresentableKey(result.key.id);
        return;
      }
      setCreatedToken(result.token);
      await refreshApiKeys();
    } catch (err) {
      if (isCreateKeyCurrent(operationToken)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      finishCreateKey(operationToken);
    }
  }

  async function revokeUnpresentableKey(id: string) {
    try {
      await appJson(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCreateKeyMounted()) {
        setError(message);
      } else {
        log.error(`Failed to revoke unpresentable API key ${id}.`, err);
      }
    }
  }

  async function deleteKey(id: string) {
    try {
      setError(undefined);
      await appJson(`/api/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
      setApiKeyToDelete(undefined);
      await refreshApiKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function setupPasskey() {
    try {
      setError(undefined);
      const options = await appJson<PublicKeyCredentialCreationOptionsJSON>("/api/passkey-auth/owner-setup/options", { method: "POST", body: "{}" });
      const credential = await startRegistration({ optionsJSON: options as never });
      await appJson("/api/passkey-auth/owner-setup/verify", { method: "POST", body: JSON.stringify(credential) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    await appJson("/api/passkey-auth/logout", { method: "POST", body: "{}" });
    await refresh();
  }

  async function deleteConfiguredPasskey() {
    await appJson("/api/passkey-auth/passkey", { method: "DELETE" });
    setConfirmDeletePasskey(false);
    await refresh();
  }

  return (
    <>
      <SettingsFieldRow title="Passkey" description={config.passkeyAuth.passkeyConfigured ? "Configured" : "Not configured"} actions={
        <div className="wapp-row-actions">
          {config.passkeyAuth.passkeyConfigured ? (
            <>
              <Button type="button" onClick={() => void logout()}>Logout</Button>
              <ActionMenu ariaLabel="Passkey actions" items={[{ label: "Delete passkey", destructive: true, onAction: () => setConfirmDeletePasskey(true) }]} />
            </>
          ) : (
            config.currentUser?.isOwner ? <Button type="button" variant="primary" onClick={() => void setupPasskey()}>Set up passkey</Button> : null
          )}
        </div>} />
      {config.apiKeys.enabled ? (
        <>
          <SettingsFieldRow title="API keys" actions={<Button type="button" loading={createKeyPending} onClick={() => void createKey()}>Create key</Button>} />
          <div className="wapp-settings-row-content">
            {createdToken ? <CodeValue label="New API key" value={createdToken} /> : null}
            <ResourceState loading={apiKeysLoading} error={apiKeysLoadError} hasData={apiKeys !== undefined} refresh={refreshApiKeys} />
            {apiKeys?.length ? (
              <div className="wapp-list">
                {apiKeys.map((key) => (
                  <div className="wapp-list-row" key={key.id}>
                    <span><strong>{key.name}</strong><small>{key.scopes.join(", ")} · <DateTimeValue value={key.createdAt} /></small></span>
                    <ActionMenu ariaLabel={`Actions for ${key.name}`} items={[{ label: "Delete key", destructive: true, onAction: () => setApiKeyToDelete(key) }]} />
                  </div>
                ))}
              </div>
            ) : apiKeys !== undefined && !apiKeysLoadError ? <EmptyState title="No API keys" /> : null}
          </div>
        </>
      ) : null}
      {error ? <p className="wapp-error" role="alert">{error}</p> : null}
      <ConfirmDialog
        open={Boolean(apiKeyToDelete)}
        title="Delete API key?"
        message={apiKeyToDelete ? `This permanently deletes "${apiKeyToDelete.name}". Scripts and agents using this token will stop working.` : ""}
        confirmLabel="Delete API key"
        danger
        onCancel={() => setApiKeyToDelete(undefined)}
        onConfirm={() => apiKeyToDelete && void deleteKey(apiKeyToDelete.id)}
      />
      <ConfirmDialog open={confirmDeletePasskey} title="Delete passkey?" message="This removes the configured passkey and invalidates browser sessions." confirmLabel="Delete passkey" danger onCancel={() => setConfirmDeletePasskey(false)} onConfirm={() => void deleteConfiguredPasskey()} />
    </>
  );
}
