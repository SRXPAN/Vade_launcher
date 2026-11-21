// Production build: out/main.cjs, out/preload.cjs (esbuild) and out/renderer (Vite).
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { adminRoot, mainOptions, preloadOptions, viteConfigFile } from './esbuild.mjs';

fs.rmSync(path.join(adminRoot, 'out'), { recursive: true, force: true });
await Promise.all([build(mainOptions), build(preloadOptions)]);
await viteBuild({ configFile: viteConfigFile, mode: 'production', logLevel: 'warn' });
console.log(`✔ ${path.join(adminRoot, 'out')}`);
