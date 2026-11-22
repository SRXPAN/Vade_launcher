import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_AGENT_PORT, DEFAULT_DISCOVERY_PORT, type AgentConfigPayload, type JobState, type QuickCleanInfo } from '@vade/protocol';
import { parseJsonFile } from './util';

/** agent.json — written by the installer, read-only for the agent. */
export interface AgentFileConfig {
  clubKey: string;
  port: number;
  bind: string;
  /** If not empty, only these admin IPs may connect (127.0.0.1 is always allowed). */
  allowFrom: string[];
  /** UDP port for LAN discovery beacons (default 7422) */
  discoveryPort: number;
}

/** state.json — owned by the agent. */
export interface AgentPersistedState {
  config: AgentConfigPayload | null;
  /** occurrenceKey of the last slot that was run (or deliberately skipped) */
  lastScheduledKey: string | null;
  lastJob: JobState | null;
  lastQuickClean?: QuickCleanInfo | null;
  /** Last agent version that registered Windows Defender folder exclusions */
  defenderExcludedVersion?: string | null;
}

export class AgentStore {
  readonly file: AgentFileConfig;
  state: AgentPersistedState;
  private readonly statePath: string;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = AgentStore.readFileConfig(path.join(dataDir, 'agent.json'));
    this.statePath = path.join(dataDir, 'state.json');
    this.state = { config: null, lastScheduledKey: null, lastJob: null };
    try {
      this.state = { ...this.state, ...parseJsonFile<Partial<AgentPersistedState>>(fs.readFileSync(this.statePath, 'utf8')) };
    } catch {
      // first start or damaged file: start clean
    }
  }

  static readFileConfig(file: string): AgentFileConfig {
    let raw: Partial<AgentFileConfig> = {};
    try {
      raw = parseJsonFile<Partial<AgentFileConfig>>(fs.readFileSync(file, 'utf8'));
    } catch {
      // missing: the agent starts but refuses every connection
    }
    return {
      clubKey: typeof raw.clubKey === 'string' ? raw.clubKey.trim() : '',
      port: Number.isInteger(raw.port) && raw.port! > 0 ? raw.port! : DEFAULT_AGENT_PORT,
      bind: typeof raw.bind === 'string' && raw.bind ? raw.bind : '0.0.0.0',
      allowFrom: Array.isArray(raw.allowFrom) ? raw.allowFrom.filter((x): x is string => typeof x === 'string' && !!x) : [],
      discoveryPort: Number.isInteger(raw.discoveryPort) && raw.discoveryPort! > 0 ? raw.discoveryPort! : DEFAULT_DISCOVERY_PORT,
    };
  }

  /** Atomic write: a power loss never leaves a half-written state.json. */
  saveState(): void {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }
}
