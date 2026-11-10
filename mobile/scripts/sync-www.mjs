#!/usr/bin/env node
/**
 * sync-www.mjs — build mobile/www for the Capacitor shell.
 *
 * The phone app is a *shell*: it owns the connect screen (which hub to talk to)
 * and shows the Desk web UI that the hub serves. This script makes the shell
 * self-contained so `npx cap sync` (and therefore the native projects and CI)
 * always has a complete webDir, and so the app always ships a copy of the UI
 * that is current at build time.
 *
 * Layout it produces:
 *
 *   mobile/www/
 *     index.html          <- mobile/shell/index.html  (connect screen + shell)
 *     launcher.js         <- mobile/shell/launcher.js (hub storage, iframe, settings)
 *     shell-info.json     <- build metadata shown on the connect screen
 *     ui/                 <- a verbatim copy of ../public (the real UI)
 *
 * `ui/` is what the desktop server also serves at `/`, so the app can show it
 * locally when the hub is unreachable. It cannot fetch from the hub on its own
 * (that would be a cross-origin call the zero-dependency server does not
 * allow), so it is a read-only preview of the bundled version — see
 * docs/BUILD-MOBILE.md.
 *
 * Usage: node scripts/sync-www.mjs        (npm run sync:www)
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(here, '..');
const publicDir = path.resolve(mobileDir, '..', 'public');
const shellDir = path.join(mobileDir, 'shell');
const wwwDir = path.join(mobileDir, 'www');
const uiDir = path.join(wwwDir, 'ui');

/** Recursive copy that never follows symlinks (keeps the build reproducible). */
async function copyTree(from, to) {
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      await copyTree(src, dst);
    } else if (entry.isFile()) {
      await fsp.copyFile(src, dst);
    }
  }
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(target, fallback) {
  try {
    return JSON.parse(await fsp.readFile(target, 'utf8'));
  } catch {
    return fallback;
  }
}

async function countFiles(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

async function main() {
  if (!(await exists(path.join(publicDir, 'index.html')))) {
    console.error(`[sync-www] FATAL: ${path.join(publicDir, 'index.html')} is missing.`);
    console.error('[sync-www] The shell would ship an empty app; refusing to build.');
    process.exit(1);
  }
  if (!(await exists(path.join(shellDir, 'index.html')))) {
    console.error(`[sync-www] FATAL: ${path.join(shellDir, 'index.html')} is missing.`);
    process.exit(1);
  }

  await fsp.rm(wwwDir, { recursive: true, force: true });
  await fsp.mkdir(wwwDir, { recursive: true });

  // 1. The shell: connect screen + launcher + the native chat screen.
  //    Everything in mobile/shell/ is the app; index.html is the entry point.
  for (const entry of await fsp.readdir(shellDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    await fsp.copyFile(path.join(shellDir, entry.name), path.join(wwwDir, entry.name));
  }

  // 2. The UI, verbatim.
  await copyTree(publicDir, uiDir);

  // 3. Build metadata the connect screen renders (version + what shipped).
  const pkg = await readJsonIfPresent(path.join(mobileDir, 'package.json'), {});
  const cap = await readJsonIfPresent(path.join(mobileDir, 'capacitor.config.json'), {});
  const info = {
    appName: cap.appName || 'Desk',
    appId: cap.appId || 'com.desk.assistant',
    shellVersion: pkg.version || '0.0.0',
    builtAt: new Date().toISOString(),
    bundledUi: 'public/',
    bundledUiFiles: await countFiles(uiDir),
  };
  await fsp.writeFile(path.join(wwwDir, 'shell-info.json'), `${JSON.stringify(info, null, 2)}\n`);

  console.log('[sync-www] www/index.html      <- shell/index.html (connect screen)');
  console.log('[sync-www] www/launcher.js      <- shell/launcher.js');
  console.log(`[sync-www] www/ui/              <- ../public (${info.bundledUiFiles} file(s))`);
  console.log(
    `[sync-www] www/shell-info.json  shell ${info.shellVersion}, appId ${info.appId}, built ${info.builtAt}`,
  );
  console.log(`[sync-www] OK -> ${wwwDir}`);
}

main().catch((err) => {
  console.error('[sync-www] failed:', err);
  process.exit(1);
});
