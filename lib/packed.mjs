// The packed UTXO index: one 16-byte entry per snapshot coin, in file order (the snapshot is
// sorted by raw txid, then vout), so lookups are a binary search on an 8-byte txid prefix
// followed by a check of the full txid in the file. No sort, no strings, ~230 MB for 14M coins.
//   entry: [txid raw bytes 0..8][u32 offset of the vout varint][u32 offset of the txid group]
// Spent coins are a bitmap over entries; coins created after the snapshot live in a side map.
import { openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { readCoin, readCompactSize } from './varint.mjs';
import { readHeader } from './snapshot.mjs';

export const ENTRY = 16, IDX_MAGIC = Buffer.from('utxoidx1'), HEAD = 80; // magic 8, count 4, base hash 32, file sha256 32, pad 4

// Random access to the snapshot without holding it in memory.
export class FileBytes {
  constructor(path) { this.fd = openSync(path, 'r'); this.size = fstatSync(this.fd).size; }
  read(off, len) { const b = Buffer.alloc(len); const n = readSync(this.fd, b, 0, len, off); return n === len ? b : b.subarray(0, n); }
  close() { closeSync(this.fd); }
}

// Build the index by walking the file once (the walk that verifies the hash can call onCoin).
export function buildIndex(buf) {
  const head = readHeader(buf);
  const entries = Buffer.alloc(head.coins * ENTRY);
  let pos = head.dataStart, n = 0;
  while (n < head.coins) {
    const group = pos; pos += 32;
    let count; [count, pos] = readCompactSize(buf, pos);
    for (let i = 0; i < count; i++) {
      const voutOff = pos; let vout; [vout, pos] = readCompactSize(buf, pos);
      const [, end] = readCoin(buf, pos); pos = end;
      buf.copy(entries, n * ENTRY, group, group + 8); entries.writeUInt32LE(voutOff, n * ENTRY + 8); entries.writeUInt32LE(group, n * ENTRY + 12);
      n++;
    }
  }
  return { entries, count: n, head };
}
export function writeIndex(path, { entries, count, head }, fileSha256) {
  const h = Buffer.alloc(HEAD); IDX_MAGIC.copy(h, 0); h.writeUInt32LE(count, 8); Buffer.from(head.baseHash, 'hex').copy(h, 12); Buffer.from(fileSha256, 'hex').copy(h, 44);
  writeFileSync(path, Buffer.concat([h, entries]));
}
export function readIndex(path, fileSha256) {
  const b = readFileSync(path);
  if (!b.subarray(0, 8).equals(IDX_MAGIC)) throw new Error('not an index');
  if (b.subarray(44, 76).toString('hex') !== fileSha256) throw new Error('index is for another snapshot');
  return { count: b.readUInt32LE(8), baseHash: b.subarray(12, 44).toString('hex'), entries: b.subarray(HEAD) };
}

export class PackedUtxo {
  constructor(file, index) {
    this.file = file; this.entries = index.entries; this.count = index.count;
    this.spent = new Uint8Array((this.count + 7) >> 3); this.spentCount = 0;
    this.fresh = new Map(); this.freshSpent = 0;
  }
  get size() { return this.count - this.spentCount + this.fresh.size; }
  #isSpent(i) { return (this.spent[i >> 3] >> (i & 7)) & 1; }
  #cmpPrefix(i, raw8) { return this.entries.compare(raw8, 0, 8, i * ENTRY, i * ENTRY + 8); } // entry vs raw8: <0 means the entry sorts before the key
  // index of the coin `txid:vout`, or -1
  find(txidHex, vout) {
    const raw = Buffer.from(txidHex, 'hex').reverse(); const raw8 = raw.subarray(0, 8);
    let lo = 0, hi = this.count - 1, first = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const c = this.#cmpPrefix(mid, raw8); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else { first = mid; hi = mid - 1; } }
    if (first < 0) return -1;
    for (let i = first; i < this.count && this.#cmpPrefix(i, raw8) === 0; i++) {
      const group = this.entries.readUInt32LE(i * ENTRY + 12);
      if (!this.file.read(group, 32).equals(raw)) continue;
      const voutOff = this.entries.readUInt32LE(i * ENTRY + 8);
      const [v] = readCompactSize(this.file.read(voutOff, 9), 0);
      if (v === vout) return i;
    }
    return -1;
  }
  #coinAt(i, txid, vout) {
    const voutOff = this.entries.readUInt32LE(i * ENTRY + 8);
    const bytes = this.file.read(voutOff, 9 + 10 + 10 + 10005); // vout, code, amount, script (compactsize + ≤10000 bytes)
    const [, p] = readCompactSize(bytes, 0); const [c] = readCoin(bytes, p);
    return { outpoint: { txid, vout }, output: { value: c.value, scriptPubKey: c.script.toString('hex') }, height: c.height, coinbase: c.coinbase };
  }
  has(key) { return this.fresh.has(key) || this.#lookup(key) >= 0; }
  #lookup(key) { const i = key.indexOf(':'); const idx = this.find(key.slice(0, i), Number(key.slice(i + 1))); return idx >= 0 && !this.#isSpent(idx) ? idx : -1; }
  get(key) {
    const f = this.fresh.get(key); if (f) return f;
    const idx = this.#lookup(key); if (idx < 0) return undefined;
    const i = key.indexOf(':'); return this.#coinAt(idx, key.slice(0, i), Number(key.slice(i + 1)));
  }
  set(key, coin) { this.fresh.set(key, coin); }
  delete(key) {
    if (this.fresh.delete(key)) return true;
    const idx = this.#lookup(key); if (idx < 0) return false;
    this.spent[idx >> 3] |= 1 << (idx & 7); this.spentCount++; this.spentIdx?.push(idx); return true;
  }
  // undo support: unspend an index entry (the node's rollback re-sets the coin; for packed coins that means clearing the bit)
  unspend(key) { const i = key.indexOf(':'); const idx = this.find(key.slice(0, i), Number(key.slice(i + 1))); if (idx >= 0 && this.#isSpent(idx)) { this.spent[idx >> 3] &= ~(1 << (idx & 7)); this.spentCount--; return true; } return false; }
  // cursor-order iteration for writing a full snapshot: [txidHex, [[vout, coin, rawCoinBytes]...]]
  *groups() {
    const freshGroups = new Map();
    for (const [key, c] of this.fresh) { const i = key.indexOf(':'); const t = key.slice(0, i); (freshGroups.get(t) ?? freshGroups.set(t, []).get(t)).push([Number(key.slice(i + 1)), { height: c.height, coinbase: c.coinbase, value: c.output.value, script: Buffer.from(c.output.scriptPubKey, 'hex') }, null]); }
    const rawHex = (t) => Buffer.from(t, 'hex').reverse().toString('hex');
    const fresh = [...freshGroups].map(([t, g]) => [rawHex(t), t, g.sort((a, b) => a[0] - b[0])]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let fi = 0, i = 0;
    while (i < this.count) {
      const group = this.entries.readUInt32LE(i * ENTRY + 12);
      const txidRaw = this.file.read(group, 32); const rawHexT = txidRaw.toString('hex');
      while (fi < fresh.length && fresh[fi][0] < rawHexT) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
      const coins = [];
      for (; i < this.count && this.entries.readUInt32LE(i * ENTRY + 12) === group; i++) {
        if (this.#isSpent(i)) continue;
        const voutOff = this.entries.readUInt32LE(i * ENTRY + 8);
        const bytes = this.file.read(voutOff, 9 + 10 + 10 + 10005);
        const [vout, p] = readCompactSize(bytes, 0); const [coin, end] = readCoin(bytes, p);
        coins.push([vout, coin, Buffer.from(bytes.subarray(p, end))]);
      }
      if (coins.length) yield [Buffer.from(txidRaw).reverse().toString('hex'), coins];
    }
    while (fi < fresh.length) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
  }
}
