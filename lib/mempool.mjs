// A mempool for a web node (datstr SPEC 6.3): transactions arrive from relays as kind 23404
// events, one transaction each, and are real to this node only after it has validated them
// against its own UTXO set: structure, inputs unspent and mature, value, scripts, a fee floor.
// A publisher that lies is a peer that lies. Nothing about ordering or the coinbase travels.
import { nostrModule } from './nip333.mjs';
export const MEMPOOL_KIND = 23404;
const keyOf = (p) => `${p.txid}:${p.vout}`;

export class Mempool {
  // { k, node, network, minFeeRate = 1, maxCount = 5000, log }
  constructor({ k, node, network, minFeeRate = 1, maxCount = 5000, log = () => {} }) {
    Object.assign(this, { k, node, network, minFeeRate, maxCount, log });
    this.txs = new Map(); this.spent = new Set(); this.stats = { seen: 0, accepted: 0, refused: 0, dropped: 0 };
  }
  get size() { return this.txs.size; }
  // validate one transaction hex against the node's state; returns { ok, txid, fee, vsize } or { ok: false, txid, error }
  check(hex) {
    const { k, node } = this; let tx, txid;
    try { tx = k.codec.decode('Transaction', hex); txid = k.codec.txid(tx); } catch (e) { return { ok: false, error: `not a transaction: ${e.message}` }; }
    if (this.txs.has(txid)) return { ok: true, txid, dup: true };
    const s = k.blocks.validateTransaction(tx, false); if (!s.ok) return { ok: false, txid, error: s.results.filter((r) => r.ok === false).map((r) => r.rule).join(', ') };
    const prevouts = []; let inSum = 0; const height = node.height + 1;
    for (const i of tx.inputs) {
      const key = keyOf(i.prevout); if (this.spent.has(key)) return { ok: false, txid, error: `input ${key} is spent by a mempool transaction` };
      const c = node.utxo.get(key); if (!c) return { ok: false, txid, error: `input ${key} is not an unspent coin` };
      if (c.coinbase && height - c.height < (k.params.coinbaseMaturity ?? 100)) return { ok: false, txid, error: `input ${key} is an immature coinbase` };
      prevouts.push(c.output); inSum += c.output.value;
    }
    const outSum = tx.outputs.reduce((a, o) => a + o.value, 0); if (outSum > inSum) return { ok: false, txid, error: 'outputs exceed inputs' };
    const vsize = Math.ceil(k.codec.txWeight(tx) / 4); const fee = inSum - outSum; if (fee < Math.ceil(vsize * this.minFeeRate)) return { ok: false, txid, error: `fee ${fee} below ${this.minFeeRate} sat/vB for ${vsize} vB` };
    const usp = k.params.unifiedSighashParam; const unifiedSighash = !!usp && height >= k.params[usp];
    for (let i = 0; i < tx.inputs.length; i++) { const v = k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash }); if (v.ok !== true) return { ok: false, txid, error: `input ${i}: ${v.error ?? v.reason ?? 'script failed'}` }; }
    return { ok: true, txid, tx, fee, vsize, feeRate: fee / vsize };
  }
  // accept a transaction hex: validated, then held with its inputs reserved
  add(hex, from = '') {
    this.stats.seen++; const r = this.check(hex);
    if (!r.ok) { this.stats.refused++; this.log(`mempool: refused ${r.txid ? r.txid.slice(0, 12) + '…' : 'a transaction'}${from ? ' from ' + from : ''}: ${r.error}`); return r; }
    if (r.dup) return r;
    if (this.txs.size >= this.maxCount) { const worst = [...this.txs.entries()].sort((a, b) => a[1].feeRate - b[1].feeRate)[0]; if (worst && worst[1].feeRate >= r.feeRate) return { ok: false, txid: r.txid, error: 'mempool full' }; this.drop(worst[0]); }
    this.txs.set(r.txid, { hex, tx: r.tx, fee: r.fee, vsize: r.vsize, feeRate: r.feeRate, at: Math.floor(Date.now() / 1000) }); for (const i of r.tx.inputs) this.spent.add(keyOf(i.prevout));
    this.stats.accepted++; return r;
  }
  drop(txid) { const e = this.txs.get(txid); if (!e) return; this.txs.delete(txid); for (const i of e.tx.inputs) this.spent.delete(keyOf(i.prevout)); this.stats.dropped++; }
  // after a block: drop what it confirmed or conflicted with, then re-check the rest against the new state
  afterBlock() { for (const [txid, e] of [...this.txs]) { const c = this.check(e.hex); if (!c.ok || (c.dup && !this.txs.has(txid))) { this.drop(txid); continue; } if (e.tx.inputs.some((i) => !this.node.utxo.get(keyOf(i.prevout)))) this.drop(txid); } }
  // what a block builder wants: by fee rate, highest first
  list() { return [...this.txs.entries()].map(([txid, e]) => ({ txid, ...e })).sort((a, b) => b.feeRate - a.feeRate); }
}

// follow relays for kind 23404 events for this chain; a publisher allowlist is optional
export async function subscribeMempool(mempool, { relays, network, publishers = null, nostr = null, log = () => {} }) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const seen = new Set(); const sockets = new Map(); let closed = false;
  const open = (url, backoff = 1000) => {
    if (closed) return; let ws;
    try { ws = new WebSocket(url); } catch { return setTimeout(() => open(url, Math.min(backoff * 2, 60000)), backoff); }
    sockets.set(url, ws);
    ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify(['REQ', 'mp', { kinds: [MEMPOOL_KIND], since: Math.floor(Date.now() / 1000) - 600, ...(publishers ? { authors: publishers } : {}) }])); log(`mempool: following kind ${MEMPOOL_KIND} on ${url}`); };
    ws.onmessage = async (m) => {
      let msg; try { const d = m.data; msg = JSON.parse(typeof d === 'string' ? d : d instanceof ArrayBuffer ? new TextDecoder().decode(d) : typeof d?.text === 'function' ? await d.text() : String(d)); } catch { return; } // text, or a binary frame from a plain relay
      if (msg[0] !== 'EVENT' || !msg[2]) return; const ev = msg[2];
      if (ev.kind !== MEMPOOL_KIND || seen.has(ev.id)) return; if (!ev.tags?.some((t) => t[0] === 'chain' && t[1] === network)) return;
      if (publishers && !publishers.includes(ev.pubkey)) return; if (!verifyNostrEvent(ev)) return;
      seen.add(ev.id); if (seen.size > 20000) seen.delete(seen.values().next().value);
      mempool.add(String(ev.content).trim().toLowerCase(), `${ev.pubkey.slice(0, 8)}… via ${url.replace('wss://', '')}`);
    };
    ws.onerror = () => {}; ws.onclose = () => { sockets.delete(url); if (!closed) setTimeout(() => open(url, Math.min(backoff * 2, 60000)), backoff); };
  };
  relays.forEach((u) => open(u));
  return { close() { closed = true; for (const ws of sockets.values()) { try { ws.close(); } catch {} } } };
}
