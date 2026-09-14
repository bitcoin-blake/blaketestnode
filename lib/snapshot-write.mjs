// Writes a snapshot in the dumptxoutset v2 format from a UTXO set's groups() (cursor order),
// computing hash_serialized_3 and the file sha256 on the way. Node only (streams to disk).
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { MAGIC, SerialHasher } from './snapshot.mjs';
import { writeCoin, writeCompactSize } from './varint.mjs';
import { reverse, hexToBytes, putU64le, putU16le } from './bytes.mjs';

const nodeHasher = () => { const h = createHash('sha256'); return { update(d) { h.update(d); return this; }, digest: () => new Uint8Array(h.digest()) }; };

export async function writeSnapshot(path, utxo, { baseHeight, baseHash, networkMagic, coins, log = () => {} }) {
  const out = createWriteStream(path);
  const fileHash = createHash('sha256');
  const hasher = new SerialHasher(nodeHasher);
  let bytes = 0, written = 0;
  const write = (b) => { bytes += b.length; fileHash.update(b); if (!out.write(b)) return new Promise((r) => out.once('drain', r)); };
  const head = new Uint8Array(51); head.set(MAGIC, 0); putU16le(head, 5, 2); head.set(hexToBytes(networkMagic), 7); head.set(reverse(hexToBytes(baseHash)), 11); putU64le(head, 43, coins);
  await write(head);
  const t0 = performance.now();
  let batch = [], batchLen = 0;
  for (const [txidHex, group] of utxo.groups()) {
    const txidRaw = reverse(hexToBytes(txidHex));
    const parts = [txidRaw, writeCompactSize(group.length)];
    for (const [vout, coin, raw] of group) parts.push(writeCompactSize(vout), raw ?? writeCoin(coin));
    hasher.group(txidRaw, group);
    const rec = Buffer.concat(parts); batch.push(rec); batchLen += rec.length; written += group.length;
    if (batchLen >= (4 << 20)) { await write(Buffer.concat(batch)); batch = []; batchLen = 0; if (written % 2_000_000 < group.length) log(`  wrote ${written.toLocaleString()} coins, ${((performance.now() - t0) / 1000).toFixed(1)} s`); }
  }
  if (batch.length) await write(Buffer.concat(batch));
  await new Promise((r) => out.end(r));
  if (written !== coins) throw new Error(`wrote ${written} coins, expected ${coins}`);
  return { coins: written, bytes, hashSerialized: hasher.digest(), sha256: fileHash.digest('hex'), ms: performance.now() - t0 };
}
