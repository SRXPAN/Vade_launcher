import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Strict CSP in the production build only (the dev server needs inline HMR scripts). */
const csp: Plugin = {
  name: 'vade-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'" />`,
    ),
};

export default defineConfig({
  root: here('./src/renderer'),
  base: './',
  plugins: [react(), csp],
  build: {
    outDir: here('./out/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: { port: 5173 },
});
