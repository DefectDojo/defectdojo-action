import { readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "eof",
  define: { __ACTION_VERSION__: JSON.stringify(version) },
  // Some bundled CommonJS code calls require() at runtime.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning",
});
