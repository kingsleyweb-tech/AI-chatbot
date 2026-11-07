// Generates PWA / Apple touch icons from the Atlas AI mark. Run: node scripts/generate-icons.mjs
import sharp from 'sharp';

const TEAL = '#0f766e';
const glyph = `
  <path d="M9.2 24 16 8.2 22.8 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M6.6 19.4c5.2-3.1 13.6-3.1 18.8 0" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".75"/>`;

// Full-bleed teal icons: the OS applies its own corner mask.
// fill: fraction of the canvas the 32-unit glyph occupies.
const icon = (size, fill) => {
  const scale = (size * fill) / 32;
  const offset = (size - size * fill) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="${TEAL}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${glyph}</g></svg>`,
  );
};

const out = [
  ['public/pwa-192.png', 192, 0.86],
  ['public/pwa-512.png', 512, 0.86],
  ['public/pwa-maskable-512.png', 512, 0.66], // stays inside the maskable safe zone
  ['public/apple-touch-icon.png', 180, 0.82],
];
for (const [file, size, fill] of out) {
  await sharp(icon(size, fill)).png().toFile(file);
  console.log('wrote', file);
}
