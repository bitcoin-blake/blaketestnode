// The packed UTXO index: one 16-byte entry per snapshot coin, in file order (the snapshot is
// sorted by raw txid, then vout), so lookups are a binary search on an 8-byte txid prefix
// followed by a check of the full txid in the file. No sort, no strings, ~230 MB for 14M coins.
//   entry: [txid raw bytes 0..8][u32 offset of the vout varint][u32 offset of the txid group]
// Spent coins are a bitmap over entries; coins created after the snapshot live in a side map.
// Uint8Array throughout: the same code runs in Node (fd) and in a worker (OPFS).
import { readCoin, readCompactSize } from './varint.mjs';
import { parseSnapshot, readHeader, HEADER_BYTES } from './snapshot.mjs';
import { hexToBytes, bytesToHex, reverse, u32le, putU32le, compareBytes, equalBytes, concat } from './bytes.mjs';

export const ENTRY = 16, HEAD = 80; // magic 8, count 4, base hash 32, file sha256 32, pad 4
const IDX_MAGIC = new TextEncoder().encode('utxoidx1');

// One pass: verify the file's hash_serialized_3 and build the index.
export function buildIndex(source, { hash = true, hasher, log } = {}) {
  const head = readHeader(source.read(0, HEADER_BYTES));
  const entries = new Uint8Array(head.coins * ENTRY);
  let n = 0;
  const r = parseSnapshot(source, { hash, hasher, log, onCoin: (txidRaw, vout, voutOff, groupOff) => {
    entries.set(txidRaw.subarray(0, 8), n * ENTRY); putU32le(entries, n * ENTRY + 8, voutOff); putU32le(entries, n * ENTRY + 12, groupOff); n++;
  } });
  return { ...r, entries, count: n };
}

export function indexBytes({ entries, count, baseHash }, fileSha256) {
  const h = new Uint8Array(HEAD); h.set(IDX_MAGIC, 0); putU32le(h, 8, count); h.set(hexToBytes(baseHash), 12); h.set(hexToBytes(fileSha256), 44);
  return concat(h, entries);
}
export function parseIndexBytes(b, fileSha256) {
  if (!equalBytes(b.subarray(0, 8), IDX_MAGIC)) throw new Error('not an index');
  if (bytesToHex(b.subarray(44, 76)) !== fileSha256) throw new Error('index is for another snapshot');
  return { count: u32le(b, 8), baseHash: bytesToHex(b.subarray(12, 44)), entries: b.subarray(HEAD) };
}

export class PackedUtxo {
  constructor(file, index) {
    this.file = file; this.entries = index.entries; this.count = index.count;
    this.spent = new Uint8Array((this.count + 7) >> 3); this.spentCount = 0;
    this.fresh = new Map();
  }
  get size() { return this.count - this.spentCount + this.fresh.size; }
  #isSpent(i) { return (this.spent[i >> 3] >> (i & 7)) & 1; }
  #voutOff(i) { return u32le(this.entries, i * ENTRY + 8); }
  #groupOff(i) { return u32le(this.entries, i * ENTRY + 12); }
  // index of the coin `txid:vout`, or -1
  find(txidHex, vout) {
    const raw = reverse(hexToBytes(txidHex));
    let lo = 0, hi = this.count - 1, first = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; const c = compareBytes(this.entries, mid * ENTRY, raw, 0, 8); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else { first = mid; hi = mid - 1; } }
    if (first < 0) return -1;
    for (let i = first; i < this.count && compareBytes(this.entries, i * ENTRY, raw, 0, 8) === 0; i++) {
      if (!equalBytes(this.file.read(this.#groupOff(i), 32), raw)) continue;
      const [v] = readCompactSize(this.file.read(this.#voutOff(i), 9), 0);
      if (v === vout) return i;
    }
    return -1;
  }
  #coinAt(i, txid, vout) {
    const bytes = this.file.read(this.#voutOff(i), 9 + 10 + 10 + 10005);
    const [, p] = readCompactSize(bytes, 0); const [c] = readCoin(bytes, p);
    return { outpoint: { txid, vout }, output: { value: c.value, scriptPubKey: bytesToHex(c.script) }, height: c.height, coinbase: c.coinbase };
  }
  #lookup(key) { const i = key.indexOf(':'); const idx = this.find(key.slice(0, i), Number(key.slice(i + 1))); return idx >= 0 && !this.#isSpent(idx) ? idx : -1; }
  has(key) { return this.fresh.has(key) || this.#lookup(key) >= 0; }
  get(key) {
    const f = this.fresh.get(key); if (f) return f;
    const idx = this.#lookup(key); if (idx < 0) return undefined;
    const i = key.indexOf(':'); return this.#coinAt(idx, key.slice(0, i), Number(key.slice(i + 1)));
  }
  set(key, coin) { this.fresh.set(key, coin); }
  delete(key) {
    if (this.fresh.delete(key)) return true;
    const idx = this.#lookup(key); if (idx < 0) return false;
    this.spent[idx >> 3] |= 1 << (idx & 7); this.spentCount++; return true;
  }
  // undo: a spent snapshot coin comes back by clearing its bit
  unspend(key) { const i = key.indexOf(':'); const idx = this.find(key.slice(0, i), Number(key.slice(i + 1))); if (idx >= 0 && this.#isSpent(idx)) { this.spent[idx >> 3] &= ~(1 << (idx & 7)); this.spentCount--; return true; } return false; }
  // cursor-order iteration for writing a full snapshot: [txidHex, [[vout, coin, rawCoinBytes]...]]
  *groups() {
    const freshGroups = new Map();
    for (const [key, c] of this.fresh) { const i = key.indexOf(':'); const t = key.slice(0, i); (freshGroups.get(t) ?? freshGroups.set(t, []).get(t)).push([Number(key.slice(i + 1)), { height: c.height, coinbase: c.coinbase, value: c.output.value, script: hexToBytes(c.output.scriptPubKey) }, null]); }
    const rawHex = (t) => bytesToHex(reverse(hexToBytes(t)));
    const fresh = [...freshGroups].map(([t, g]) => [rawHex(t), t, g.sort((a, b) => a[0] - b[0])]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let fi = 0, i = 0;
    while (i < this.count) {
      const group = this.#groupOff(i);
      const txidRaw = this.file.read(group, 32); const rawHexT = bytesToHex(txidRaw);
      while (fi < fresh.length && fresh[fi][0] < rawHexT) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
      const coins = [];
      for (; i < this.count && this.#groupOff(i) === group; i++) {
        if (this.#isSpent(i)) continue;
        const bytes = this.file.read(this.#voutOff(i), 9 + 10 + 10 + 10005);
        const [vout, p] = readCompactSize(bytes, 0); const [coin, end] = readCoin(bytes, p);
        coins.push([vout, coin, Uint8Array.from(bytes.subarray(p, end))]);
      }
      if (coins.length) yield [bytesToHex(reverse(txidRaw)), coins];
    }
    while (fi < fresh.length) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
  }
}
