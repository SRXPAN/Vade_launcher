/**
 * Minimal pure-Node ZIP builder (STORE & DEFLATE) using zlib.deflateRawSync.
 * Avoids external npm dependencies and slow PowerShell Compress-Archive calls.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  /** Keep uncompressed (useful for pre-compressed / large binaries like VadeAgent.exe). */
  store?: boolean;
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const mins = d.getMinutes();
  const secs = Math.floor(d.getSeconds() / 2);
  return {
    time: ((hours & 0x1f) << 11) | ((mins & 0x3f) << 5) | (secs & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

export function createZipBuffer(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const cleanName = entry.name.replace(/\\/g, '/').replace(/^\/+/, '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(raw);

    let compressed = raw;
    let method = 0; // STORE
    if (!entry.store && raw.length > 0) {
      const def = deflateRawSync(raw, { level: 6 });
      if (def.length < raw.length) {
        compressed = def;
        method = 8; // DEFLATE
      }
    }

    const { time, date } = dosDateTime(entry.mtime ?? new Date());
    const flags = 0x0800; // UTF-8 filename

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    nameBuf.copy(local, 30);

    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra len
    central.writeUInt16LE(0, 32); // comment len
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

export async function writeZipFile(destPath: string, entries: ZipEntry[]): Promise<number> {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const buf = createZipBuffer(entries);
  const tmp = `${destPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, destPath);
  return buf.length;
}

const DRIVE_PREFIX_RE = /^[A-Za-z]:/;

/**
 * Normalizes a ZIP entry path and rejects path traversal, drive letters, leading slashes, or empty names.
 */
function sanitizeZipEntryName(rawName: string): { name: string; isDir: boolean } {
  if (!rawName || rawName.includes('\0')) {
    throw new Error('Unsafe ZIP entry: empty or contains null byte');
  }
  const normalized = rawName.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || DRIVE_PREFIX_RE.test(normalized)) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  const isDir = normalized.endsWith('/');
  const trimmed = isDir ? normalized.slice(0, -1) : normalized;
  if (!trimmed) {
    throw new Error(`Unsafe ZIP entry path: ${rawName}`);
  }
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || DRIVE_PREFIX_RE.test(seg)) {
      throw new Error(`Unsafe ZIP entry path: ${rawName}`);
    }
  }
  return { name: trimmed, isDir };
}

function findEocdOffset(buf: Buffer): number {
  if (buf.length < 22) {
    throw new Error('Invalid ZIP archive: file too small');
  }
  const minOffset = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error('Invalid ZIP archive: End of Central Directory not found');
}

/**
 * Pure-Node ZIP archive reader supporting STORE (method 0) and DEFLATE (method 8).
 * Validates path safety, CRC32 checksums, and uncompressed sizes before returning entries.
 */
export function readZipBuffer(buf: Buffer): Map<string, Buffer> {
  const eocdOffset = findEocdOffset(buf);
  const diskNum = buf.readUInt16LE(eocdOffset + 4);
  const cdDisk = buf.readUInt16LE(eocdOffset + 6);
  const diskEntries = buf.readUInt16LE(eocdOffset + 8);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdSize = buf.readUInt32LE(eocdOffset + 12);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  if (diskNum !== 0 || cdDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('Multi-disk ZIP archives are not supported');
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }
  const cdEnd = cdOffset + cdSize;
  if (cdEnd > eocdOffset) {
    throw new Error('Invalid ZIP archive: Central Directory exceeds bounds');
  }

  const out = new Map<string, Buffer>();
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > cdEnd || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: corrupt Central Directory header');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const expectedCrc = buf.readUInt32LE(pos + 16);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const nextPos = pos + 46 + nameLen + extraLen + commentLen;
    if (nextPos > cdEnd) {
      throw new Error('Invalid ZIP archive: Central Directory entry exceeds bounds');
    }
    if ((flags & 0x0001) !== 0) {
      throw new Error('Encrypted ZIP entries are not supported');
    }
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error('ZIP64 entries are not supported');
    }

    const rawName = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos = nextPos;

    const { name, isDir } = sanitizeZipEntryName(rawName);
    if (isDir) {
      if (uncompressedSize !== 0 || compressedSize !== 0) {
        throw new Error(`Invalid ZIP directory entry with non-zero size: ${rawName}`);
      }
      continue;
    }

    if (localHeaderOffset + 30 > cdOffset || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP archive: corrupt Local File Header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > cdOffset || dataEnd > cdOffset) {
      throw new Error(`Invalid ZIP archive: entry data out of bounds for ${name}`);
    }

    const slice = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(slice);
    } else if (method === 8) {
      data = inflateRawSync(slice);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`ZIP size mismatch for ${name}: expected ${uncompressedSize}, got ${data.length}`);
    }
    if (crc32(data) !== expectedCrc) {
      throw new Error(`ZIP CRC32 mismatch for ${name}`);
    }

    out.set(name, data);
  }

  return out;
}

/** Reads and validates all entries from a ZIP file on disk. */
export async function readZipFile(filePath: string): Promise<Map<string, Buffer>> {
  const buf = await fsp.readFile(filePath);
  return readZipBuffer(buf);
}
