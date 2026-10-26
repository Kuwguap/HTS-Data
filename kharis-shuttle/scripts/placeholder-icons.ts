/**
 * Placeholder app icons: a blue gradient rounded square with a white bus
 * silhouette, rendered with sharp from an inline SVG. The real icons are built
 * by scripts/build-icons.ts from the Higgsfield bus; this script only exists
 * for previews and fresh checkouts without assets/icon-sources.
 *
 *   pnpm exec tsx scripts/placeholder-icons.ts
 *
 * Output root: $ICONS_OUT_ROOT, defaulting to .ui-shots/placeholder-icons/ so
 * a stray run can never overwrite the real icons under public/ and src/app/.
 * Set ICONS_OUT_ROOT=. explicitly to write into the project (same layout as
 * build-icons.ts):
 *   public/icons/app/icon-192.png           rounded square (any-purpose icon)
 *   public/icons/app/icon-512.png           rounded square
 *   public/icons/app/maskable-512.png       full-bleed, bus inside the 80% safe zone
 *   public/icons/app/apple-touch-icon-180.png  full-bleed square (iOS masks it)
 *   public/icons/app/badge-72.png           white bus on transparent (Android badge)
 *   src/app/icon.png                        favicon (Next metadata file)
 *   src/app/apple-icon.png                  apple-touch-icon (Next metadata file)
 *
 * Every PNG is exactly the declared pixel size (the SVG is rasterised at its
 * own width/height and then resized to be safe; no density upscaling).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT = path.join(ROOT, ".ui-shots", "placeholder-icons");
/** Set ICONS_OUT_ROOT to render somewhere else (ICONS_OUT_ROOT=. targets public/ and src/app/). */
const OUT_ROOT = process.env.ICONS_OUT_ROOT ? path.resolve(process.env.ICONS_OUT_ROOT) : DEFAULT_OUT;

/** Bus silhouette in a 100×100 box. Windows and headlights are even-odd cut-outs. */
const BUS_BODY =
  "M24,20 H76 A12,12 0 0 1 88,32 V58 A12,12 0 0 1 76,70 H24 A12,12 0 0 1 12,58 V32 A12,12 0 0 1 24,20 Z " +
  "M24,30 H42 A4,4 0 0 1 46,34 V44 A4,4 0 0 1 42,48 H24 A4,4 0 0 1 20,44 V34 A4,4 0 0 1 24,30 Z " +
  "M58,30 H76 A4,4 0 0 1 80,34 V44 A4,4 0 0 1 76,48 H58 A4,4 0 0 1 54,44 V34 A4,4 0 0 1 58,30 Z " +
  "M17,60 a3.5,3.5 0 1 0 7,0 a3.5,3.5 0 1 0 -7,0 Z " +
  "M76,60 a3.5,3.5 0 1 0 7,0 a3.5,3.5 0 1 0 -7,0 Z";

function bus(fill: string, opacity = 1): string {
  return (
    `<g fill="${fill}" fill-opacity="${opacity}">` +
    `<path fill-rule="evenodd" d="${BUS_BODY}"/>` +
    `<circle cx="30" cy="73" r="9"/><circle cx="70" cy="73" r="9"/>` +
    `</g>`
  );
}

/**
 * @param size   output pixels
 * @param radius corner radius as a fraction of size (0 = full bleed)
 * @param scale  bus width as a fraction of size (maskable icons use the 80% safe zone)
 */
export function appIconSvg(size: number, radius: number, scale: number): string {
  const r = Math.round(size * radius);
  const busSize = size * scale;
  const offset = (size - busSize) / 2;
  const k = busSize / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1668DC"/>
      <stop offset="1" stop-color="#0B7BC0"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#gloss)"/>
  <g transform="translate(${offset + k * 1.5} ${offset + k * 2.5}) scale(${k})">${bus("#000000", 0.18)}</g>
  <g transform="translate(${offset} ${offset}) scale(${k})">${bus("#ffffff")}</g>
</svg>`;
}

export function badgeSvg(size: number): string {
  const k = size / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="scale(${k})">${bus("#ffffff")}</g>
</svg>`;
}

/** Rasterise an SVG to a PNG of exactly `size`×`size` pixels. */
export async function renderPng(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg))
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function png(svg: string, size: number, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  const buf = await renderPng(svg, size);
  await writeFile(outPath, buf);
  console.log("wrote", path.relative(ROOT, outPath).padEnd(56), `${size}×${size}`, `${buf.length} bytes`);
}

async function main(): Promise<void> {
  const pub = path.join(OUT_ROOT, "public", "icons", "app");
  const app = path.join(OUT_ROOT, "src", "app");
  if (OUT_ROOT === ROOT) console.warn("ICONS_OUT_ROOT=. — overwriting the real icons under public/ and src/app/");
  else console.log("output root:", path.relative(ROOT, OUT_ROOT) || ".");

  await png(appIconSvg(192, 0.22, 0.72), 192, path.join(pub, "icon-192.png"));
  await png(appIconSvg(512, 0.22, 0.72), 512, path.join(pub, "icon-512.png"));
  await png(appIconSvg(512, 0, 0.56), 512, path.join(pub, "maskable-512.png"));
  await png(appIconSvg(180, 0, 0.7), 180, path.join(pub, "apple-touch-icon-180.png"));
  await png(badgeSvg(72), 72, path.join(pub, "badge-72.png"));
  await png(appIconSvg(192, 0.22, 0.72), 192, path.join(app, "icon.png"));
  await png(appIconSvg(180, 0, 0.7), 180, path.join(app, "apple-icon.png"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
