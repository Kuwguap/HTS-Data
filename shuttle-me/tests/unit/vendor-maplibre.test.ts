import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { maplibreWorkerPath } from "@/lib/map/tiles";

const root = join(__dirname, "..", "..");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("vendored MapLibre worker", () => {
  const version = JSON.parse(readFileSync(join(root, "node_modules/maplibre-gl/package.json"), "utf8")).version as string;
  const vendored = join(root, "public", maplibreWorkerPath(version));

  it("is served from /vendor under the installed version's name", () => {
    expect(maplibreWorkerPath("6.16.0")).toBe("/vendor/maplibre-gl-worker-6.16.0.mjs");
    expect(existsSync(vendored)).toBe(true);
  });

  it("matches the installed package byte for byte (run `pnpm vendor:maplibre` after upgrading)", () => {
    expect(sha(vendored)).toBe(sha(join(root, "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs")));
  });
});
