import { crc32 } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer };

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
/** MS-DOS date for 1980-01-01 — the format's minimum, used as a "no date" placeholder. */
const DOS_DATE_1980_01_01 = 0x21;
/** UTF-8 filenames (bit 11, "language encoding flag"). */
const FLAG_UTF8 = 0x0800;
/**
 * Unix regular file, rw-r--r--, packed into the high word of external attrs.
 * `>>> 0` forces this unsigned — `<<` alone works in 32-bit signed space in
 * JS, and this shift overflows into negative, which `writeUInt32LE` rejects.
 */
const UNIX_FILE_ATTR = (0o100644 << 16) >>> 0;

/**
 * Minimal STORE-method (uncompressed) ZIP writer with no external dependency
 * — this project's pipeline outputs are already-compressed JPEGs, so DEFLATE
 * would spend CPU for no size win, and STORE keeps the format simple enough
 * to hand-verify against the spec.
 */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data) >>> 0;
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIG, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_DIR_SIG, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(UNIX_FILE_ATTR, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirBuffer = Buffer.concat(centralParts);
  const centralDirOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIR_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirBuffer.length, 12);
  end.writeUInt32LE(centralDirOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuffer, end]);
}
