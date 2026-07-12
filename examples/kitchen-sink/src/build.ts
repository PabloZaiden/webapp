import { buildWebAppBinary, getBunCompileTargetFromArgs } from "@pablozaiden/webapp/build";

const target = getBunCompileTargetFromArgs();
const suffix = target ? `-${target.replace("bun-", "")}` : "";

await buildWebAppBinary({
  entrypoint: "src/binary-entrypoint.ts",
  outfile: `dist/kitchen-sink${suffix}`,
  target,
  define: {
    WEBAPP_VERSION: JSON.stringify("0.0.0-development"),
  },
});
