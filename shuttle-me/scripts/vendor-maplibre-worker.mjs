#!/usr/bin/env node
/**
 * Copies MapLibre GL's web worker into public/vendor/ under a versioned name.
 *
 * maplibre-gl resolves its worker as "./maplibre-gl-worker.mjs" next to its own
 * module URL, which inside a Next.js chunk points nowhere. The app serves the file
 * itself and tells MapLibre where (src/lib/map/basemap.ts → setWorkerUrl). The copy is
 * committed; tests/unit/vendor-maplibre.test.ts fails when it drifts from the
 * installed package, so run `pnpm vendor:maplibre` after upgrading maplibre-gl.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "node_modules/maplibre-gl/package.json"), "utf8"));
const src = join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
const outDir = join(root, "public/vendor");
const outName = `maplibre-gl-worker-${pkg.version}.mjs`;

mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (/^maplibre-gl-worker-.*\.mjs$/.test(f) && f !== outName) unlinkSync(join(outDir, f));
}
copyFileSync(src, join(outDir, outName));
console.log(`vendored maplibre-gl ${pkg.version} worker → public/vendor/${outName}`);
