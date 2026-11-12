// A stand-in clipboard tool for the smoke test (never the real clipboard).
// "set" stores stdin in $DESK_CLIP_FILE; "get" prints it.
import fs from 'node:fs';

const file = process.env.DESK_CLIP_FILE;
if (process.argv[2] === 'get') {
  try { process.stdout.write(fs.readFileSync(file)); } catch { process.exit(1); }
} else {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => fs.writeFileSync(file, Buffer.concat(chunks)));
}
