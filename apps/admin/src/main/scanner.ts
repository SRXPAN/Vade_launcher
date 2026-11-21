import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { hostsInCidr, normalizeMac } from '@vade/protocol';
import type { ScanHost, ScanProgress } from '../shared/api';

const sys32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

function ping(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path.join(sys32, 'PING.EXE'), ['-n', '1', '-w', '600', ip], { windowsHide: true, timeout: 3000 }, (_e, stdout) => {
      resolve(/TTL=/i.test(String(stdout ?? '')));
    });
  });
}

function probeTcp(ip: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** IP -> MAC from the Windows ARP cache (filled by the ping sweep, even if ICMP is blocked). */
export function readArp(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    execFile(path.join(sys32, 'ARP.EXE'), ['-a'], { windowsHide: true, timeout: 10_000 }, (_e, stdout) => {
      const map = new Map<string, string>();
      for (const line of String(stdout ?? '').split(/\r?\n/)) {
        const m = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s/i.exec(line);
        if (!m) continue;
        const mac = normalizeMac(m[2]);
        if (!mac || mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e')) continue;
        map.set(m[1], mac);
      }
      resolve(map);
    });
  });
}

export function localIpv4(): Array<{ ip: string; mac: string }> {
  const out: Array<{ ip: string; mac: string }> = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push({ ip: a.address, mac: a.mac });
  }
  return out;
}

/** Ping sweep + agent port probe + ARP table. */
export async function scanNetwork(cidr: string, agentPort: number, onProgress: (p: ScanProgress) => void): Promise<ScanHost[]> {
  const hosts = hostsInCidr(cidr, 1024);
  if (hosts.length === 0) throw new Error(`Некоректна підмережа: ${cidr}`);
  const found = new Map<string, { alive: boolean; agent: boolean }>();
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const ip = hosts[next++];
      const [alive, agent] = await Promise.all([ping(ip), probeTcp(ip, agentPort)]);
      found.set(ip, { alive, agent });
      done++;
      if (done % 8 === 0 || done === hosts.length) onProgress({ done, total: hosts.length });
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));

  const arp = await readArp();
  const self = new Map(localIpv4().map((x) => [x.ip, x.mac]));
  const result: ScanHost[] = [];
  for (const ip of hosts) {
    const f = found.get(ip)!;
    const mac = arp.get(ip) ?? (self.has(ip) ? normalizeMac(self.get(ip)!) : null);
    if (!f.alive && !f.agent && !mac) continue;
    result.push({ ip, mac, alive: f.alive, agent: f.agent, self: self.has(ip) });
  }
  return result;
}
