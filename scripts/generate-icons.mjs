// Generates PWA / Apple touch icons from the Tessera mark. Run: node scripts/generate-icons.mjs
import sharp from 'sharp';

const mark = (scale, offset) => `
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <rect x="3" y="3" width="12" height="12" rx="3.2" fill="#18181b"/>
    <rect x="17" y="3" width="12" height="12" rx="3.2" fill="#18181b" opacity=".35"/>
    <rect x="3" y="17" width="12" height="12" rx="3.2" fill="#18181b" opacity=".35"/>
    <rect x="18.5" y="18.5" width="11" height="11" rx="3" fill="#0f766e"/>
  </g>`;

// size: output px; fill: fraction of canvas the 32-unit mark occupies.
const icon = (size, fill) => {
  const scale = (size * fill) / 32;
  const offset = (size - size * fill) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#ffffff"/>${mark(scale, offset)}</svg>`,
  );
};

const out = [
  ['public/pwa-192.png', 192, 0.7],
  ['public/pwa-512.png', 512, 0.7],
  ['public/pwa-maskable-512.png', 512, 0.5], // stays inside the maskable safe zone
  ['public/apple-touch-icon.png', 180, 0.62],
];
for (const [file, size, fill] of out) {
  await sharp(icon(size, fill)).png().toFile(file);
  console.log('wrote', file);
}
