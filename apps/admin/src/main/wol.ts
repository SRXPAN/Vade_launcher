import dgram from 'node:dgram';
import { normalizeMac } from '@vade/protocol';

/** 6 x 0xFF followed by the MAC address 16 times. */
export function magicPacket(mac: string): Buffer {
  const norm = normalizeMac(mac);
  if (!norm) throw new Error(`Некоректна MAC-адреса: ${mac}`);
  const macBytes = Buffer.from(norm.replace(/:/g, ''), 'hex');
  const pkt = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(pkt, 6 + i * 6);
  return pkt;
}

/**
 * Sends the magic packet 3 times to the directed broadcast of the club subnet
 * (e.g. 10.70.4.255) and to 255.255.255.255, so it leaves through the right adapter.
 */
export async function sendWol(mac: string, broadcast: string, port: number): Promise<void> {
  const pkt = magicPacket(mac);
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      resolve();
    });
  });
  const send = (host: string) =>
    new Promise<void>((resolve, reject) => sock.send(pkt, port, host, (err) => (err ? reject(err) : resolve())));
  try {
    for (let i = 0; i < 3; i++) {
      await send(broadcast);
      await send('255.255.255.255').catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    sock.close();
  }
}
