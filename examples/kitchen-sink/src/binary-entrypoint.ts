import { createKitchenSinkCli } from "./index";

process.exitCode = await createKitchenSinkCli().run();
