/**
 * mcpauth.mjs - "连接" with one click for MCP servers that log in with OAuth
 * (MCP authorization spec 2025-06-18), so the human signs in on the app's own
 * page instead of copying a token:
 *
 *   1. ask the MCP URL: 401 + WWW-Authenticate resource_metadata=..., or the
 *      well-known protected-resource document (RFC 9728)
 *   2. its authorization server's metadata (RFC 8414, or OpenID configuration)
 *   3. register this hub as a client (RFC 7591 dynamic registration)
 *   4. authorization code + PKCE (S256), with the resource (RFC 8707)
 *   5. the callback on this hub exchanges the code; refresh tokens renew it
 *
 * Every step is a plain function taking fetchImpl, so the smoke test can run
 * it against a stand-in authorization server.
 */

import crypto from 'node:crypto';

const TIMEOUT = 20000;

export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function authError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

async function getJson(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Steps 1 and 2. -> {resource, scopes, meta:{authorization_endpoint, token_endpoint, registration_endpoint?}} */
export async function discoverOAuth(mcpUrl, { fetchImpl = fetch, clientVersion = '0' } = {}) {
  const u = new URL(mcpUrl);
  let prmUrl = '';
  try {
    const res = await fetchImpl(mcpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nightshift', version: clientVersion } } }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const m = String(res.headers.get('www-authenticate') || '').match(/resource_metadata="([^"]+)"/i);
    if (m) prmUrl = new URL(m[1], mcpUrl).href;
  } catch { /* fall back to the well-known places */ }
  const tail = u.pathname.replace(/\/+$/, '');
  const prmTries = prmUrl ? [prmUrl] : [`${u.origin}/.well-known/oauth-protected-resource${tail}`, `${u.origin}/.well-known/oauth-protected-resource`];
  let prm = null;
  for (const t of prmTries) { prm = await getJson(fetchImpl, t); if (prm) break; }
  const as = new URL(prm?.authorization_servers?.[0] || u.origin);
  const asTail = as.pathname.replace(/\/+$/, '');
  const metaTries = [
    `${as.origin}/.well-known/oauth-authorization-server${asTail}`,
    `${as.origin}/.well-known/oauth-authorization-server`,
    `${as.origin}/.well-known/openid-configuration${asTail}`,
    `${as.origin}/.well-known/openid-configuration`,
  ];
  let meta = null;
  for (const t of metaTries) { meta = await getJson(fetchImpl, t); if (meta?.authorization_endpoint && meta?.token_endpoint) break; meta = null; }
  if (!meta) throw authError('MCP_OAUTH_NO_METADATA', '这个应用没有标准的登录方式（找不到 OAuth 信息），请改用密钥连接');
  return { resource: prm?.resource || mcpUrl, scopes: prm?.scopes_supported || [], meta };
}

/** Step 3. -> {client_id, client_secret?} */
export async function registerClient(meta, redirectUri, { fetchImpl = fetch } = {}) {
  if (!meta.registration_endpoint) throw authError('MCP_OAUTH_NO_REGISTRATION', '这个应用不支持自动登记客户端，请改用密钥连接');
  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Nightshift',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.client_id) throw authError('MCP_OAUTH_REGISTER_FAILED', `登记客户端失败：${body.error_description || body.error || `HTTP ${res.status}`}`);
  return { client_id: body.client_id, client_secret: body.client_secret || '' };
}

/** Step 4: the page the human opens. */
export function authorizeUrl({ meta, clientId, redirectUri, challenge, state, resource, scopes = [] }) {
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (resource) url.searchParams.set('resource', resource);
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  return url.href;
}

async function tokenRequest(tokenEndpoint, params, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString(),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw Object.assign(new Error(`登录没有完成：${body.error_description || body.error || `HTTP ${res.status}`}`), { code: 'MCP_OAUTH_TOKEN_FAILED', status: res.status });
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || '',
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : 0,
  };
}

/** Step 5. */
export function exchangeCode({ tokenEndpoint, code, redirectUri, clientId, clientSecret, verifier, resource }, opts) {
  return tokenRequest(tokenEndpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret, code_verifier: verifier, resource,
  }, opts);
}

export function refreshAccess({ tokenEndpoint, refreshToken, clientId, clientSecret, resource }, opts) {
  return tokenRequest(tokenEndpoint, {
    grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, resource,
  }, opts);
}
