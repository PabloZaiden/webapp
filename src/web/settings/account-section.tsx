import { useState } from "react";
import { VALID_LOG_LEVELS, type LogLevelName, type WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { Badge, Button, CheckboxField, ErrorState, FormSection, LoadingState, SelectField } from "../components";
import { useLogLevel } from "../log-level";
import { isThemePreference, useTheme } from "../theme";

function isLogLevelName(value: string): value is LogLevelName {
  return VALID_LOG_LEVELS.some((level) => level === value);
}

export interface AccountSectionProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
}

export function AccountSection({ config, refresh, setError }: AccountSectionProps) {
  const { preference, setPreference, loading, error, retry } = useTheme();
  const logLevel = useLogLevel();
  const [logLevelSaving, setLogLevelSaving] = useState(false);
  const [inMemoryLogsSaving, setInMemoryLogsSaving] = useState(false);

  async function updateLogLevel(value: string) {
    if (!isLogLevelName(value)) {
      setError(`Unknown log level: ${value}`);
      return;
    }
    try {
      setError(undefined);
      setLogLevelSaving(true);
      await appJson<unknown>("/api/preferences/log-level", { method: "PUT", body: JSON.stringify({ level: value }) });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLevelSaving(false);
    }
  }

  async function updateInMemoryLogs(enabled: boolean) {
    try {
      setError(undefined);
      setInMemoryLogsSaving(true);
      await appJson<unknown>("/api/server/logs/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInMemoryLogsSaving(false);
    }
  }

  return (
    <>
      {config.currentUser ? (
        <FormSection title="Account">
          <p>Signed in as <strong>{config.currentUser.username}</strong> <Badge variant={config.currentUser.isAdmin ? "success" : "disabled"}>{config.currentUser.role}</Badge></p>
        </FormSection>
      ) : null}
      <FormSection title="Display Settings">
        <SelectField label="Theme" value={preference} onChange={(event) => {
          const next = event.currentTarget.value;
          if (!isThemePreference(next)) {
            setError(`Unknown theme preference: ${next}`);
            return;
          }
          setPreference(next);
          void appJson("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: next }) }).catch((err) => setError(String(err)));
        }}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
        {loading ? <LoadingState title="Loading saved theme" /> : null}
        {error ? (
          <ErrorState
            description={error.message}
            action={<Button type="button" loading={loading} onClick={() => void retry()}>Retry</Button>}
          />
        ) : null}
      </FormSection>

      {config.currentUser?.isAdmin ? (
        <FormSection title="Developer Settings">
          {logLevel.error ? (
            <ErrorState
              description={logLevel.error.message}
              action={<Button type="button" loading={logLevel.loading} onClick={() => void logLevel.retry()}>Retry</Button>}
            />
          ) : null}
          {logLevel.loading && logLevel.level === undefined ? <LoadingState title="Loading log level" /> : null}
          {logLevel.level !== undefined ? (
            <SelectField
              label={logLevel.fromEnv ? `Log level (${logLevel.level}, controlled by env)` : "Log level"}
              value={logLevel.level}
              disabled={logLevel.fromEnv === true || logLevel.loading || logLevelSaving}
              onChange={(event) => void updateLogLevel(event.currentTarget.value)}
            >
              {VALID_LOG_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </SelectField>
          ) : null}
          <CheckboxField
            label="Store server logs in memory"
            hint="Temporary; disabled and cleared when the server process starts or this setting is turned off."
            checked={config.inMemoryLogs.enabled}
            disabled={inMemoryLogsSaving}
            onChange={(event) => void updateInMemoryLogs(event.currentTarget.checked)}
          />
        </FormSection>
      ) : null}
    </>
  );
}
