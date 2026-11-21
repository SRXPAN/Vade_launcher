// Builds dist/package: VadeAgent.exe (Node SEA) + WinSW service wrapper + install scripts.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentRoot, bundle } from './bundle.mjs';

const WINSW_VERSION = '2.12.0';
const WINSW_URL = `https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW-x64.exe`;

const dist = path.join(agentRoot, 'dist');
const out = path.join(dist, 'package');
const vendor = path.join(agentRoot, 'vendor');
const winsw = path.join(vendor, `WinSW-x64-${WINSW_VERSION}.exe`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

console.log('• bundle agent.cjs');
const bundled = path.join(dist, 'agent.cjs');
await bundle(bundled);

console.log(`• single executable (Node ${process.version})`);
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundled,
    output: path.join(out, 'VadeAgent.exe'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
  }),
);
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });

if (!fs.existsSync(winsw)) {
  console.log(`• download WinSW ${WINSW_VERSION}`);
  const res = await fetch(WINSW_URL);
  if (!res.ok) throw new Error(`WinSW download failed: HTTP ${res.status}. Put WinSW-x64.exe to ${winsw} manually.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100_000 || buf.subarray(0, 2).toString() !== 'MZ') throw new Error('WinSW download is not an .exe');
  fs.mkdirSync(vendor, { recursive: true });
  fs.writeFileSync(winsw, buf);
}
console.log(`  WinSW sha256 ${createHash('sha256').update(fs.readFileSync(winsw)).digest('hex')}`);
fs.copyFileSync(winsw, path.join(out, 'VadeAgentService.exe'));

for (const f of fs.readdirSync(path.join(agentRoot, 'install'))) {
  fs.copyFileSync(path.join(agentRoot, 'install', f), path.join(out, f));
}

// Smoke test. Antivirus often scans a freshly written .exe for a few seconds and blocks
// CreateProcess meanwhile (spawn UNKNOWN), so retry before giving up.
let version = '';
for (let attempt = 1; ; attempt++) {
  try {
    version = execFileSync(path.join(out, 'VadeAgent.exe'), ['version']).toString().trim();
    break;
  } catch (e) {
    if (attempt >= 8) throw e;
    console.log(`  VadeAgent.exe is not runnable yet (${e.code ?? e.message}), retry ${attempt}…`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}
const exeBytes = fs.statSync(path.join(out, 'VadeAgent.exe')).size;
const sha256 = createHash('sha256').update(fs.readFileSync(path.join(out, 'VadeAgent.exe'))).digest('hex');
// Read by the admin app for the OTA update ("Оновити агент").
fs.writeFileSync(path.join(out, 'agent-version.json'), JSON.stringify({ version, sha256, size: exeBytes }, null, 2));
console.log(`✔ ${out}\n  VadeAgent.exe ${version}, ${(exeBytes / 1024 / 1024).toFixed(1)} MB, sha256 ${sha256.slice(0, 16)}…`);
