// Parses a Core/Knots dumptxoutset v2 file and computes hash_serialized_3 over
// it, exactly as GetUTXOStats does: per txid, coins in vout order, each as
// outpoint ‖ u32(height*2+coinbase) ‖ CTxOut, all through one SHA256d.
import { createHash } from 'node:crypto';
import { readCoin, readCompactSize, writeCompactSize } from './varint.mjs';

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
