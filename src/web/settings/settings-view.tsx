import { useState } from "react";
import type { WebAppConfigResponse } from "../../contracts";
import { FormSection } from "../components";
import type { SettingsScope, SettingsSection } from "../root-types";
import type { WebAppRoute } from "../sidebar/types";
import { AccountSection } from "./account-section";
import { SecuritySection } from "./security-section";
import { SessionsSection } from "./sessions-section";
import { ShutdownSection } from "./shutdown-section";
import { UserManagement } from "./user-management";
import { SettingsSectionContent } from "./settings-section";
import { SettingsLayout } from "./settings-layout";
import { RemoteClientSettings } from "../remote-client";

export type { SettingsAction, SettingsRow, SettingsSection } from "../root-types";

function isScopeVisible(scope: SettingsScope | undefined, config: WebAppConfigResponse): boolean {
  if (!scope || scope === "user") return Boolean(config.currentUser);
  return scope === "admin" ? Boolean(config.currentUser?.isAdmin) : Boolean(config.currentUser?.isOwner);
}

export interface SettingsViewProps {
  config: WebAppConfigResponse;
  refresh: () => Promise<void>;
  customSections: SettingsSection[];
  route: WebAppRoute;
  navigate: (route: WebAppRoute) => void;
}

export function SettingsView({ config, refresh, customSections, route, navigate }: SettingsViewProps) {
  const [error, setError] = useState<string>();
  const visibleSections = customSections.filter((section) => isScopeVisible(section.scope, config)).map((section) => ({
    ...section,
    rows: section.rows?.filter((row) => isScopeVisible(row.scope, config)),
  }));
  const categories = new Map<string, string>([["general", "General"], ["account", "Account & access"]]);
  for (const section of visibleSections) {
    if (section.category) categories.set(section.category.id, section.category.title);
  }
  if (config.currentUser?.isAdmin) {
    categories.set("administration", "Administration");
    categories.set("maintenance", "Maintenance");
  }
  categories.set("about", "About");
  const requested = route["category"] ?? "general";
  const selected = categories.has(requested) ? requested : "general";
  function select(category: string) {
    setError(undefined);
    navigate({ view: "settings", category });
  }
  return (
    <SettingsLayout categories={Array.from(categories, ([id, title]) => ({ id, title }))} category={selected} onCategoryChange={select}>
      <div key={selected}>
        {error ? <p className="wapp-error" role="alert">{error}</p> : null}
        {selected === "general" ? <RemoteClientSettings /> : null}
        {["general", "account", "administration"].includes(selected) ? <AccountSection config={config} refresh={refresh} setError={setError} category={selected} /> : null}
        {selected === "account" ? <FormSection title="Security">
          <SecuritySection config={config} refresh={refresh} setError={setError} />
          <SessionsSection config={config} setError={setError} />
        </FormSection> : null}
        {selected === "administration" ? <UserManagement config={config} /> : null}
        {visibleSections.filter((section) => (section.category?.id ?? "general") === selected).map((section) => <SettingsSectionContent key={section.id} section={section} />)}
        {selected === "maintenance" ? <ShutdownSection config={config} setError={setError} /> : null}
        {selected === "about" ? <FormSection title="Version"><span>{config.appName} {config.version}</span></FormSection> : null}
      </div>
    </SettingsLayout>
  );
}
