import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  legalComments: "eof",
  metafile: true,
  define: { __ACTION_VERSION__: JSON.stringify(version) },
  // Some bundled CommonJS code calls require() at runtime.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning",
});

// Every bundled package's license text ships beside the bundle, as MIT and similar licenses require.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
  if (match) packages.set(match[1], match[2]);
}
const sections = [...packages]
  .map(([dir, name]) => ({ dir, name, pkg: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
  .sort((a, b) => a.name.localeCompare(b.name) || a.pkg.version.localeCompare(b.pkg.version))
  .map(({ dir, name, pkg }) => {
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    if (!file) throw new Error(`${name} has no license file to ship.`);
    return `${name}@${pkg.version} (${pkg.license})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
  });
const header = "Third-party software bundled in dist/index.mjs, with the license each is used under.\n";
writeFileSync("dist/licenses.txt", [header, ...sections].join(`\n${"-".repeat(72)}\n\n`));
if (!existsSync("dist/licenses.txt")) throw new Error("dist/licenses.txt was not written.");
