import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadEnvFile } from '../config/index.js';

test('.env reader: BOM, CRLF, quotes, comments, export, and host variables win', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'env-')), '.env');
  fs.writeFileSync(f, '\uFEFFENVT_FIRST=one\r\n# comment\r\nexport ENVT_Q="mongodb+srv://u:p@c/x?a=b"\r\nENVT_C=val # trailing\r\nENVT_HOST=fromfile\r\nENVT_EMPTY=\r\n');
  process.env.ENVT_HOST = 'fromhost';
  const n = loadEnvFile(f);
  assert.equal(process.env.ENVT_FIRST, 'one');
  assert.equal(process.env.ENVT_Q, 'mongodb+srv://u:p@c/x?a=b');
  assert.equal(process.env.ENVT_C, 'val');
  assert.equal(process.env.ENVT_HOST, 'fromhost');
  assert.equal(process.env.ENVT_EMPTY, '');
  assert.equal(n, 4);
});
