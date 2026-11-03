import { useEffect, useState } from "react";
import { clientScopedStorageKey } from "../preferences";
import { FormSection, Page } from "../components";
import type { SettingsSection } from "../root-types";
import type { WebAppRoute } from "../sidebar/types";
import { readStorage, writeStorage } from "../storage";
import { SettingsSectionContent } from "./settings-section";
import { SettingsLayout } from "./settings-layout";

export type { SettingsAction, SettingsRow, SettingsSection } from "../root-types";
export interface SettingsViewProps {
  appName?: string;
  version?: string;
  customSections: SettingsSection[];
  route: WebAppRoute;
  navigate(route: WebAppRoute): void;
}

/** Pure visual composition: apps decide which sections and actions are present. */
export function SettingsView({ appName, version, customSections, route, navigate }: SettingsViewProps) {
  const categories = new Map<string, string>([["general", "General"]]);
  for (const section of customSections) if (section.category) categories.set(section.category.id, section.category.title);
  if (version) categories.set("about", "About");
  const key = clientScopedStorageKey(`webapp.${(appName ?? "app").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.settings.category`);
  const [remembered, setRemembered] = useState(() => {
    const result = readStorage(key);
    return result.ok && result.value !== null && categories.has(result.value) ? result.value : "general";
  });
  const requested = route["category"] ?? remembered;
  const selected = categories.has(requested) ? requested : "general";
  useEffect(() => { setRemembered(selected); writeStorage(key, selected); }, [key, selected]);
  return <Page><SettingsLayout categories={Array.from(categories, ([id, title]) => ({ id, title }))} category={selected}
    onCategoryChange={category => navigate({ view: "settings", category })}>
    <div key={selected}>
      {customSections.filter(section => (section.category?.id ?? "general") === selected)
        .map(section => <SettingsSectionContent key={section.id} section={section} />)}
      {selected === "about" ? <FormSection title="Version">{appName} {version}</FormSection> : null}
    </div>
  </SettingsLayout></Page>;
}
