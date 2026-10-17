import { useEffect, useRef, type ReactNode } from "react";
import { SelectField } from "../components";
import type { SettingsCategory } from "../root-types";

export interface SettingsLayoutProps {
  categories: readonly SettingsCategory[];
  category: string;
  onCategoryChange: (category: string) => void;
  children: ReactNode;
}

export function SettingsLayout({ categories, category, onCategoryChange, children }: SettingsLayoutProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    container.current?.scrollTo({ top: 0 });
  }, [category]);
  return (
    <div ref={container} className="wapp-settings">
      <nav className="wapp-settings-nav" aria-label="Settings categories">
        {categories.map(({ id, title }) => (
          <button key={id} type="button" aria-current={category === id ? "page" : undefined} onClick={() => onCategoryChange(id)}>
            {title}
          </button>
        ))}
      </nav>
      <div className="wapp-settings-category-select">
        <SelectField label="Category" value={category} onChange={(event) => onCategoryChange(event.currentTarget.value)}>
          {categories.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
        </SelectField>
      </div>
      <div className="wapp-settings-content">{children}</div>
    </div>
  );
}
