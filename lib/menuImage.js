// Menu header image. Downloaded once and cached as a Buffer (so WhatsApp gets
// real bytes instead of Baileys fetching a URL on every .menu), with a copy
// bundled in the repo (assets/menu.jpg) as a fallback for when the remote
// host is unreachable or blocks the server's IP.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import { logger } from './utils/logger.js';

const LOCAL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'menu.jpg');
const MAX_BYTES = 5 * 1024 * 1024;
let cache = null; // { url, buffer }

async function download(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QueenAkumaV4)', Accept: 'image/*' },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) throw new Error(`not an image (${type || 'no content-type'})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_BYTES) throw new Error(`bad size (${buffer.length} bytes)`);
  return buffer;
}

// Returns a Buffer, or null when neither the URL nor the bundled file work.
export async function getMenuImage() {
  const url = config.menu.imageUrl;
  if (cache && cache.url === url) return cache.buffer;
  try {
    const buffer = await download(url);
    cache = { url, buffer };
    return buffer;
  } catch (err) {
    logger.warn('menu', `menu image download failed (${err.message}) — using bundled copy`);
  }
  try {
    const buffer = fs.readFileSync(LOCAL_FILE);
    cache = { url, buffer }; // don't retry the dead URL on every .menu
    return buffer;
  } catch { return null; }
}
