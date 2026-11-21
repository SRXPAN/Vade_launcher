import type { PcRecord } from './types';

/** Accepts aa:bb:cc:dd:ee:ff, AA-BB-CC-DD-EE-FF, aabb.ccdd.eeff, aabbccddeeff. */
export function normalizeMac(input: string): string | null {
  const raw = input.trim();
  if (!/^[0-9a-fA-F:.\-\s]+$/.test(raw)) return null;
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function isValidIPv4(value: string): boolean {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0);
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}

export interface Cidr {
  network: number;
  prefix: number;
  broadcast: number;
}

export function parseCidr(cidr: string): Cidr | null {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/.exec(cidr.trim());
  if (!m || !isValidIPv4(m[1])) return null;
  const prefix = Number(m[2]);
  if (prefix < 8 || prefix > 30) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipToInt(m[1]) & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, prefix, broadcast };
}

/** Usable host addresses of a subnet (network and broadcast excluded), capped. */
export function hostsInCidr(cidr: string, max = 1024): string[] {
  const c = parseCidr(cidr);
  if (!c) return [];
  const out: string[] = [];
  for (let n = c.network + 1; n < c.broadcast && out.length < max; n++) out.push(intToIp(n));
  return out;
}

/** "730, 570 578080" -> [730, 570, 578080]. Returns null if a token is not a positive integer. */
export function parseAppIds(text: string): number[] | null {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const ids: number[] = [];
  for (const t of tokens) {
    if (!/^\d{1,10}$/.test(t)) return null;
    const n = Number(t);
    if (n <= 0) return null;
    if (!ids.includes(n)) ids.push(n);
  }
  return ids;
}

/** Validation messages are shown in the UI as-is. */
export function validatePc(pc: PcRecord, all: PcRecord[], originalId: number | null): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(pc.id) || pc.id < 1 || pc.id > 999) errors.push('Номер ПК має бути цілим числом 1–999.');
  if (all.some((p) => p.id === pc.id && p.id !== originalId)) errors.push(`ПК №${pc.id} уже існує.`);
  if (!isValidIPv4(pc.ip)) errors.push('Некоректна IP-адреса.');
  else if (all.some((p) => p.ip === pc.ip && p.id !== originalId)) errors.push(`IP ${pc.ip} уже використовується іншим ПК.`);
  if (!normalizeMac(pc.mac)) errors.push('Некоректна MAC-адреса (формат aa:bb:cc:dd:ee:ff).');
  else if (all.some((p) => p.mac === normalizeMac(pc.mac) && p.id !== originalId)) errors.push('Ця MAC-адреса вже належить іншому ПК.');
  if (!pc.zone.trim()) errors.push('Вкажіть зону.');
  return errors;
}
