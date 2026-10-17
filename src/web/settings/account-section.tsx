import { useState } from "react";
import { VALID_LOG_LEVELS, type LogLevelName, type WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { Badge, Button, CheckboxField, ErrorState, FormSection, LoadingState, SelectField } from "../components";
import { useLogLevel } from "../log-level";
import { isThemePreference, useTheme } from "../theme";
import { SettingsFieldRow } from "./settings-section";

function isLogLevelName(value: string): value is LogLevelName {
  return VALID_LOG_LEVELS.some((level) => level === value);
}

export interface AccountSectionProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
  category: string;
}

export function AccountSection({ config, refresh, setError, category }: AccountSectionProps) {
  const { preference, setPreference, loading, error, retry } = useTheme();
  const logLevel = useLogLevel();
  const [logLevelSaving, setLogLevelSaving] = useState(false);
  const [serverLogsSaving, setServerLogsSaving] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeSaved, setThemeSaved] = useState(false);

  async function updateTheme(value: string) {
    if (!isThemePreference(value)) {
      setError("Invalid theme");
      return;
    }
    const previous = preference;
    setPreference(value);
    setThemeSaving(true);
    setThemeSaved(false);
    setError(undefined);
    try {
      await appJson("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: value }) });
      setThemeSaved(true);
    } catch (error) {
      setPreference(previous);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setThemeSaving(false);
    }
  }

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

  async function updateServerLogs(enabled: boolean) {
    try {
      setError(undefined);
      setServerLogsSaving(true);
      await appJson<unknown>("/api/server/logs/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerLogsSaving(false);
    }
  }

  return (
    <>
      {category === "account" && config.currentUser ? (
        <FormSection title="Account">
          <p>Signed in as <strong>{config.currentUser.username}</strong> <Badge variant={config.currentUser.isAdmin ? "success" : "disabled"}>{config.currentUser.role}</Badge></p>
        </FormSection>
      ) : null}
      {category === "general" ? <FormSection title="Appearance">
        <SelectField label="Theme" value={preference} disabled={themeSaving} onChange={(event) => void updateTheme(event.currentTarget.value)}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
        {themeSaving || themeSaved ? <small role="status">{themeSaving ? "Saving…" : "Saved"}</small> : null}
        {loading ? <LoadingState title="Loading saved theme" /> : null}
        {error ? (
          <ErrorState
            description={error.message}
            action={<Button type="button" loading={loading} onClick={() => void retry()}>Retry</Button>}
          />
        ) : null}
      </FormSection> : null}

      {category === "administration" && config.currentUser?.isAdmin ? (
        <FormSection title="Logging">
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
          <SettingsFieldRow title="Server logs" content={<CheckboxField
            label="Capture logs"
            hint="Unbounded temporary file; may fill disk. Avoid secrets."
            checked={config.inMemoryLogs.enabled}
            disabled={serverLogsSaving}
            onChange={(event) => void updateServerLogs(event.currentTarget.checked)}
          />} />
        </FormSection>
      ) : null}
    </>
  );
}
