/**
 * sealed.mjs - read the hub's key files from the desktop app (SEC-14).
 *
 * The hub writes data/secrets.json, voice.json, vision.json ... encrypted with
 * the master key this app gives it (see masterKey() in main.mjs). The format
 * is the hub's (src/store.mjs sealText): {lamplitSealed:1, iv, tag, data},
 * AES-256-GCM. A plain file (older hub, no master key) reads as it is.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/** The parsed JSON of a key file, opening it when sealed; null when missing or unreadable. */
export function readSecretJson(file, keyHex) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !value.lamplitSealed) return value;
    if (!/^[0-9a-f]{64}$/i.test(String(keyHex || ''))) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}
