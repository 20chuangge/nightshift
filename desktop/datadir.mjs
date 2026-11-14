/**
 * datadir.mjs - where the desktop app keeps everything writable.
 *
 * Installs from before 1.2.151 live in %APPDATA%\Desk (the app's first name)
 * and stay there: moving a folder full of bots, memory and the vault on an
 * update is a risk with no benefit. A computer that has never had the app
 * gets %APPDATA%\Lamplit. Kept apart from main.mjs so it can be tested
 * without Electron.
 */

import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_DIR_NAME = 'Desk';
export const DIR_NAME = 'Lamplit';

export function pickDataDir(appData, exists = fs.existsSync, platform = process.platform) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const legacy = join(appData, LEGACY_DIR_NAME);
  return exists(legacy) ? legacy : join(appData, DIR_NAME);
}
