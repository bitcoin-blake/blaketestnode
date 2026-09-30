// The address index: which unspent coins pay a script, so an address query is a lookup and not a
// walk over 14M coins. Opt-in (`run --address-index`), because it costs memory the node does not
// otherwise need.
//   snapshot coins: one u64 per packed entry, high word FNV-1a 32 of the scriptPubKey, low word
//   the entry number, sorted; ~114 MB for 14.2M coins, beside the file as <snapshot>.sidx.
//   later coins: a side map from script to outpoints, kept current by following set/delete.
// A hash match is only a candidate: every hit is read back from the set and its script compared,
// and a spent entry is skipped through the set's own bitmap, so the index never needs a rebuild
// after a block or a rollback. Uint8Array throughout, as packed.mjs: the same code runs in a worker.
import { parseSnapshot } from './snapshot.mjs';
import { hexToBytes, bytesToHex, putU32le, u32le, equalBytes } from './bytes.mjs';

const SIDX_MAGIC = new TextEncoder().encode('sidx0001');
export const SIDX_HEAD = 48; // magic 8, count 4, pad 4, snapshot file sha256 32
if (new Uint8Array(Uint32Array.of(1).buffer)[0] !== 1) throw new Error('the address index assumes a little-endian host');

export function fnv1a(b) { let h = 0x811c9dc5; for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; }

// One pass over the snapshot file, in the same order as the packed index's entries.
export function buildScriptKeys(source, count, { log } = {}) {
  const keys = new BigUint64Array(count), w = new Uint32Array(keys.buffer);
  let n = 0;
  parseSnapshot(source, { hash: false, log, onCoin: (_t, _v, _vo, _g, coin) => { w[2 * n] = n; w[2 * n + 1] = fnv1a(coin.script); n++; } });
  if (n !== count) throw new Error(`address index: ${n} coins in the file, ${count} in the packed index`);
  return keys.sort();
}

export function scriptIndexBytes(keys, fileSha256) {
  const out = new Uint8Array(SIDX_HEAD + keys.length * 8);
  out.set(SIDX_MAGIC, 0); putU32le(out, 8, keys.length); out.set(hexToBytes(fileSha256), 16);
  out.set(new Uint8Array(keys.buffer, keys.byteOffset, keys.length * 8), SIDX_HEAD);
  return out;
}
export function parseScriptIndexBytes(b, fileSha256) {
  if (!equalBytes(b.subarray(0, 8), SIDX_MAGIC)) throw new Error('not an address index');
  if (bytesToHex(b.subarray(16, 48)) !== fileSha256) throw new Error('address index is for another snapshot');
  const count = u32le(b, 8), keys = new BigUint64Array(count); // copied: the file's bytes need not be 8-aligned
  new Uint8Array(keys.buffer).set(b.subarray(SIDX_HEAD, SIDX_HEAD + count * 8));
  return keys;
}

export class ScriptIndex {
  // utxo: a PackedUtxo (with keys from buildScriptKeys over its file) or a plain Map (keys null)
  constructor(utxo, keys = null) {
    this.utxo = utxo; this.keys = keys; this.w = keys ? new Uint32Array(keys.buffer, keys.byteOffset, keys.length * 2) : null;
    this.byScript = new Map(); this.scriptOf = new Map();
  }
  get size() { return (this.keys?.length ?? 0) + this.scriptOf.size; }
  add(key, script) { this.scriptOf.set(key, script); (this.byScript.get(script) ?? this.byScript.set(script, new Set()).get(script)).add(key); }
  drop(key) { const s = this.scriptOf.get(key); if (s === undefined) return; this.scriptOf.delete(key); const set = this.byScript.get(s); set.delete(key); if (!set.size) this.byScript.delete(s); }
  // every unspent coin paying `script` (hex): [{ key, coin }]
  coins(script) {
    script = script.toLowerCase(); const out = [];
    if (this.w) {
      const h = fnv1a(hexToBytes(script)), w = this.w, n = this.keys.length;
      let lo = 0, hi = n;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (w[2 * mid + 1] < h) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < n && w[2 * i + 1] === h; i++) { const e = this.utxo.entry(w[2 * i]); if (e && e.coin.output.scriptPubKey === script) out.push(e); }
    }
    for (const key of this.byScript.get(script) ?? []) { const coin = this.utxo.get(key); if (coin) out.push({ key, coin }); }
    return out;
  }
}

// Keep the side map current: every coin the set gains (a block, a delta, a rollback's restore) is
// recorded under its script, and forgotten when it goes. Call before any delta is replayed.
export function followSet(utxo, index) {
  for (const [key, coin] of utxo instanceof Map ? utxo : utxo.fresh) index.add(key, coin.output.scriptPubKey);
  const set = utxo.set.bind(utxo), del = utxo.delete.bind(utxo);
  utxo.set = (key, coin) => { index.add(key, coin.output.scriptPubKey); return set(key, coin); };
  utxo.delete = (key) => { index.drop(key); return del(key); };
  return index;
}
