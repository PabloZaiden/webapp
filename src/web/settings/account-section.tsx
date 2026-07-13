import type { ThemePreference, WebAppConfigResponse } from "../../contracts";
import { appJson } from "../api-client";
import { Badge, Button, ErrorState, FormSection, LoadingState, SelectField } from "../components";

export interface AccountSectionProps {
  config: WebAppConfigResponse;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  themeLoading: boolean;
  themeLoadError?: Error;
  retryThemeLoad: () => Promise<void>;
  refresh: () => Promise<void>;
  setError: (error: string | undefined) => void;
}

export function AccountSection({ config, theme, setTheme, themeLoading, themeLoadError, retryThemeLoad, refresh, setError }: AccountSectionProps) {
  return (
    <>
      {config.currentUser ? (
        <FormSection title="Account">
          <p>Signed in as <strong>{config.currentUser.username}</strong> <Badge variant={config.currentUser.isAdmin ? "success" : "disabled"}>{config.currentUser.role}</Badge></p>
        </FormSection>
      ) : null}
      <FormSection title="Display Settings">
        <SelectField label="Theme" value={theme} onChange={(event) => {
          const next = event.currentTarget.value as ThemePreference;
          setTheme(next);
          void appJson("/api/preferences/theme", { method: "PUT", body: JSON.stringify({ theme: next }) }).catch((err) => setError(String(err)));
        }}>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </SelectField>
        {themeLoading ? <LoadingState title="Loading saved theme" /> : null}
        {themeLoadError ? (
          <ErrorState
            description={themeLoadError.message}
            action={<Button type="button" loading={themeLoading} onClick={() => void retryThemeLoad()}>Retry</Button>}
          />
        ) : null}
      </FormSection>

      {config.currentUser?.isAdmin ? (
        <FormSection title="Developer Settings">
          <SelectField label={config.logLevel.fromEnv ? `Log level (${config.logLevel.level}, controlled by env)` : "Log level"} value={config.logLevel.level} disabled={config.logLevel.fromEnv} onChange={(event) => void appJson("/api/preferences/log-level", { method: "PUT", body: JSON.stringify({ level: event.currentTarget.value }) }).then(refresh)}>
            {["trace", "debug", "info", "warn", "error"].map((level) => <option key={level} value={level}>{level}</option>)}
          </SelectField>
        </FormSection>
      ) : null}
    </>
  );
}
