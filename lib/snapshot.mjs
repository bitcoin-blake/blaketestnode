// Parses a Core/Knots dumptxoutset v2 file and computes hash_serialized_3 over
// it, exactly as GetUTXOStats does: per txid, coins in vout order, each as
// outpoint ‖ u32(height*2+coinbase) ‖ CTxOut, all through one SHA256d.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readCoin, readCompactSize, writeCompactSize, writeCoin } from './varint.mjs';

export const MAGIC = Buffer.from([0x75, 0x74, 0x78, 0x6f, 0xff]); // "utxo\xff"

export function readHeader(buf) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('not a utxo snapshot (bad magic)');
  const version = buf.readUInt16LE(5);
  if (version !== 2) throw new Error(`unsupported snapshot version ${version}`);
  const networkMagic = buf.subarray(7, 11).toString('hex');
  const baseHash = Buffer.from(buf.subarray(11, 43)).reverse().toString('hex');
  const coins = Number(buf.readBigUInt64LE(43));
  return { version, networkMagic, baseHash, coins, dataStart: 51 };
}

// hash_serialized_3 accumulator: one SHA256 over every coin as TxOutSer writes it, then SHA256 again.
class SerialHasher {
  constructor() { this.h = createHash('sha256'); this.chunk = Buffer.alloc(8 << 20); this.pos = 0; }
  put(b) { if (this.pos + b.length > this.chunk.length) this.flush(); if (b.length > this.chunk.length) { this.h.update(b); return; } b.copy(this.chunk, this.pos); this.pos += b.length; }
  flush() { if (this.pos) { this.h.update(this.chunk.subarray(0, this.pos)); this.pos = 0; } }
  // one txid group, coins in numeric vout order as Core's std::map iterates them
  group(txidRaw, coins) {
    if (coins.length > 1) coins.sort((a, b) => a[0] - b[0]);
    for (const [vout, coin] of coins) {
      const u = Buffer.alloc(16); u.writeUInt32LE(vout, 0); u.writeUInt32LE(coin.height * 2 + (coin.coinbase ? 1 : 0), 4); u.writeBigInt64LE(BigInt(coin.value), 8);
      this.put(txidRaw); this.put(u); this.put(writeCompactSize(coin.script.length)); this.put(coin.script);
    }
  }
  digest() { this.flush(); return createHash('sha256').update(this.h.digest()).digest().reverse().toString('hex'); }
}

// Writes a snapshot in the same format from a UtxoSet's groups() (cursor order), computing
// hash_serialized_3 and the file sha256 on the way; returns the manifest fields.
export async function writeSnapshot(path, utxo, { baseHeight, baseHash, networkMagic, coins, log = () => {} }) {
  const out = createWriteStream(path);
  const fileHash = createHash('sha256');
  const hasher = new SerialHasher();
  let bytes = 0, written = 0;
  const write = (b) => { bytes += b.length; fileHash.update(b); if (!out.write(b)) return new Promise((r) => out.once('drain', r)); };
  const head = Buffer.alloc(51); MAGIC.copy(head, 0); head.writeUInt16LE(2, 5); Buffer.from(networkMagic, 'hex').copy(head, 7);
  Buffer.from(baseHash, 'hex').reverse().copy(head, 11); head.writeBigUInt64LE(BigInt(coins), 43);
  await write(head);
  const t0 = performance.now();
  let batch = [], batchLen = 0;
  for (const [txidHex, group] of utxo.groups()) {
    const txidRaw = Buffer.from(txidHex, 'hex').reverse();
    const parts = [txidRaw, writeCompactSize(group.length)];
    for (const [vout, coin, raw] of group) { parts.push(writeCompactSize(vout), raw ?? writeCoin(coin)); }
    hasher.group(txidRaw, group);
    const rec = Buffer.concat(parts); batch.push(rec); batchLen += rec.length; written += group.length;
    if (batchLen >= (4 << 20)) { await write(Buffer.concat(batch)); batch = []; batchLen = 0; if (written % 2_000_000 < group.length) log(`  wrote ${written.toLocaleString()} coins, ${((performance.now() - t0) / 1000).toFixed(1)} s`); }
  }
  if (batch.length) await write(Buffer.concat(batch));
  await new Promise((r) => out.end(r));
  if (written !== coins) throw new Error(`wrote ${written} coins, expected ${coins}`);
  return { coins: written, bytes, hashSerialized: hasher.digest(), sha256: fileHash.digest('hex'), ms: performance.now() - t0 };
}

// Walks every coin. onCoin(txidHex, vout, offsetOfCoinBytes, coin) is called in
// file order; the hash is accumulated per txid group in vout order.
export function parseSnapshot(buf, { onCoin = null, hash = true, log = () => {} } = {}) {
  const head = readHeader(buf);
  const h = hash ? createHash('sha256') : null;
  let chunk = Buffer.alloc(8 << 20), cpos = 0;
  const flush = () => { if (cpos) { h.update(chunk.subarray(0, cpos)); cpos = 0; } };
  const put = (b) => { if (cpos + b.length > chunk.length) flush(); if (b.length > chunk.length) { h.update(b); return; } b.copy(chunk, cpos); cpos += b.length; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };

  let pos = head.dataStart, count = 0, groups = 0;
  const t0 = performance.now();
  while (count < head.coins) {
    const txidRaw = buf.subarray(pos, pos + 32); pos += 32;
    const txidHex = Buffer.from(txidRaw).reverse().toString('hex');
    let n; [n, pos] = readCompactSize(buf, pos);
    const group = [];
    for (let i = 0; i < n; i++) {
      let vout; [vout, pos] = readCompactSize(buf, pos);
      const off = pos;
      let coin; [coin, pos] = readCoin(buf, pos);
      group.push([vout, off, coin]);
      onCoin?.(txidHex, vout, off, coin);
    }
    if (h) {
      if (n > 1) group.sort((a, b) => a[0] - b[0]);
      for (const [vout, , coin] of group) {
        put(txidRaw); put(u32(vout)); put(u32(coin.height * 2 + (coin.coinbase ? 1 : 0)));
        put(i64(coin.value)); put(writeCompactSize(coin.script.length)); put(coin.script);
      }
    }
    count += n; groups++;
    if (groups % 1_000_000 === 0) log(`  ${count.toLocaleString()} coins, ${(pos / 1048576).toFixed(0)} MiB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (pos !== buf.length) throw new Error(`trailing bytes: ${buf.length - pos}`);
  let hashSerialized = null;
  if (h) { flush(); hashSerialized = createHash('sha256').update(h.digest()).digest().reverse().toString('hex'); }
  return { ...head, coinsRead: count, txids: groups, hashSerialized, ms: performance.now() - t0 };
}
