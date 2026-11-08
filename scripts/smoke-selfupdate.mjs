#!/usr/bin/env node
/**
 * smoke-selfupdate.mjs - a machine replacing its own code (src/selfupdate.mjs).
 *
 * Works on throwaway copies of this repo in the temp dir; the repo itself is
 * never touched. Checks:
 *   - a newer package is test-started, swapped in, and the old code backed up
 *   - bots (config/), data/, workspace/ and the human's own skills survive
 *   - a build that cannot start is refused and nothing changes
 *   - same/older versions and packages that need a new setup are refused
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packApp, cleanupPack } from '../src/bundle.mjs';
import { applyUpdate } from '../src/selfupdate.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['src', 'public', 'hub', 'skills', 'config', 'node_modules', 'package.json'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-selfupdate-'));
const results = [];
const check = (name, ok, detail = '') => { results.push([name, ok]); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` - ${detail}`}`); };

function copyApp(to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of ENTRIES) {
    const from = path.join(REPO, e);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(to, e), { recursive: true });
  }
}
function setVersion(root, version) {
  const file = path.join(root, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
async function packageOf(root) {
  const packed = await packApp({ root, outDir: tmp });
  const bytes = fs.readFileSync(packed.file);
  cleanupPack(packed.file);
  return bytes;
}
const read = (p) => fs.readFileSync(p, 'utf8');

try {
  // The machine: version 1.0.0 with its own bots, data, files and a learned skill.
  const machine = path.join(tmp, 'machine');
  copyApp(machine);
  setVersion(machine, '1.0.0');
  fs.mkdirSync(path.join(machine, 'config', 'bots'), { recursive: true });
  fs.writeFileSync(path.join(machine, 'config', 'bots', 'mine.json'), '{"id":"mine","name":"我的Bot"}\n');
  fs.writeFileSync(path.join(machine, 'skills', 'my-own-skill.md'), '# learned\n');
  fs.mkdirSync(path.join(machine, 'data'), { recursive: true });
  fs.writeFileSync(path.join(machine, 'data', 'secrets.json'), '{"apiKey":"keep-me"}\n');
  fs.mkdirSync(path.join(machine, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(machine, 'workspace', 'notes.txt'), 'user file\n');

  // 1. A newer build installs.
  const good = path.join(tmp, 'good');
  copyApp(good);
  setVersion(good, '9.9.9');
  fs.writeFileSync(path.join(good, 'public', 'new-in-9.txt'), 'new\n');
  fs.rmSync(path.join(good, 'config', 'bots'), { recursive: true, force: true }); // a package never carries your bots
  const res = await applyUpdate({ bytes: await packageOf(good), currentVersion: '1.0.0', root: machine });
  check('newer package: reports 1.0.0 -> 9.9.9', res.from === '1.0.0' && res.to === '9.9.9', JSON.stringify(res));
  check('newer package: code on disk is the new version', JSON.parse(read(path.join(machine, 'package.json'))).version === '9.9.9' && fs.existsSync(path.join(machine, 'public', 'new-in-9.txt')));
  check('old code kept in .update/backup', JSON.parse(read(path.join(machine, '.update', 'backup', 'package.json'))).version === '1.0.0');
  check('bots in config/ untouched', read(path.join(machine, 'config', 'bots', 'mine.json')).includes('我的Bot'));
  check('data/ and workspace/ untouched', read(path.join(machine, 'data', 'secrets.json')).includes('keep-me') && read(path.join(machine, 'workspace', 'notes.txt')) === 'user file\n');
  check('the bot\'s own skill survives; built-in skills refreshed', fs.existsSync(path.join(machine, 'skills', 'my-own-skill.md')) && fs.readdirSync(path.join(machine, 'skills')).length > 1);
  check('scratch folders cleaned up', fs.readdirSync(path.join(machine, '.update')).every((n) => n === 'backup' || n === 'last.json'));

  // 2. A build that cannot start is refused; nothing changes.
  const broken = path.join(tmp, 'broken');
  copyApp(broken);
  setVersion(broken, '10.0.0');
  fs.writeFileSync(path.join(broken, 'src', 'server.mjs'), 'throw new Error("boom: broken build");\n');
  let brokenErr = null;
  try { await applyUpdate({ bytes: await packageOf(broken), currentVersion: '9.9.9', root: machine }); } catch (err) { brokenErr = err; }
  check('broken build: refused after the test start', Boolean(brokenErr) && /启动失败|没有启动/.test(brokenErr.message), brokenErr?.message);
  check('broken build: machine still on 9.9.9 with working code', JSON.parse(read(path.join(machine, 'package.json'))).version === '9.9.9' && !read(path.join(machine, 'src', 'server.mjs')).includes('boom'));

  // 3. Same or older versions are refused.
  let sameErr = null;
  try { await applyUpdate({ bytes: await packageOf(good), currentVersion: '9.9.9', root: machine }); } catch (err) { sameErr = err; }
  check('same version: refused as not newer', sameErr?.code === 'UPDATE_NOT_NEWER', sameErr?.message);

  // 4. A package whose setup scripts changed the system needs a re-add.
  const setup = path.join(tmp, 'setup');
  copyApp(setup);
  setVersion(setup, '11.0.0');
  const sh = path.join(setup, 'hub', 'setup-linux.sh');
  fs.writeFileSync(sh, read(sh).replace(/SETUP_VERSION=\d+/, 'SETUP_VERSION=2'));
  let setupErr = null;
  try { await applyUpdate({ bytes: await packageOf(setup), currentVersion: '9.9.9', root: machine }); } catch (err) { setupErr = err; }
  check('new setup version: asks to add the machine again', setupErr?.code === 'UPDATE_NEEDS_SETUP', setupErr?.message);
} catch (err) {
  check('selfupdate smoke ran', false, err.stack || err.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT  ${results.length - failed}/${results.length} self-update checks passed`);
process.exitCode = failed ? 1 : 0;
