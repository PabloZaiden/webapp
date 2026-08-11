import { createRouteCatalog } from "@pablozaiden/webapp/server";
import { createWebAppCli } from "@pablozaiden/webapp/cli";
import {
  createNotesTodoRuntime,
  notesTodoVersion,
} from "./app";

export { createNotesTodoApp } from "./app";

export function createNotesTodoCli() {
  let runtime: ReturnType<typeof createNotesTodoRuntime> | undefined;
  const getRuntime = () => runtime ??= createNotesTodoRuntime();
  return createWebAppCli({
    appName: "Notes TODO",
    commandName: "notes-todo",
    envPrefix: "NOTES_TODO",
    version: notesTodoVersion,
    realtimePath: "/api/ws",
    start: async () => {
      await getRuntime().app.start();
    },
    routeCatalog: () => createRouteCatalog(getRuntime().routes),
  });
}

if (import.meta.main) {
  process.exitCode = await createNotesTodoCli().run();
}
