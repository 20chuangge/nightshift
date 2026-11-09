// What a machine's bots may touch: the workspace, plus folders the human
// opened in Settings → 权限 → 能访问的文件夹. Everything else asks first (or is
// refused), whatever the approval level - "放手" means "don't ask about my
// work", not "read my whole disk". Same for sudo / admin elevation.
//
// File tools are checked exactly (the path they will open). Commands are not a
// sandbox: a command that names a path outside the list asks first, but a
// command can always reach further than what it names. For hard isolation
// turn the bot's 执行命令 ability off; the settings page says so.
//
// policy.folders   [{id, path, write}]       opened folders
// policy.outside   'ask' (default) | 'deny'  what happens outside them
// policy.sudo      'ask' (default) | 'allow'

import os from 'node:os';
import path from 'node:path';

const FILE_TOOLS = { fs_list: ['path', false], fs_read: ['path', false], image_view: ['path', false], fs_write: ['path', true], fs_mkdir: ['path', true], fs_delete: ['path', true], video_generate: ['image', false] };

// System places a normal command names all the time (binaries, temp, /etc/os-release).
const SYSTEM_PREFIXES = process.platform === 'win32'
  ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)']
  : ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/proc', '/sys', '/dev', '/tmp', '/var/tmp', '/etc', '/run', '/var/log', '/snap', '/opt/node'];

const norm = (p) => {
  const n = path.resolve(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const inside = (child, parent) => {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
};

/** Is this absolute path inside the workspace or an opened folder? -> {ok, write} */
function placeOf(abs, { workspaceDir, folders }) {
  if (inside(abs, workspaceDir)) return { ok: true, write: true, where: 'workspace' };
  for (const f of folders || []) {
    if (f?.path && inside(abs, f.path)) return { ok: true, write: Boolean(f.write), where: f.path };
  }
  return { ok: false, write: false };
}

/** Paths a shell command names (absolute, ~, or climbing out with ..). */
export function pathsInCommand(command, workspaceDir) {
  const text = String(command || '');
  const found = new Set();
  const home = os.homedir();
  for (const m of text.matchAll(/(?:^|[\s"'=(,])([A-Za-z]:[\\/][^\s"'|&;<>,)]*)/g)) found.add(m[1]);
  if (process.platform !== 'win32') {
    for (const m of text.matchAll(/(?:^|[\s"'=(,])(\/[^\s"'|&;<>,)]*)/g)) found.add(m[1]);
  }
  for (const m of text.matchAll(/(?:^|[\s"'=(,])(~(?:[\\/][^\s"'|&;<>,)]*)?)/g)) found.add(m[1].replace(/^~/, home));
  for (const m of text.matchAll(/(\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)([\\/][^\s"'|&;<>,)]*)?/gi)) found.add(home + (m[2] || ''));
  for (const m of text.matchAll(/(?:^|[\s"'=(,])((?:\.\.[\\/])+[^\s"'|&;<>,)]*|\.\.)(?=$|[\s"'|&;<>,)])/g)) found.add(path.resolve(workspaceDir, m[1]));
  return [...found].map((p) => path.resolve(p));
}

const SUDO = /(^|[\s;&|(`])(sudo|doas|pkexec|su\s+-c|runas)\b|Start-Process\b[^;|]*-Verb\s+RunAs|\bgsudo\b/i;

// Commands that only look: they list, measure or print, and change nothing.
const LOOKERS = new Set(('ps top htop df du ls ll dir lsblk blkid free uptime uname whoami id hostname hostnamectl lscpu lsusb lspci lsmod '
  + 'ip ss netstat ifconfig stat file find tree wc nproc date env printenv which whereis echo printf sort uniq column nl cut tr '
  + 'journalctl systemctl test true basename dirname realpath readlink md5sum sha256sum '
  + 'get-process get-psdrive get-childitem gci get-item get-itemproperty get-service get-ciminstance get-wmiobject get-computerinfo get-volume get-disk '
  + 'select-object select sort-object where-object where format-table ft format-list fl measure-object out-string tasklist systeminfo ipconfig '
  + 'cat less more head tail grep egrep fgrep rg awk sed get-content gc type select-string sls').split(' '));
// Of those, the ones that read what is inside files (not just names and sizes).
const READERS = new Set('cat less more head tail grep egrep fgrep rg awk sed get-content gc type select-string sls md5sum sha256sum'.split(' '));

/**
 * Does this command only look? -> {look: true, reads: bool} | {look: false}
 * Every part of a pipeline / list must be a looker; any redirection into a
 * file, in-place edit, deletion or command execution makes it not one.
 */
export function lookOnly(command) {
  const raw = String(command || '').trim();
  if (!raw) return { look: false };
  // Quoted text is data ("dnf|packagekit", 'a > b'), not pipes or redirections.
  // A command substitution inside double quotes still runs, so check that first.
  if (/\$\(|`|\bsystem\s*\(|\bexec\s*\(/.test(raw)) return { look: false };
  // (A quoted path is still a path: "C:\docs\a.txt" stays visible as one.)
  const text = raw.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (q) => (/[\\/~]|\.\w{1,5}["']$/.test(q) ? '/quoted-path' : 'Q'));
  // Writes and side doors: > file (but not >/dev/null, 2>&1), tee, in-place
  // edits (sed/perl -i), find -delete/-exec, awk system(), PowerShell verbs that change things.
  const cleaned = text.replace(/\d?>\s*\/dev\/null|2>&1|\d?>\s*\$null|\|\s*Out-Null/gi, '');
  if (/>|\btee\b|\b(sed|perl)\b[^|;&]*\s-i|--in-place|-delete\b|-exec(dir)?\b|-ok\b|\bsystem\s*\(|\b(Set|Remove|New|Stop|Start|Restart|Move|Copy|Rename|Clear|Add|Invoke|Out)-\w+/i.test(cleaned)) return { look: false };
  if (/\bsystemctl\b/i.test(text) && !/\bsystemctl\s+(status|is-active|is-enabled|list-units|list-unit-files|show|cat)\b/i.test(text)) return { look: false };
  let reads = false;
  for (const part of text.split(/\|\||&&|[|;\n]/)) {
    const words = part.trim().replace(/^(sudo|doas)\s+(-\S+\s+)*/i, '').split(/\s+/);
    const cmd = (words[0] || '').replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    if (!cmd) continue;
    if (!LOOKERS.has(cmd)) return { look: false };
    // A reader counts only when it names a file ("grep x" on a pipe reads no file).
    if (READERS.has(cmd) && words.slice(1).some((w) => !w.startsWith('-') && /[\\/~]|^\.\.?$|\.\w{1,5}$/.test(w))) reads = true;
  }
  return { look: true, reads };
}

/**
 * Check one tool call against the machine's boundary.
 * -> null (fine) | {decision:'ask'|'deny', reason, code}
 */
export function checkBoundary(name, args, { workspaceDir, policy = {}, remote = false } = {}) {
  const folders = Array.isArray(policy.folders) ? policy.folders : [];
  const outside = policy.outside === 'deny' ? 'deny' : 'ask';
  const ctx = { workspaceDir, folders };

  const spec = FILE_TOOLS[name];
  if (spec) {
    const raw = args?.[spec[0]];
    if (raw === undefined || raw === null || raw === '') return null;
    const abs = path.resolve(workspaceDir, String(raw));
    const place = placeOf(abs, ctx);
    if (place.ok && (!spec[1] || place.write)) return null;
    // A machine given to the bots: reading anywhere is fine; writing outside still asks.
    if (remote && !spec[1]) return null;
    if (place.ok && spec[1] && !place.write) {
      return { decision: outside, code: 'FOLDER_READ_ONLY', reason: `「${place.where}」只开放了读取，这一步要写入（${abs}）` };
    }
    return { decision: outside, code: 'FOLDER_NOT_OPEN', reason: `这个位置没有开放给机器人（${abs}）；可以在 设置 → 权限 → 能访问的文件夹 里添加` };
  }

  if (name === 'shell') {
    const command = String(args?.command || '');
    if (policy.sudo !== 'allow' && SUDO.test(command)) {
      return { decision: 'ask', code: 'SUDO_ASKS', reason: '要用管理员权限（sudo / 提升权限）运行；这台机器设成了「sudo 先问我」' };
    }
    // Looking around asks nothing: on a machine given to the bots, any command
    // that only looks; on the human's own computer, ones that only list and
    // measure (ps, df, du, ls). Reading a file's contents outside the opened
    // folders still asks there, and anything that writes goes by the rules below.
    const look = lookOnly(command);
    if (look.look && (remote || !look.reads)) return null;
    const cwd = args?.cwd ? path.resolve(workspaceDir, String(args.cwd)) : null;
    const named = pathsInCommand(command, workspaceDir).concat(cwd ? [cwd] : []);
    const away = named.filter((p) => !placeOf(p, ctx).ok && !SYSTEM_PREFIXES.some((s) => inside(p, s)));
    if (away.length) {
      return { decision: outside, code: 'FOLDER_NOT_OPEN', reason: `命令用到了没开放给机器人的位置：${away.slice(0, 3).join('、')}` };
    }
  }
  return null;
}
