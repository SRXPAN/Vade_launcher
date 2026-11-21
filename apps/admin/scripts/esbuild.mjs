import path from 'node:path';

export const adminRoot = path.resolve(import.meta.dirname, '..');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
};

export const mainOptions = {
  ...common,
  entryPoints: [path.join(adminRoot, 'src', 'main', 'index.ts')],
  outfile: path.join(adminRoot, 'out', 'main.cjs'),
};

export const preloadOptions = {
  ...common,
  entryPoints: [path.join(adminRoot, 'src', 'preload', 'index.ts')],
  outfile: path.join(adminRoot, 'out', 'preload.cjs'),
};

export const viteConfigFile = path.join(adminRoot, 'vite.config.mts');
