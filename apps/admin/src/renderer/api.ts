import type { VadeApi } from '../shared/api';

declare global {
  interface Window {
    vade: VadeApi;
  }
}

export const api: VadeApi = window.vade;

/** Electron prefixes errors thrown in main: "Error invoking remote method 'x': Error: ..." */
export function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
