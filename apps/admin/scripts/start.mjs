// Runs the built admin app (out/) with the Electron binary from node_modules.
// Useful where an unsigned installer is blocked (Windows Smart App Control).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electronPath from 'electron';
import { adminRoot } from './esbuild.mjs';

if (!fs.existsSync(path.join(adminRoot, 'out', 'main.cjs'))) {
  console.error('Спершу зберіть адмінку: npm run build:admin');
  process.exit(1);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code extension hosts; would turn Electron into plain Node
const child = spawn(electronPath, ['.', ...process.argv.slice(2)], { cwd: adminRoot, stdio: 'inherit', env, detached: true });
child.unref();
