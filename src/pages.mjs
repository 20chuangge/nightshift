// Pages: reports, dashboards and trackers a bot makes as a web page, kept in
// the workspace's pages/ folder so they can be opened again later (the "page
// library"), downloaded, or updated by the bot under the same name.
//
//   pages/<name>.html     the page itself (one file: images are inlined)
//   pages/.meta.json      {<name>: {title, botId, botName, createdAt, updatedAt}}
//
// A page is bot-written HTML, so the hub only ever serves it sandboxed (an
// opaque origin): its scripts run, but cannot reach the hub with the human's
// pairing cookie.

import fsp from 'node:fs/promises';
import path from 'node:path';

export const PAGES_DIR = 'pages';
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

/** The file name a page is kept under: letters, digits and dashes. */
export function pageName(raw) {
  return String(raw || '').toLowerCase().replace(/\.html?$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** A bare fragment becomes a whole page with readable defaults (light and dark). */
function wrapPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d1d22; --bg: #fff; --dim: #6b6b76; --line: #e4e4ea; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --bg: #17171c; --dim: #9a9aa6; --line: #2e2e36; } }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 920px; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { border-bottom: 1px solid var(--line); padding: 6px 8px; text-align: left; }
  img { max-width: 100%; }
  small, .dim { color: var(--dim); }
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

export function createPages({ workspaceDir }) {
  const dir = path.join(workspaceDir, PAGES_DIR);
  const metaFile = path.join(dir, '.meta.json');

  async function readMeta() {
    try { return JSON.parse(await fsp.readFile(metaFile, 'utf8')) || {}; } catch { return {}; }
  }
  async function writeMeta(meta) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
  }

  /** Workspace images the page points at go inside it, so one file is the whole page. */
  async function inlineImages(html) {
    const root = path.resolve(workspaceDir);
    const out = [];
    let last = 0;
    for (const m of html.matchAll(/(\ssrc\s*=\s*)(["'])([^"']+)\2/gi)) {
      const ref = m[3];
      if (/^(data:|https?:|blob:|\/\/)/i.test(ref)) continue;
      const mime = IMG_MIME[path.extname(ref.split(/[?#]/)[0]).toLowerCase()];
      if (!mime) continue;
      const rel = ref.replace(/^\.\.\//, '').replace(/^\.\//, '').replace(/^workspace\//, '');
      // A path relative to pages/ or to the workspace root; never outside it.
      const candidates = [path.resolve(dir, ref), path.resolve(root, rel)];
      let bytes = null;
      for (const abs of candidates) {
        if (abs !== root && !abs.startsWith(root + path.sep)) continue;
        try {
          const st = await fsp.stat(abs);
          if (st.isFile() && st.size <= MAX_INLINE_BYTES) { bytes = await fsp.readFile(abs); break; }
        } catch { /* try the next */ }
      }
      if (!bytes) continue;
      out.push(html.slice(last, m.index), `${m[1]}${m[2]}data:${mime};base64,${bytes.toString('base64')}${m[2]}`);
      last = m.index + m[0].length;
    }
    out.push(html.slice(last));
    return out.join('');
  }

  return {
    dir,

    /** -> [{name, title, path, size, createdAt, updatedAt, botId, botName}] newest first */
    async list() {
      let names = [];
      try { names = (await fsp.readdir(dir)).filter((n) => /^[a-z0-9-]+\.html$/.test(n)); } catch { return []; }
      const meta = await readMeta();
      const rows = await Promise.all(names.map(async (file) => {
        const name = file.replace(/\.html$/, '');
        const st = await fsp.stat(path.join(dir, file)).catch(() => null);
        if (!st) return null;
        let title = meta[name]?.title;
        if (!title) {
          const head = (await fsp.readFile(path.join(dir, file), 'utf8').catch(() => '')).slice(0, 4000);
          title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(head)?.[1]?.trim() || name;
        }
        return {
          name,
          title,
          path: `${PAGES_DIR}/${file}`,
          size: st.size,
          createdAt: meta[name]?.createdAt || st.birthtime?.toISOString?.() || st.mtime.toISOString(),
          updatedAt: st.mtime.toISOString(),
          botId: meta[name]?.botId || null,
          botName: meta[name]?.botName || null,
        };
      }));
      return rows.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    /** Save (or replace, same name) a page. -> {name, title, path, bytes, updated} */
    async save({ title, html, name, bot }) {
      const cleanTitle = String(title || '').trim().slice(0, 120) || '未命名页面';
      let body = String(html || '');
      if (!body.trim()) throw Object.assign(new Error('the page is empty'), { code: 'PAGE_EMPTY' });
      const meta = await readMeta();
      let slug = pageName(name);
      if (!slug) {
        // From the title: the same title updates its page; a different title never overwrites another one.
        slug = pageName(cleanTitle);
        if (slug && meta[slug] && meta[slug].title !== cleanTitle) {
          slug = Object.entries(meta).find(([, m]) => m.title === cleanTitle)?.[0] || `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        }
      }
      if (!slug) {
        // A title with no Latin letters: a dated name, kept when the same title is saved again.
        const known = Object.entries(meta).find(([, m]) => m.title === cleanTitle)?.[0];
        slug = known || `page-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
      }
      if (!/<html[\s>]/i.test(body)) body = wrapPage(cleanTitle, body);
      else if (!/<title[\s>]/i.test(body)) body = body.replace(/<head([^>]*)>/i, `<head$1><title>${escapeHtml(cleanTitle)}</title>`);
      body = await inlineImages(body);
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > MAX_PAGE_BYTES) throw Object.assign(new Error('a page must be 8 MB or smaller (use fewer or smaller images)'), { code: 'PAGE_TOO_LARGE' });
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${slug}.html`);
      const updated = await fsp.stat(file).then(() => true, () => false);
      await fsp.writeFile(file, body, 'utf8');
      const now = new Date().toISOString();
      meta[slug] = { title: cleanTitle, botId: bot?.id || meta[slug]?.botId || null, botName: bot?.name || meta[slug]?.botName || null, createdAt: meta[slug]?.createdAt || now, updatedAt: now };
      await writeMeta(meta);
      return { name: slug, title: cleanTitle, path: `${PAGES_DIR}/${slug}.html`, bytes, updated };
    },

    /** -> the page's HTML, or null */
    async read(name) {
      const slug = pageName(name);
      if (!slug) return null;
      try { return await fsp.readFile(path.join(dir, `${slug}.html`), 'utf8'); } catch { return null; }
    },

    async remove(name) {
      const slug = pageName(name);
      if (!slug) return false;
      try { await fsp.unlink(path.join(dir, `${slug}.html`)); } catch { return false; }
      const meta = await readMeta();
      delete meta[slug];
      await writeMeta(meta);
      return true;
    },
  };
}

/** Response headers for serving a page: sandboxed, never same-origin with the hub. */
export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};
