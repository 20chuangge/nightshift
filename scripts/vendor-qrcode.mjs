// Copies the vendored QR library into public/vendor/ with attribution.
// Run: node scripts/vendor-qrcode.mjs <path-to-qrcode.js>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/vendor-qrcode.mjs <path-to-qrcode.js>');
  process.exit(1);
}

const header = [
  '/* qrcode-generator 1.4.4 - Kazuhiko Arase - MIT License',
  ' * https://github.com/kazuhikoarase/qrcode-generator',
  ' * Vendored instead of loaded from a CDN: Settings has to draw a code with',
  ' * no network access at all. See LICENSE-qrcode.txt next to this file. */',
  '',
].join('\n');

const license = `qrcode-generator 1.4.4

Copyright (c) 2009 Kazuhiko Arase

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const outDir = path.join(REPO, 'public', 'vendor');
fs.mkdirSync(outDir, { recursive: true });
const body = fs.readFileSync(source, 'utf8');
fs.writeFileSync(path.join(outDir, 'qrcode.js'), header + body, 'utf8');
fs.writeFileSync(path.join(outDir, 'LICENSE-qrcode.txt'), license, 'utf8');
console.log(`wrote public/vendor/qrcode.js (${(header + body).length} bytes) and LICENSE-qrcode.txt`);
