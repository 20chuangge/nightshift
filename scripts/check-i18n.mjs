#!/usr/bin/env node
/**
 * check-i18n.mjs - every Chinese string the UI can show must have an English
 * entry in public/i18n-en.js. Uses the TypeScript parser (from desktop/'s dev
 * dependencies) to find string and template literals exactly.
 *
 *   npm run check:i18n
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The desktop app's tools bring typescript along; CI installs it at the root instead.
const ts = (() => {
  for (const from of [path.join(root, 'desktop', 'package.json'), path.join(root, 'package.json')]) {
    try { return createRequire(from)('typescript'); } catch { /* try the next place */ }
  }
  throw new Error('typescript not found: npm install --no-save typescript (or npm install in desktop/)');
})();

// Not UI text: regex replacement sources (their {0} forms are in the
// dictionary) and an instruction sent to the model.
const IGNORE = new Set([
  '这个助手没有「$1」的执行权限',
  '命令命中危险黑名单（$1）',
  '要动的文件不在共享工作区里（$1）',
  '始终使用简体中文回答。技术名词、命令、路径、代码和报错原文保持原样。',
]);

const cjk = /[一-鿿]/;
const keys = new Map();
const add = (raw, where) => {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (v && cjk.test(v) && !keys.has(v)) keys.set(v, where);
};

function scanSource(text, where) {
  const sf = ts.createSourceFile('x.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const v = node.text;
      if (v.includes('<')) {
        for (const part of v.replace(/<[^>]*>/g, '\u0000').split('\u0000')) add(part, `${where}:html`);
      } else add(v, where);
    } else if (ts.isTemplateExpression(node)) {
      let v = node.head.text;
      node.templateSpans.forEach((span, i) => { v += `{${i}}` + span.literal.text; });
      if (v.includes('<')) {
        for (const part of v.replace(/<[^>]*>/g, '\u0000').split('\u0000')) add(part, `${where}:tpl-html`);
      } else add(v, `${where}:tpl`);
    } else if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      return; // regex sources are not UI text
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const html = fs.readFileSync(`${root}/public/index.html`, 'utf8');
const noStyle = html.replace(/<style>[\s\S]*?<\/style>/g, '');
const scripts = [...noStyle.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const markup = noStyle.replace(/<script(?![^>]*src)[^>]*>[\s\S]*?<\/script>/g, '');
for (const m of markup.matchAll(/>([^<>]+)</g)) add(m[1], 'html');
for (const m of markup.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)) add(m[1], 'attr');
scripts.forEach((src) => scanSource(src, 'js'));
for (const file of ['remote.mjs', 'providers.mjs']) scanSource(fs.readFileSync(`${root}/src/${file}`, 'utf8'), `src/${file}`);


globalThis.window = {};
await import(new URL('../public/i18n-en.js', import.meta.url));
const dict = globalThis.window.DESK_I18N_EN;
const missing = [...keys.keys()].filter((k) => !(k in dict) && !IGNORE.has(k));
// A repeated key silently wins over the earlier one: "机器" once became "Machine" in the nav.
const source = fs.readFileSync(path.join(root, 'public', 'i18n-en.js'), 'utf8');
const seen = new Set();
const duplicates = [];
for (const m of source.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)) { if (seen.has(m[1])) duplicates.push(m[1]); seen.add(m[1]); }
if (duplicates.length) { console.log('FAIL  duplicate keys in public/i18n-en.js: ' + duplicates.join(', ')); process.exitCode = 1; }
if (missing.length) {
  console.log(`FAIL  ${missing.length} UI string(s) have no English in public/i18n-en.js:`);
  for (const k of missing) console.log(`  ${k}`);
  process.exitCode = 1;
} else {
  console.log(`PASS  all ${keys.size} UI strings have English`);
}
