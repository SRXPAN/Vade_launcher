import dgram from 'node:dgram';
import {
  DEFAULT_DISCOVERY_PORT,
  isValidIPv4,
  normalizeMac,
  parseDiscoveryBeacon,
  type DiscoveryBeacon,
  type PcRecord,
} from '@vade/protocol';
import type { AgentHub } from './hub';
import type { AdminStore } from './store';

export interface BeaconMatch {
  pc: PcRecord;
  oldIp: string;
  newIp: string;
  mac: string;
}

/**
 * Matches an incoming UDP discovery beacon against pcs.json by normalized MAC address.
 * Returns a match only when the sender's IPv4 address differs from the stored PC IP
 * and does not conflict with another registered PC.
 */
export function matchBeaconToPc(pcs: PcRecord[], beacon: DiscoveryBeacon, senderIp: string): BeaconMatch | null {
  const newIp = senderIp.trim().replace(/^::ffff:/i, '');
  if (!isValidIPv4(newIp)) return null;

  const beaconMacs = new Set<string>();
  for (const m of beacon.macs) {
    const norm = normalizeMac(m);
    if (norm && norm !== '00:00:00:00:00:00') beaconMacs.add(norm);
  }
  if (beaconMacs.size === 0) return null;

  for (const pc of pcs) {
    const pcMac = normalizeMac(pc.mac);
    if (!pcMac || !beaconMacs.has(pcMac)) continue;
    if (pc.ip === newIp) return null;
    if (pcs.some((other) => other.id !== pc.id && other.ip === newIp)) return null;
    return { pc, oldIp: pc.ip, newIp, mac: pcMac };
  }
  return null;
}

/**
 * Applies a beacon packet to the store + hub: updates pcs.json, writes the admin log entry,
 * notifies the UI and reconnects AgentLink to the new IP.
 */
export function handleBeaconPacket(
  raw: Buffer | string,
  senderIp: string,
  store: AdminStore,
  hub: Pick<AgentHub, 'adminLog' | 'sync' | 'emit'>,
): BeaconMatch | null {
  const beacon = parseDiscoveryBeacon(raw);
  if (!beacon) return null;
  const match = matchBeaconToPc(store.pcs, beacon, senderIp);
  if (!match) return null;
  if (!store.setIp(match.pc.id, match.newIp)) return null;
  hub.adminLog(match.pc.id, 'info', `Виявлено зміну IP по MAC: ${match.oldIp} → ${match.newIp}`);
  hub.emit('pcsChanged', store.pcs);
  hub.sync();
  return match;
}

/**
 * Listens for UDP discovery beacons on the configured port (default 7422) and automatically
 * updates PC IP addresses in pcs.json when DHCP leases change.
 */
export class AdminDiscoveryListener {
  private sock: dgram.Socket | null = null;
  private boundPort = 0;

  constructor(
    private readonly store: AdminStore,
    private readonly hub: AgentHub,
    private readonly bindHost = '0.0.0.0',
  ) {}

  start(): void {
    this.reconfigure();
  }

  reconfigure(): void {
    const { discoveryEnabled, discoveryPort } = this.store.settings.network;
    const port = discoveryPort || DEFAULT_DISCOVERY_PORT;
    if (!discoveryEnabled) {
      this.stop();
      return;
    }
    if (this.sock && this.boundPort === port) return;
    this.stop();

    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {
      // port in use or network unavailable: close quietly without crashing the admin app
      if (this.sock === sock) this.stop();
    });
    sock.on('message', (msg, rinfo) => {
      handleBeaconPacket(msg, rinfo.address, this.store, this.hub);
    });
    sock.bind(port, this.bindHost);
    sock.unref?.();
    this.sock = sock;
    this.boundPort = port;
  }

  stop(): void {
    const s = this.sock;
    this.sock = null;
    this.boundPort = 0;
    if (s) {
      try {
        s.removeAllListeners();
        s.close();
      } catch {
        // ignore
      }
    }
  }
}
