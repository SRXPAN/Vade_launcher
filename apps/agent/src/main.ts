import fs from 'node:fs';
import path from 'node:path';
import { Agent } from './agent';
import { AgentBeaconSender } from './discovery';
import { installedServicePaths, takeUpdateResult, writeStartedMarker } from './update/selfUpdate';
import { Logger } from './logger';
import { AgentServer } from './server';
import { AgentStore } from './store';
import { Sys } from './sys';
import { AGENT_VERSION, errMsg } from './util';

interface Options {
  command: 'run' | 'version' | 'help';
  dryRun: boolean;
  service: boolean;
  dataDir: string;
  port?: number;
  clubKey?: string;
}

function parseOptions(argv: string[]): Options {
  const o: Options = {
    command: 'run',
    dryRun: false,
    service: false,
    dataDir: path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'VadeAgent'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'run') o.command = 'run';
    else if (a === 'version' || a === '--version' || a === '-v') o.command = 'version';
    else if (a === 'help' || a === '--help' || a === '-h') o.command = 'help';
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--service') o.service = true;
    else if (a === '--data') o.dataDir = path.resolve(argv[++i] ?? o.dataDir);
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--club-key') o.clubKey = argv[++i];
  }
  return o;
}

const HELP = `Vade Agent ${AGENT_VERSION}
  VadeAgent.exe run [--dry-run] [--data <dir>] [--port <n>] [--club-key <key>]
  VadeAgent.exe version
Normally started by the "VadeAgent" Windows service (see install.cmd).
--dry-run  nothing is deleted, killed or switched off — safe on any PC.`;

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.command === 'version') {
    console.log(AGENT_VERSION);
    return;
  }
  if (opts.command === 'help') {
    console.log(HELP);
    return;
  }

  const store = new AgentStore(opts.dataDir);
  const log = new Logger(path.join(opts.dataDir, 'logs'), !opts.service);
  const sys = new Sys(opts.dryRun, log);
  const clubKey = opts.clubKey ?? store.file.clubKey;
  const port = opts.port ?? store.file.port;

  log.info(`Vade Agent ${AGENT_VERSION} запущено${opts.dryRun ? ' в режимі DRY-RUN' : ''}; дані: ${opts.dataDir}`);
  if (!clubKey) log.error('У agent.json немає clubKey — адмін-панель не зможе підключитися. Перевстановіть агент з ключем.');

  process.on('uncaughtException', (e) => {
    log.error(`uncaughtException: ${e.stack ?? e.message}`);
    process.exit(1); // the service wrapper restarts the agent
  });
  process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${errMsg(e)}`));

  const agent = new Agent({ sys, log, store, dataDir: opts.dataDir });
  const server = new AgentServer(agent, { port, bind: store.file.bind, clubKey, allowFrom: store.file.allowFrom });
  await server.start();
  log.info(`Очікую адмін-панель на ${store.file.bind}:${server.port}`);
  await agent.init();
  const beacon = new AgentBeaconSender(server.port, store.file.discoveryPort);
  beacon.start();

  // Self-update bookkeeping: report the helper's verdict, drop a leftover download, tell the helper we run.
  const update = takeUpdateResult(opts.dataDir);
  if (update) log.log(update.ok ? 'info' : 'error', `Оновлення агента: ${update.message}`);
  const svc = installedServicePaths();
  if (svc && fs.existsSync(svc.newExe)) fs.rmSync(svc.newExe, { force: true });
  writeStartedMarker(opts.dataDir, AGENT_VERSION);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`Зупинка (${sig})…`);
    beacon.stop();
    await agent.shutdown();
    await server.close();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void stop(sig));
}

main().catch((e) => {
  console.error(`Fatal: ${errMsg(e)}`);
  process.exit(1);
});
