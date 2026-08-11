import { createNotesTodoCli } from "./index";

process.exitCode = await createNotesTodoCli().run();
