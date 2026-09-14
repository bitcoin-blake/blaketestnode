// The chain state machine: headers, the applied chain of hashes, the UTXO set, and undo
// records for the last blocks so a reorg is a pop, not a reload.
const keyOf = (p) => `${p.txid}:${p.vout}`;

export class ChainNode {
  constructor({ k, utxo, epochStart, undoDepth = 100, log = () => {} }) {
    Object.assign(this, { k, utxo, epochStart, undoDepth, log });
    this.headers = []; this.chain = []; this.undo = []; this.height = -1;
    this.stats = { blocks: 0, txs: 0, validateMs: 0, applyMs: 0, failed: 0, skipped: {} };
  }
  loadContext(contextHeaders) { contextHeaders.forEach((h, i) => { this.headers[this.epochStart + i] = h; this.chain[this.epochStart + i] = this.k.codec.blockHash(h); }); }
  setBase(height, hash) { this.height = height; this.chain[height] = hash; }
  tipHash() { return this.chain[this.height]; }
  mtp(h) { return this.k.headers.medianTimePast(this.headers.slice(h - 11, h)); }

  // validate and apply block `h` (must be height+1); throws on any failed rule
  applyNext(h, hex) {
    if (h !== this.height + 1) throw new Error(`apply ${h} at height ${this.height}`);
    const { k, utxo } = this;
    let t = performance.now();
    const block = k.codec.decode('Block', hex);
    const hash = k.codec.blockHash(block.header);
    if (block.header.prevBlockHash !== this.chain[h - 1]) throw new Error(`block ${h} does not link to ${this.chain[h - 1]}`);
    const [hv] = k.headers.validateChain([block.header], { startHeight: h, prevContext: this.headers.slice(this.epochStart, h), now: Math.floor(Date.now() / 1000) + 7200 });
    if (!hv.ok) throw new Error(`header ${h} failed: ${hv.results.filter((r) => r.ok === false).map((r) => r.rule).join(', ')}`);
    const s = k.blocks.validateBlockStructure(block);
    const c = k.blocks.validateBlockContext(block, { height: h, utxo, mtp: this.mtp(h) });
    for (const r of [...s.results, ...c.results]) if (r.ok === null) this.stats.skipped[r.rule] = (this.stats.skipped[r.rule] ?? 0) + 1;
    if (!s.ok || !c.ok) { this.stats.failed++; throw new Error(`block ${h} failed: ${[...s.results, ...c.results].filter((r) => r.ok === false).map((r) => r.rule).join(', ')}`); }
    this.stats.validateMs += performance.now() - t;
    t = performance.now();
    const spent = [];
    block.transactions.forEach((tx, i) => { if (i > 0) for (const inp of tx.inputs) { const key = keyOf(inp.prevout); const coin = utxo.get(key); if (coin) spent.push([key, coin]); } });
    const created = [];
    block.transactions.forEach((tx) => { const txid = k.codec.txid(tx); tx.outputs.forEach((o, vout) => { if (!o.scriptPubKey.startsWith('6a')) created.push(`${txid}:${vout}`); }); });
    k.blocks.applyBlock(utxo, block, h);
    this.undo.push({ height: h, hash, spent, created });
    if (this.undo.length > this.undoDepth) this.undo.shift();
    this.headers[h] = block.header; this.chain[h] = hash; this.height = h;
    this.stats.blocks++; this.stats.txs += block.transactions.length; this.stats.applyMs += performance.now() - t;
    return { hash, txs: block.transactions.length, time: block.header.time };
  }

  // pop blocks back to `to`; throws if the undo records do not reach that far
  rollbackTo(to) {
    while (this.height > to) {
      const u = this.undo.pop();
      if (!u || u.height !== this.height) throw new Error(`reorg deeper than undo (${this.undoDepth} blocks)`);
      for (const key of u.created) this.utxo.delete(key);
      for (const [key, coin] of u.spent) this.utxo.set(key, coin);
      delete this.headers[this.height]; delete this.chain[this.height];
      this.height--;
      this.log(`rolled back ${u.height} ${u.hash.slice(0, 16)}`);
    }
  }
}
