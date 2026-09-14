// A Core/Knots dumptxoutset v2 file, read in windows from any byte source ({ size, read(off, len) },
// a file descriptor in Node, an OPFS sync access handle in a worker) and hashed as it goes:
// hash_serialized_3 is one SHA256d over every coin, per txid in vout order, as GetUTXOStats does.
import { readCoin, readCompactSize, writeCompactSize } from './varint.mjs';
import { bytesToHex, reverse, putU32le, putI64le, concat, u16le, u64le } from './bytes.mjs';
import { Sha256 } from './sha256.mjs';

export const MAGIC = Uint8Array.of(0x75, 0x74, 0x78, 0x6f, 0xff); // "utxo\xff"
export const HEADER_BYTES = 51;

export function readHeader(b) {
  for (let i = 0; i < 5; i++) if (b[i] !== MAGIC[i]) throw new Error('not a utxo snapshot (bad magic)');
  const version = u16le(b, 5);
  if (version !== 2) throw new Error(`unsupported snapshot version ${version}`);
  return { version, networkMagic: bytesToHex(b.subarray(7, 11)), baseHash: bytesToHex(reverse(b.subarray(11, 43))), coins: u64le(b, 43), dataStart: HEADER_BYTES };
}

// hash_serialized_3 accumulator; `hasher` makes an object with update()/digest().
export class SerialHasher {
  constructor(hasher = () => new Sha256()) { this.mk = hasher; this.h = hasher(); this.chunk = new Uint8Array(8 << 20); this.pos = 0; }
  put(b) { if (this.pos + b.length > this.chunk.length) this.flush(); if (b.length > this.chunk.length) { this.h.update(b); return; } this.chunk.set(b, this.pos); this.pos += b.length; }
  flush() { if (this.pos) { this.h.update(this.chunk.subarray(0, this.pos)); this.pos = 0; } }
  // one txid group, coins [[vout, coin]] in numeric vout order as Core's std::map iterates them
  group(txidRaw, coins) {
    if (coins.length > 1) coins.sort((a, b) => a[0] - b[0]);
    for (const [vout, coin] of coins) {
      const u = new Uint8Array(16); putU32le(u, 0, vout); putU32le(u, 4, coin.height * 2 + (coin.coinbase ? 1 : 0)); putI64le(u, 8, coin.value);
      this.put(txidRaw); this.put(u); this.put(writeCompactSize(coin.script.length)); this.put(coin.script);
    }
  }
  digest() { this.flush(); return bytesToHex(reverse(this.mk().update(this.h.digest()).digest())); }
}

// Walks every coin in one pass through a sliding window. onCoin(txidRaw, vout, voutOffset,
// groupOffset, coin) is called in file order. Returns the header fields plus counts and hash.
export function parseSnapshot(source, { onCoin = null, hash = true, hasher, log = () => {}, windowBytes = 16 << 20 } = {}) {
  const head = readHeader(source.read(0, HEADER_BYTES));
  const sh = hash ? new SerialHasher(hasher) : null;
  const size = source.size;
  let win = source.read(0, Math.min(windowBytes, size)), winOff = 0;
  const ensure = (pos, need) => { if (pos + need > winOff + win.length && winOff + win.length < size) { win = source.read(pos, Math.min(windowBytes, size - pos)); winOff = pos; } return pos - winOff; };
  let pos = head.dataStart, count = 0, groups = 0;
  const t0 = performance.now();
  while (count < head.coins) {
    let p = ensure(pos, 41);
    const groupOff = pos; const txidRaw = Uint8Array.from(win.subarray(p, p + 32)); p += 32;
    let n; [n, p] = readCompactSize(win, p); pos = winOff + p;
    const group = sh ? [] : null;
    for (let i = 0; i < n; i++) {
      p = ensure(pos, 10040); // vout, code, amount, script (compactsize + at most 10000 bytes)
      const voutOff = winOff + p;
      let vout; [vout, p] = readCompactSize(win, p);
      let coin; [coin, p] = readCoin(win, p);
      if (sh) { coin.script = Uint8Array.from(coin.script); group.push([vout, coin]); }
      onCoin?.(txidRaw, vout, voutOff, groupOff, coin);
      pos = winOff + p;
    }
    if (sh) sh.group(txidRaw, group);
    count += n; groups++;
    if (groups % 1_000_000 === 0) log(`  ${count.toLocaleString()} coins, ${(pos / 1048576).toFixed(0)} MiB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (pos !== size) throw new Error(`trailing bytes: ${size - pos}`);
  return { ...head, coinsRead: count, txids: groups, hashSerialized: sh ? sh.digest() : null, ms: performance.now() - t0 };
}
