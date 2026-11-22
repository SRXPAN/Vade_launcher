/**
 * Mutual authentication with a shared club key (node only: admin main process and agent).
 * The key itself never travels over the network.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SealedSecret } from './messages';

const DOMAIN = 'vade/1';

function hmac(key: string, data: string): Buffer {
  return createHmac('sha256', Buffer.from(key, 'utf8')).update(data, 'utf8').digest();
}

export function newNonce(): string {
  return randomBytes(18).toString('base64url');
}

/** 256-bit random key, url-safe, ~43 characters */
export function newClubKey(): string {
  return randomBytes(32).toString('base64url');
}

/** Admin proves it knows the key. */
export function authMac(key: string, agentNonce: string, adminNonce: string): string {
  return hmac(key, `${DOMAIN}|auth|${agentNonce}|${adminNonce}`).toString('base64url');
}

/** Agent proves it knows the key (stops a fake agent from collecting the Steam password). */
export function agentProof(key: string, agentNonce: string, adminNonce: string): string {
  return hmac(key, `${DOMAIN}|agent|${adminNonce}|${agentNonce}`).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Per-connection key for sealing secrets such as the Steam password. */
export function sessionKey(key: string, agentNonce: string, adminNonce: string): Buffer {
  return hmac(key, `${DOMAIN}|session|${agentNonce}|${adminNonce}`);
}

export function seal(sessKey: Buffer, plaintext: string): SealedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sessKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

export function unseal(sessKey: Buffer, sealed: SealedSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', sessKey, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Salted SHA-256 hash of an Admin PIN (`<saltHex>:<hashHex>`). */
export function hashPin(pin: string): string {
  const clean = pin.trim();
  if (clean.length < 4 || clean.length > 32) {
    throw new Error('PIN має містити від 4 до 32 символів');
  }
  const salt = randomBytes(16).toString('hex');
  const digest = sha256Hex(`${salt}:${clean}`);
  return `${salt}:${digest}`;
}

/** Verifies an Admin PIN against `<saltHex>:<hashHex>` (or bare `<64-hex>`). Empty/disabled hash returns true. */
export function verifyPin(pin: string, storedHash: string | undefined): boolean {
  const stored = (storedHash ?? '').trim();
  if (!stored) return true;
  const clean = pin.trim();
  if (!clean) return false;
  const colon = stored.indexOf(':');
  if (colon > 0) {
    const salt = stored.slice(0, colon);
    const expected = stored.slice(colon + 1).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) return false;
    return safeEqual(sha256Hex(`${salt}:${clean}`), expected);
  }
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    return safeEqual(sha256Hex(clean), stored.toLowerCase());
  }
  return false;
}
