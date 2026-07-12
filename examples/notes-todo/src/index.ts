import { createNotesTodoApp } from "./app";

export { createNotesTodoApp } from "./app";

export const app = createNotesTodoApp();

if (import.meta.main) {
  await app.runFromCli();
}
