import dgram from 'node:dgram';
import os from 'node:os';
import { DEFAULT_DISCOVERY_PORT, intToIp, ipToInt, normalizeMac, type DiscoveryBeacon } from '@vade/protocol';

const BEACON_INTERVAL_MS = 60_000;
const VIRTUAL_NIC_RE = /vethernet|wsl|hyper-v|vmware|virtualbox|vbox|docker|tailscale|zerotier|hamachi|radmin|wireguard|tun|tap|loopback|bluetooth/i;

export interface ActiveLanInfo {
  macs: string[];
  broadcasts: string[];
}

/** Collects active non-virtual IPv4 MAC addresses and directed subnet broadcast addresses. */
export function collectActiveLanInfo(ifaces = os.networkInterfaces()): ActiveLanInfo {
  const physicalMacs: string[] = [];
  const fallbackMacs: string[] = [];
  const broadcasts = new Set<string>(['255.255.255.255']);

  for (const [name, addrs] of Object.entries(ifaces)) {
    const isVirtual = VIRTUAL_NIC_RE.test(name);
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const mac = normalizeMac(a.mac);
      if (!mac || mac === '00:00:00:00:00:00') continue;
      const target = isVirtual ? fallbackMacs : physicalMacs;
      if (!target.includes(mac)) target.push(mac);
      if (!isVirtual && a.address && a.netmask) {
        try {
          const bcast = intToIp((ipToInt(a.address) | (~ipToInt(a.netmask) >>> 0)) >>> 0);
          if (bcast && bcast !== '0.0.0.0') broadcasts.add(bcast);
        } catch {
          // ignore malformed address
        }
      }
    }
  }

  return {
    macs: physicalMacs.length > 0 ? physicalMacs : fallbackMacs,
    broadcasts: [...broadcasts],
  };
}

export function buildDiscoveryBeacon(agentPort: number, hostname = os.hostname(), macs = collectActiveLanInfo().macs): DiscoveryBeacon | null {
  if (macs.length === 0) return null;
  return {
    t: 'vade.beacon',
    v: 1,
    port: agentPort,
    hostname,
    macs,
  };
}

/**
 * Broadcasts a lightweight UDP beacon every 60 s (and immediately on start) so the admin app
 * can automatically detect DHCP IP changes by MAC address.
 */
export class AgentBeaconSender {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly agentPort: number,
    private readonly discoveryPort: number = DEFAULT_DISCOVERY_PORT,
    private readonly intervalMs: number = BEACON_INTERVAL_MS,
  ) {}

  start(): void {
    this.stop();
    void this.sendOnce();
    this.timer = setInterval(() => void this.sendOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sendOnce(targets?: string[]): Promise<boolean> {
    const lan = collectActiveLanInfo();
    const beacon = buildDiscoveryBeacon(this.agentPort, os.hostname(), lan.macs);
    if (!beacon) return false;
    const payload = Buffer.from(JSON.stringify(beacon), 'utf8');
    const hosts = targets ?? lan.broadcasts;

    return new Promise<boolean>((resolve) => {
      const sock = dgram.createSocket('udp4');
      let closed = false;
      const close = (ok: boolean) => {
        if (closed) return;
        closed = true;
        try {
          sock.close();
        } catch {
          // ignore
        }
        resolve(ok);
      };
      sock.once('error', () => close(false));
      sock.bind(0, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          // ignore on loopback-only test targets
        }
        let pending = hosts.length;
        if (pending === 0) return close(false);
        for (const host of hosts) {
          sock.send(payload, this.discoveryPort, host, () => {
            if (--pending <= 0) close(true);
          });
        }
      });
    });
  }
}
