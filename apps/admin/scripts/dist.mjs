// Builds the NSIS installer: release/VadeLauncher-Setup-<version>.exe (run scripts/build.mjs first).
//
// Why not just `electron-builder`: to produce the uninstaller, electron-builder RUNS an intermediate,
// freshly built, unsigned installer once. Windows 11 Smart App Control blocks running such files, and the
// build fails with "spawn UNKNOWN". Here that single step extracts the uninstaller from the intermediate
// installer without running it — the same UninstallerReader electron-builder itself uses on macOS.
// Everything else is the normal electron-builder build with electron-builder.yml.
import { createRequire } from 'node:module';
import path from 'node:path';
import { adminRoot } from './esbuild.mjs';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const { build } = require('electron-builder');

try {
  const { WineVmManager } = builderRequire('app-builder-lib/out/vm/WineVm');
  const { UninstallerReader } = builderRequire('app-builder-lib/out/targets/nsis/nsisUtil');
  const original = WineVmManager.prototype.exec;
  WineVmManager.prototype.exec = async function (file, args = [], options = {}, ...rest) {
    const uninstallerStep =
      process.platform === 'win32' && args.length === 0 && options?.env?.__COMPAT_LAYER === 'RunAsInvoker' && /\.exe$/i.test(file);
    if (!uninstallerStep) return original.call(this, file, args, options, ...rest);
    // Same name electron-builder expects (NsisTarget.computeScriptAndSignUninstaller).
    const uninstaller = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    await UninstallerReader.exec(file, uninstaller);
    console.log('  • uninstaller extracted without running the intermediate installer (Smart App Control safe)');
    return '';
  };
} catch (e) {
  console.warn(`  • uninstaller workaround not applied (${e.message}); building the usual way`);
}

const artifacts = await build({ projectDir: adminRoot, config: path.join(adminRoot, 'electron-builder.yml') });
for (const a of artifacts) console.log(`✔ ${a}`);
