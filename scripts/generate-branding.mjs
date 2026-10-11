import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "services", "api", "package.json"));
const sharp = require("sharp");
const source = path.join(root, ".src", "The_Garden_of_Earthly_Delights.png");
const output = path.join(root, "services", "web", "static");

function roundedMask(size) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${size * 0.08}" fill="white"/></svg>`);
}

async function icon(size, rounded = false) {
  const image = sharp(source).resize(size, size, { fit: "contain" }).ensureAlpha();
  if (rounded) image.composite([{ input: roundedMask(size), blend: "dest-in" }]);
  return image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
}

// ICO stores one PNG frame per size. A zero dimension encodes the 256 px frame.
async function faviconIco() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const frames = await Promise.all(sizes.map(size => icon(size, true)));
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    directory.writeUInt8(sizes[index] % 256, entry);
    directory.writeUInt8(sizes[index] % 256, entry + 1);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  return Buffer.concat([directory, ...frames]);
}

await fs.writeFile(path.join(output, "logo.png"), await icon(1024));
await fs.writeFile(path.join(output, "favicon.png"), await icon(512, true));
// Apple applies its own corner mask to home-screen icons.
await fs.writeFile(path.join(output, "apple-touch-icon.png"), await icon(180));
await fs.writeFile(path.join(output, "favicon.ico"), await faviconIco());
// Keep the complete artwork square; the right panel follows the existing card's
// editorial typography. Preserve dimensions declared in SEO metadata.
const painting = await icon(909);
const socialTypography = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1731" height="909">
  <g fill="#eee9df" font-family="Arial, Helvetica, sans-serif">
    <text x="977" y="106" font-size="36" font-weight="600">laboratory</text>
    <path d="M977 168V378" stroke="#eee9df" stroke-width="2"/>
    <text x="977" y="526" font-size="64" letter-spacing="-1.5">
      <tspan x="977" y="526">independent</tspan>
      <tspan x="977" y="604">studies, notes</tspan>
      <tspan x="977" y="682">and published</tspan>
      <tspan x="977" y="760">work</tspan>
    </text>
  </g>
</svg>`);
await sharp({ create: { width: 1731, height: 909, channels: 3, background: "#171b15" } })
  .composite([{ input: painting, left: 0, top: 0 }, { input: socialTypography, left: 0, top: 0 }])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(path.join(output, "og.png"));

console.log("Generated Laboratory logo, web and Apple icons, ICO frames and social preview.");
