import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/**
 * Generates all app-icon assets from resources/icon.svg:
 *   - resources/icon.png (1024)  → source for @capacitor/assets (Android/iOS)
 *   - build/icon.ico             → Windows/Electron icon
 *   - public/* favicons          → web
 */
const svg = readFileSync('resources/icon.svg');
for (const dir of ['build', 'resources', 'public']) mkdirSync(dir, { recursive: true });

const png = (size) => sharp(svg, { density: 384 }).resize(size, size).png();

await png(1024).toFile('resources/icon.png');
await png(512).toFile('public/icon-512.png');
await png(192).toFile('public/icon-192.png');
await png(180).toFile('public/apple-touch-icon.png');
await png(32).toFile('public/favicon-32.png');
writeFileSync('public/favicon.svg', svg);

const buffers = await Promise.all([16, 32, 48, 64, 128, 256].map((s) => png(s).toBuffer()));
writeFileSync('build/icon.ico', await pngToIco(buffers));

console.log('✓ icons generated (resources/icon.png, build/icon.ico, public/favicon*)');
