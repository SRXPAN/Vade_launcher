/**
 * Minimal Valve KeyValues (VDF/ACF text) parser.
 * Handles quoted/unquoted tokens, escapes, // comments and [$CONDITION] suffixes.
 */
export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

type Token = { kind: 'str'; value: string } | { kind: 'open' } | { kind: 'close' } | { kind: 'eof' };

export function parseVdf(text: string): VdfObject {
  let i = 0;
  const n = text.length;

  const skipWs = () => {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else break;
    }
  };

  const next = (): Token => {
    skipWs();
    if (i >= n) return { kind: 'eof' };
    const c = text[i];
    if (c === '{') {
      i++;
      return { kind: 'open' };
    }
    if (c === '}') {
      i++;
      return { kind: 'close' };
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else s += text[i++];
      }
      i++; // closing quote
      return { kind: 'str', value: s };
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return { kind: 'str', value: s };
  };

  const skipCondition = () => {
    skipWs();
    if (text[i] === '[') {
      while (i < n && text[i] !== ']') i++;
      i++;
    }
  };

  const parseObject = (): VdfObject => {
    const obj: VdfObject = {};
    for (;;) {
      const k = next();
      if (k.kind === 'eof' || k.kind === 'close') return obj;
      if (k.kind !== 'str') continue;
      skipCondition();
      const v = next();
      if (v.kind === 'open') obj[k.value] = parseObject();
      else if (v.kind === 'str') {
        obj[k.value] = v.value;
        skipCondition();
      } else return obj;
    }
  };

  return parseObject();
}

/** Case-insensitive key lookup (Valve files are not consistent about case). */
export function vdfGet(obj: VdfObject | undefined, key: string): VdfValue | undefined {
  if (!obj) return undefined;
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}
