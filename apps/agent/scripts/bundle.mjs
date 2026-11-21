import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

export const agentRoot = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(agentRoot, 'package.json'), 'utf8'));

/** One self-contained CommonJS file: required by Node single executable applications. */
export function bundleOptions(outfile) {
  return {
    entryPoints: [path.join(agentRoot, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    // ws optional native add-ons: not available inside a single executable
    external: ['bufferutil', 'utf-8-validate'],
    define: {
      __AGENT_VERSION__: JSON.stringify(pkg.version),
      'process.env.WS_NO_BUFFER_UTIL': '"1"',
      'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
    },
  };
}

export function bundle(outfile) {
  return build(bundleOptions(outfile));
}

export function bundleWatch(outfile, onRebuilt) {
  return context({
    ...bundleOptions(outfile),
    plugins: [{ name: 'notify', setup: (b) => b.onEnd((r) => r.errors.length === 0 && onRebuilt()) }],
  });
}
