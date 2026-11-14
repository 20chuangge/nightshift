/**
 * guard.mjs - who may use the desktop app's bridge (SEC-09), and which files
 * "open" must not run (SEC-17). Pure functions, so the smoke test can check them.
 *
 * The window shows this computer's hub or a machine the human added. Any page
 * in it gets `window.desk`; what a call may do depends on whose page it is:
 *   local - this computer's own hub page
 *   known - a machine in the list (by its LAN or Tailscale address)
 *   other - anything else (never expected; refused)
 */

/** 'local' | 'known' | 'other' for the page that sent a bridge call. */
export function senderKind(url, { localOrigin = '', machineOrigins = [] } = {}) {
  let origin = '';
  try {
    origin = new URL(String(url || '')).origin;
  } catch {
    return 'other';
  }
  if (origin === 'null' || !origin) return 'other';
  const same = (o) => {
    try { return Boolean(o) && new URL(o).origin === origin; } catch { return false; }
  };
  if (same(localOrigin)) return 'local';
  if (machineOrigins.some(same)) return 'known';
  return 'other';
}

/**
 * Channels only this computer's page may use: they act on this computer
 * (open its files, open it to the network). Everything else the page uses is
 * fine from any added machine's page too (the clipboard, adding a machine -
 * which always runs from here - switching, notifications, voice).
 */
const LOCAL_ONLY = new Set(['desk:open-file', 'desk:set-remote']);

export function mayUse(channel, kind) {
  if (kind === 'local') return true;
  if (kind === 'known') return !LOCAL_ONLY.has(String(channel));
  return false;
}

/** Files that run something when opened: show them in their folder instead. */
const PROGRAM_EXTENSIONS = new Set(['.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh',
  '.lnk', '.scr', '.hta', '.reg', '.pif', '.cpl', '.msc', '.jar', '.appref-ms', '.url', '.application']);

export function isProgramFile(name) {
  const m = /\.[^./\\]+$/.exec(String(name || '').toLowerCase());
  return Boolean(m) && PROGRAM_EXTENSIONS.has(m[0]);
}
