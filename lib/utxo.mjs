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

  // Every coin grouped by txid in Core's cursor order (raw txid bytes ascending): the
  // snapshot groups come out in their stored order (the index keeps insertion order and
  // new coins never share a txid with them), fresh groups are sorted and merged in.
  // Yields [txidHex, [[vout, coin, rawCoinBytes|null], ...]].
  *groups() {
    const freshGroups = new Map();
    for (const [key, c] of this.fresh) {
      const i = key.indexOf(':'); const txid = key.slice(0, i);
      if (!freshGroups.has(txid)) freshGroups.set(txid, []);
      freshGroups.get(txid).push([Number(key.slice(i + 1)), { height: c.height, coinbase: c.coinbase, value: c.output.value, script: Buffer.from(c.output.scriptPubKey, 'hex') }, null]);
    }
    const rawHex = (txid) => Buffer.from(txid, 'hex').reverse().toString('hex');
    const fresh = [...freshGroups].map(([txid, g]) => [rawHex(txid), txid, g.sort((a, b) => a[0] - b[0])]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    let fi = 0;
    let curTxid = null, curRaw = null, group = [];
    const flush = function* (self) {
      if (!curTxid) return;
      while (fi < fresh.length && fresh[fi][0] < curRaw) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
      yield [curTxid, group];
    };
    for (const [key, off] of this.index) {
      const i = key.indexOf(':'); const txid = key.slice(0, i);
      if (txid !== curTxid) { yield* flush(this); curTxid = txid; curRaw = rawHex(txid); group = []; }
      const [coin, end] = readCoin(this.buf, off);
      group.push([Number(key.slice(i + 1)), coin, this.buf.subarray(off, end)]);
    }
    yield* flush(this);
    while (fi < fresh.length) { yield [fresh[fi][1], fresh[fi][2]]; fi++; }
  }
}
