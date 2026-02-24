import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

async function copyIntoDist(relativePath) {
  const source = path.join(root, relativePath);
  const destination = path.join(dist, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

await copyIntoDist('apps/demo');
await copyIntoDist('packages/file-browser');
await copyIntoDist('packages/file-sync');
await copyIntoDist('packages/shared');

console.log('Netlify static bundle generated at dist/');
