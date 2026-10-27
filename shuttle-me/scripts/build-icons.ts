/**
 * Build the app's icon set from the Higgsfield-generated PNGs in assets/icon-sources.
 *
 *   pnpm icons:build
 *
 * For every assets/icon-sources/<name>.png (the *.raw.png originals are skipped):
 *   public/icons/<name>.webp       128×128, transparent edges trimmed
 *   public/icons/<name>_192.webp   192×192
 *
 * bus.png additionally becomes the app icon (bus on the blue gradient):
 *   public/icons/app/icon-192.png, icon-512.png   rounded square (radius 22%), bus at 85%
 *   public/icons/app/apple-touch-icon-180.png     full bleed (iOS applies its own mask)
 *   public/icons/app/maskable-512.png             full bleed, bus at 60% (inside the safe zone)
 *   src/app/icon.png (512), src/app/apple-icon.png (180)   Next metadata files
 *   public/icons/app/badge-72.png                 white bus silhouette on transparent
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "assets", "icon-sources");
/** Set ICONS_OUT_ROOT to render somewhere else (previewing without touching public/). */
const OUT_ROOT = process.env.ICONS_OUT_ROOT ? path.resolve(process.env.ICONS_OUT_ROOT) : ROOT;
const OUT_DIR = path.join(OUT_ROOT, "public", "icons");
const APP_DIR = path.join(OUT_DIR, "app");
const NEXT_APP_DIR = path.join(OUT_ROOT, "src", "app");

const GRADIENT_FROM = "#1668DC";
const GRADIENT_TO = "#0B7BC0";
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

async function write(outPath: string, buf: Buffer): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  console.log("wrote", path.relative(OUT_ROOT, outPath).padEnd(40), `${buf.length} bytes`);
}

/** Trim fully transparent edges and return a square RGBA PNG with the subject centred. */
async function trimmedSquare(src: string): Promise<Buffer> {
  const trimmed = await sharp(src).ensureAlpha().trim({ background: TRANSPARENT, threshold: 8 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  const side = Math.max(meta.width ?? 1, meta.height ?? 1);
  return sharp(trimmed)
    .resize(side, side, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
}

async function webpIcon(square: Buffer, size: number, outPath: string): Promise<void> {
  const buf = await sharp(square)
    .resize(size, size, { fit: "contain", background: TRANSPARENT, kernel: "lanczos3" })
    .webp({ quality: 86, alphaQuality: 90, effort: 6 })
    .toBuffer();
  await write(outPath, buf);
}

function gradientSvg(size: number, radiusFraction: number): string {
  const r = Math.round(size * radiusFraction);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${GRADIENT_FROM}"/>
      <stop offset="1" stop-color="${GRADIENT_TO}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#gloss)"/>
</svg>`;
}

/** Soft black shadow made from the subject's alpha, offset a little downwards. */
async function shadowLayer(subject: Buffer, size: number): Promise<Buffer> {
  const alpha = await sharp(subject).extractChannel("alpha").blur(size / 80).linear(0.28, 0).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#000000" } })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

/**
 * The bus composited on the gradient tile.
 * @param radiusFraction  corner radius / size (0 = full bleed)
 * @param busFraction     bus width / size
 */
async function appIcon(busSquare: Buffer, size: number, radiusFraction: number, busFraction: number): Promise<Buffer> {
  const busSize = Math.round(size * busFraction);
  const bus = await sharp(busSquare)
    .resize(busSize, busSize, { fit: "contain", background: TRANSPARENT, kernel: "lanczos3" })
    .png()
    .toBuffer();
  const shadow = await shadowLayer(bus, busSize);
  const offset = Math.round((size - busSize) / 2);
  const shadowShift = Math.round(size * 0.025);
  return sharp(Buffer.from(gradientSvg(size, radiusFraction)))
    .composite([
      { input: shadow, left: offset, top: offset + shadowShift },
      { input: bus, left: offset, top: offset },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** White silhouette: threshold the bus alpha, use it as the alpha of a white image. */
async function badge(busSquare: Buffer, size: number): Promise<Buffer> {
  const inner = Math.round(size * 0.9);
  const offset = Math.round((size - inner) / 2);
  const mask = await sharp(busSquare)
    .resize(inner, inner, { fit: "contain", background: TRANSPARENT })
    .extend({ top: offset, bottom: size - inner - offset, left: offset, right: size - inner - offset, background: TRANSPARENT })
    .extractChannel("alpha")
    .threshold(96)
    .png()
    .toBuffer();
  return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
    .joinChannel(mask)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function buildAppIcons(busSquare: Buffer): Promise<void> {
  // Render once at 1024 and downscale, so every size shares the same look.
  const rounded = await appIcon(busSquare, 1024, 0.22, 0.85);
  const fullBleed = await appIcon(busSquare, 1024, 0, 0.85);
  const maskable = await appIcon(busSquare, 1024, 0, 0.6);

  const down = (buf: Buffer, size: number) =>
    sharp(buf).resize(size, size, { kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer();

  await write(path.join(APP_DIR, "icon-192.png"), await down(rounded, 192));
  await write(path.join(APP_DIR, "icon-512.png"), await down(rounded, 512));
  await write(path.join(APP_DIR, "apple-touch-icon-180.png"), await down(fullBleed, 180));
  await write(path.join(APP_DIR, "maskable-512.png"), await down(maskable, 512));
  await write(path.join(NEXT_APP_DIR, "icon.png"), await down(rounded, 512));
  await write(path.join(NEXT_APP_DIR, "apple-icon.png"), await down(fullBleed, 180));
  await write(path.join(APP_DIR, "badge-72.png"), await badge(busSquare, 72));
}

async function main(): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(SRC_DIR)).filter((f) => f.endsWith(".png") && !f.endsWith(".raw.png")).sort();
  } catch {
    console.error(`No icon sources in ${path.relative(ROOT, SRC_DIR)} — generate them first.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No *.png in ${path.relative(ROOT, SRC_DIR)}`);
    process.exit(1);
  }

  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  for (const file of files) {
    const name = file.replace(/\.png$/, "");
    if (only.length && !only.includes(name)) continue;
    const square = await trimmedSquare(path.join(SRC_DIR, file));
    await webpIcon(square, 128, path.join(OUT_DIR, `${name}.webp`));
    await webpIcon(square, 192, path.join(OUT_DIR, `${name}_192.webp`));
    if (name === "bus") await buildAppIcons(square);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
