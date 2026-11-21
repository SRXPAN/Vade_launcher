// Dev mode: Vite dev server with hot reload for the UI, esbuild watch for main/preload,
// Electron restarted automatically when main/preload change.
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { context } from 'esbuild';
import { createServer } from 'vite';
import { adminRoot, mainOptions, preloadOptions, viteConfigFile } from './esbuild.mjs';

const server = await createServer({ configFile: viteConfigFile, mode: 'development' });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://localhost:5173/';
console.log(`[dev] renderer ${url}`);

let child = null;
let restartTimer = null;
let ready = 0;

function startElectron() {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  const env = { ...process.env, VADE_DEV_URL: url };
  delete env.ELECTRON_RUN_AS_NODE; // set by VS Code extension hosts; would turn Electron into plain Node
  child = spawn(electronPath, ['.'], { cwd: adminRoot, stdio: 'inherit', env });
  child.on('exit', async (code) => {
    await server.close();
    process.exit(code ?? 0);
  });
}

const restartPlugin = {
  name: 'restart-electron',
  setup(b) {
    b.onEnd((r) => {
      if (r.errors.length) return;
      if (ready < 2) {
        if (++ready === 2) startElectron();
        return;
      }
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        console.log('[dev] main/preload changed — restarting Electron');
        startElectron();
      }, 300);
    });
  },
};

const ctxMain = await context({ ...mainOptions, plugins: [restartPlugin] });
const ctxPreload = await context({ ...preloadOptions, plugins: [restartPlugin] });
await Promise.all([ctxMain.watch(), ctxPreload.watch()]);
