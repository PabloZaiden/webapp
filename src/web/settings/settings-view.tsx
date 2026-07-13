import { useState, type ReactNode } from "react";
import type { WebAppConfigResponse } from "../../contracts";
import { Button, DangerZone, FormSection } from "../components";
import type { SettingsRow, SettingsScope, SettingsSection } from "../root-types";
import { AccountSection } from "./account-section";
import { SecuritySection } from "./security-section";
import { SessionsSection } from "./sessions-section";
import { ShutdownSection } from "./shutdown-section";
import { UserManagement } from "./user-management";

export type { SettingsAction, SettingsRow, SettingsSection } from "../root-types";

function renderSettingsActions(actions: SettingsRow["actions"]): ReactNode {
  if (!actions) {
    return null;
  }
  if (!Array.isArray(actions)) {
    return actions;
  }
  return actions.map((action) => (
    <Button key={action.id} type="button" variant={action.variant} disabled={action.disabled} onClick={action.onAction}>{action.label}</Button>
  ));
}

function StructuredSettingsSection({ section }: { section: SettingsSection }) {
  if (!section.rows?.length && section.render) {
    return <section className="wapp-custom-settings-section">{section.render()}</section>;
  }

  return (
    <FormSection title={section.title} description={section.description}>
      {section.rows?.map((row) => {
        const actions = renderSettingsActions(row.actions);
        if (row.danger) {
          return <DangerZone key={row.id} title={row.title} description={row.description} actions={actions} />;
        }
        return (
          <div className="wapp-settings-row" key={row.id}>
            <div>
              <strong>{row.title}</strong>
              {row.description ? <p>{row.description}</p> : null}
              {row.content ? <div className="wapp-settings-row-content">{row.content}</div> : null}
            </div>
            {actions ? <div className="wapp-row-actions">{actions}</div> : null}
          </div>
        );
      })}
      {section.render?.()}
    </FormSection>
  );
}

function isScopeVisible(scope: SettingsScope | undefined, config: WebAppConfigResponse): boolean {
  if (!scope || scope === "user") {
    return Boolean(config.currentUser);
  }
  if (scope === "admin") {
    return Boolean(config.currentUser?.isAdmin);
  }
  return Boolean(config.currentUser?.isOwner);
}

export interface SettingsViewProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  customSections: SettingsSection[];
}

export function SettingsView({ config, refresh, customSections }: SettingsViewProps) {
  const [error, setError] = useState<string>();

  return (
    <div className="wapp-settings">
      {error ? <p className="wapp-error">{error}</p> : null}
      <AccountSection config={config} refresh={refresh} setError={setError} />
      <FormSection title="Security">
        <SecuritySection config={config} refresh={refresh} setError={setError} />
        <SessionsSection config={config} setError={setError} />
      </FormSection>
      <UserManagement config={config} />
      <ShutdownSection config={config} setError={setError} />
      {customSections.filter((section) => isScopeVisible(section.scope, config)).map((section) => ({
        ...section,
        rows: section.rows?.filter((row) => isScopeVisible(row.scope, config)),
      })).map((section) => <StructuredSettingsSection key={section.id} section={section} />)}
      <FormSection title="About">
        <p>{config.appName} {config.version}</p>
      </FormSection>
    </div>
  );
}
