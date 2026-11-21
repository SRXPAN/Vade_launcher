// Runs the agent locally in DRY-RUN mode on 127.0.0.1:7420 and restarts it on every change.
// Nothing on this PC is deleted, killed or switched off. The club key is taken from the
// admin app's settings so "npm run dev" + "npm run agent:dev" work together out of the box.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentRoot, bundleWatch } from './bundle.mjs';

const dataDir = path.join(agentRoot, 'dev-data');
const outfile = path.join(agentRoot, 'dist-dev', 'agent.cjs');
fs.mkdirSync(dataDir, { recursive: true });

const adminSettings = path.join(process.env.APPDATA ?? '', 'Vade Launcher', 'data', 'settings.json');
let clubKey = 'dev-club-key';
try {
  clubKey = JSON.parse(fs.readFileSync(adminSettings, 'utf8')).security.clubKey || clubKey;
  console.log(`[agent:dev] club key from ${adminSettings}`);
} catch {
  console.log('[agent:dev] admin settings not found yet — using "dev-club-key" (start the admin app first, then restart this)');
}
fs.writeFileSync(path.join(dataDir, 'agent.json'), JSON.stringify({ clubKey, port: 7420, bind: '127.0.0.1' }, null, 2));

let child = null;
const restart = () => {
  if (child) child.kill();
  child = spawn(process.execPath, [outfile, 'run', '--dry-run', '--data', dataDir], { stdio: 'inherit' });
};
const ctx = await bundleWatch(outfile, () => {
  console.log('[agent:dev] (re)start');
  restart();
});
await ctx.watch();
process.on('SIGINT', () => {
  child?.kill();
  process.exit(0);
});
