// UTXO set for the block engine: get/set/delete/has/size keyed "txid:vout",
// values shaped {outpoint, output:{value, scriptPubKey}, height, coinbase}.
// Snapshot coins stay as byte offsets into the snapshot buffer and decode on
// read; coins created after the snapshot live in an ordinary Map.
import { readCoin } from './varint.mjs';

export class UtxoSet {
  constructor(buf) { this.buf = buf; this.index = new Map(); this.fresh = new Map(); }
  addSnapshotCoin(txid, vout, offset) { this.index.set(`${txid}:${vout}`, offset); }
  get size() { return this.index.size + this.fresh.size; }
  has(key) { return this.fresh.has(key) || this.index.has(key); }
  get(key) {
    const f = this.fresh.get(key); if (f) return f;
    const off = this.index.get(key); if (off === undefined) return undefined;
    const [c] = readCoin(this.buf, off);
    const i = key.indexOf(':');
    return { outpoint: { txid: key.slice(0, i), vout: Number(key.slice(i + 1)) }, output: { value: c.value, scriptPubKey: c.script.toString('hex') }, height: c.height, coinbase: c.coinbase };
  }
  set(key, coin) { this.fresh.set(key, coin); }
  delete(key) { return this.fresh.delete(key) || this.index.delete(key); }
}
