import { randomBytes } from 'node:crypto';

declare const __AGENT_VERSION__: string | undefined;
export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : '0.0.0-dev';

/** Error with a machine-readable code that travels to the admin app (MsgResponse.code). */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function shortId(): string {
  return randomBytes(6).toString('hex');
}

/** Resolves after ms, or rejects early when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/** JSON.parse that tolerates a UTF-8 BOM (Windows PowerShell 5.1 writes one). */
export function parseJsonFile<T>(text: string): T {
  return JSON.parse(text.replace(/^﻿/, '')) as T;
}
