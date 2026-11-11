/**
 * Tailscale Funnel: a public HTTPS door for the loopback-only public port.
 *
 * The real CLI (verified on 1.104.5) is:
 *   tailscale funnel --bg <port> --yes     expose 127.0.0.1:<port> on :443
 *   tailscale funnel status --json         current config
 *   tailscale funnel reset                 clear funnel config
 * There is no documented targeted "off" in this version, so disabling tries
 * the serve-style `--https=443 off` first and only falls back to reset when the
 * funnel config contains nothing but that one rule.
 *
 * Funnel may refuse until the tailnet has HTTPS certificates and Funnel enabled
 * in the admin console; that refusal carries a login.tailscale.com link which
 * the UI shows as a one-time button instead of retrying.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { P, nowIso, readJsonSync, writeJsonSyncAtomic } from './store.mjs';

const stateFile = () => path.join(P.dataDir, 'funnel.json');
const WINDOWS_BIN = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const LINUX_BINS = ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'];

export function tailscaleBin() {
  if (process.platform === 'win32') return fs.existsSync(WINDOWS_BIN) ? WINDOWS_BIN : null;
  for (const candidate of LINUX_BINS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function run(bin, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') });
    });
  });
}

function parseJson(text) {
  try { return JSON.parse(String(text || '').trim() || '{}'); } catch { return null; }
}

export function readFunnelState() {
  return readJsonSync(stateFile(), null) || { enabled: false, port: null, address: null, hint: null, error: null };
}

function saveState(patch) {
  const next = { ...readFunnelState(), ...patch, updatedAt: nowIso() };
  writeJsonSyncAtomic(stateFile(), next);
  return next;
}

/** The tailnet's HTTPS name, e.g. https://machine.tailnet.ts.net */
async function tailscaleAddress(bin) {
  const status = await run(bin, ['status', '--json']);
  const json = status.ok ? parseJson(status.stdout) : null;
  const dns = String(json?.Self?.DNSName || '').replace(/\.$/, '');
  return dns ? `https://${dns}` : null;
}

function findHint(text) {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"'<>]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

/** Enable the funnel for the public port; returns a view the UI can render. */
export async function enableFunnel(port) {
  const bin = tailscaleBin();
  if (!bin) return saveState({ installed: false, enabled: false, error: null, hint: null });
  if (!port) return saveState({ installed: true, enabled: false, error: '公网端口还没有启动', hint: null });
  const out = await run(bin, ['funnel', '--bg', String(port)], 15000);
  const text = `${out.stdout}\n${out.stderr}`;
  const hint = findHint(text);
  if (!out.ok || hint) {
    return saveState({ installed: true, enabled: false, port, error: hint ? null : text.trim().slice(0, 400), hint });
  }
  const address = await tailscaleAddress(bin);
  return saveState({ installed: true, enabled: true, port, address, hint: null, error: null });
}

/** Try to remove only the funnel we added, never the human's other rules. */
export async function disableFunnel() {
  const bin = tailscaleBin();
  if (!bin) return saveState({ installed: false, enabled: false, hint: null, error: null });
  const off = await run(bin, ['funnel', '--https=443', 'off', '--yes'], 15000);
  if (!off.ok) {
    const status = await run(bin, ['funnel', 'status', '--json']);
    const json = status.ok ? parseJson(status.stdout) : null;
    const text = JSON.stringify(json || {});
    // Reset only when the funnel config holds a single 443 rule and no other
    // ports; anything richer is the human's and we leave it alone.
    const ruleCount = (text.match(/"(443|\d{2,5})"\s*:/g) || []).length;
    if (!json || Object.keys(json).length === 0) {
      return saveState({ enabled: false, hint: null, error: null });
    }
    if (ruleCount <= 1) {
      const reset = await run(bin, ['funnel', 'reset'], 15000);
      if (reset.ok) return saveState({ enabled: false, hint: null, error: null });
    }
    return saveState({ enabled: false, hint: null, error: '无法自动移除（检测到其他 Funnel 规则），请在 Tailscale 里手动关闭' });
  }
  return saveState({ enabled: false, hint: null, error: null });
}

/** What the UI needs. `address` is only meaningful while enabled. */
export function funnelView(publicPort) {
  const bin = tailscaleBin();
  const state = readFunnelState();
  return {
    installed: Boolean(bin),
    enabled: Boolean(state.enabled),
    port: state.port || publicPort || null,
    address: state.enabled ? state.address || null : null,
    hint: state.hint || null,
    error: state.error || null,
    state: !bin ? 'not_installed' : state.enabled ? 'enabled' : state.hint ? 'need_tailscale' : state.error ? 'error' : 'off',
  };
}

/** Called on boot: a funnel the human left on should come back. */
export async function restoreFunnel(port) {
  const state = readFunnelState();
  if (!state.enabled) return funnelView(port);
  return enableFunnel(port);
}

export function funnelPublicUrl() {
  const state = readFunnelState();
  return state.enabled && state.address ? state.address : null;
}
