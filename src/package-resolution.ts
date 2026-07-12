import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const REACT_DOM_CLIENT_SPECIFIER = "react-dom/client";

export function findPackageRoot(startDirectory: string): string {
  const start = resolve(startDirectory);
  let current = start;

  while (true) {
    if (existsSync(resolve(current, "package.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Unable to find an application package root from "${start}". Add a package.json to the application package.`);
    }
    current = parent;
  }
}

export function resolveReactDomClient(applicationRoot: string, resolutionContext: string): string {
  const root = resolve(applicationRoot);
  const context = resolve(resolutionContext);

  try {
    return Bun.resolveSync(REACT_DOM_CLIENT_SPECIFIER, context);
  } catch (error) {
    throw new Error(
      `Unable to resolve "${REACT_DOM_CLIENT_SPECIFIER}" from application package "${root}" using "${context}". Install "react-dom" in the application package and ensure its React peer dependencies are declared.`,
      { cause: error },
    );
  }
}
