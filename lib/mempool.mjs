// A mempool for a web node (datstr SPEC 6.3): transactions arrive from relays as kind 23404
// events, one transaction each, and are real to this node only after it has validated them
// against its own UTXO set: structure, inputs unspent and mature, value, scripts, a fee floor.
// A publisher that lies is a peer that lies. Nothing about ordering or the coinbase travels.
import { nostrModule } from './nip333.mjs';
export const MEMPOOL_KIND = 23404;
const keyOf = (p) => `${p.txid}:${p.vout}`;

export class Mempool {
  // { k, node, network, minFeeRate = 1, maxCount = 5000, log }
  constructor({ k, node, network, minFeeRate = 1, maxCount = 5000, log = () => {}, onChange = null, onRefuse = null }) {
    Object.assign(this, { k, node, network, minFeeRate, maxCount, log, onChange, onRefuse });
    this.txs = new Map(); this.spent = new Set(); this.stats = { seen: 0, accepted: 0, refused: 0, dropped: 0 };
  }
  get size() { return this.txs.size; }
  // validate one transaction hex against the node's state; returns { ok, txid, fee, vsize } or { ok: false, txid, error }
  check(hex) {
    const { k, node } = this; let tx, txid;
    try { tx = k.codec.decode('Transaction', hex); txid = k.codec.txid(tx); } catch (e) { return { ok: false, error: `not a transaction: ${e.message}` }; }
    if (this.txs.has(txid)) return { ok: true, txid, dup: true };
    const s = k.blocks.validateTransaction(tx, false); if (!s.ok) return { ok: false, txid, tx, error: s.results.filter((r) => r.ok === false).map((r) => r.rule).join(', ') };
    const prevouts = []; let inSum = 0; const height = node.height + 1; const conflicts = new Set();
    for (const i of tx.inputs) {
      const key = keyOf(i.prevout); if (this.spent.has(key)) { const other = [...this.txs.entries()].find(([, e]) => e.tx.inputs.some((x) => keyOf(x.prevout) === key)); if (other) conflicts.add(other[0]); }
      const c = node.utxo.get(key); if (!c) return { ok: false, txid, tx, error: `input ${key} is not an unspent coin` };
      if (c.coinbase && height - c.height < (k.params.coinbaseMaturity ?? 100)) return { ok: false, txid, error: `input ${key} is an immature coinbase` };
      prevouts.push(c.output); inSum += c.output.value;
    }
    const outSum = tx.outputs.reduce((a, o) => a + o.value, 0); if (outSum > inSum) return { ok: false, txid, error: 'outputs exceed inputs' };
    const vsize = Math.ceil(k.codec.txWeight(tx) / 4); const fee = inSum - outSum; if (fee < Math.ceil(vsize * this.minFeeRate)) return { ok: false, txid, tx, error: `fee ${fee} below ${this.minFeeRate} sat/vB for ${vsize} vB` };
    // a replacement (BIP 125): every transaction it conflicts with signalled replaceability, and it pays more in total and per vB, by at least the relay fee on its own size
    if (conflicts.size) { const olds = [...conflicts].map((t) => this.txs.get(t)); if (!olds.every((e) => e.tx.inputs.some((x) => x.sequence < 0xfffffffe))) return { ok: false, txid, tx, error: 'conflicts with a mempool transaction that did not signal replacement' };
      const oldFee = olds.reduce((a, e) => a + e.fee, 0); if (fee < oldFee + Math.ceil(vsize * this.minFeeRate)) return { ok: false, txid, tx, error: `a replacement must pay at least ${oldFee + Math.ceil(vsize * this.minFeeRate)} sat, not ${fee}` }; if (olds.some((e) => fee / vsize <= e.feeRate)) return { ok: false, txid, tx, error: 'a replacement must pay a higher fee rate than what it replaces' }; }
    const usp = k.params.unifiedSighashParam; const unifiedSighash = !!usp && height >= k.params[usp];
    for (let i = 0; i < tx.inputs.length; i++) { const v = k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash }); if (v.ok !== true) return { ok: false, txid, tx, error: `input ${i}: ${v.error ?? v.reason ?? 'script failed'}` }; }
    return { ok: true, txid, tx, fee, vsize, feeRate: fee / vsize, replaces: [...conflicts] };
  }
  // accept a transaction hex: validated, then held with its inputs reserved. via: how it arrived ('feed', a node's own mempool
  // published as kind 23404; 'relay', a payment event a wallet published, 23503; 'seed', the mirror's file). Only a feed entry
  // says a node has the transaction; a relay echo says only that a relay carried it
  add(hex, from = '', via = '') {
    this.stats.seen++; if (via === 'feed') this.lastFeedAt = Date.now(); const r = this.check(hex);
    if (!r.ok) { this.stats.refused++; try { this.onRefuse?.({ ...r, hex }, r.tx); } catch {} this.log(`mempool: refused ${r.txid ? r.txid.slice(0, 12) + '…' : 'a transaction'}${from ? ' from ' + from : ''}: ${r.error}`); return r; }
    if (r.dup) { const e = this.txs.get(r.txid); if (e && via === 'feed' && !e.fed) { e.fed = true; this.onChange?.('fed', r.txid); } return r; }
    for (const t of r.replaces ?? []) { this.drop(t); this.log(`mempool: ${t.slice(0, 12)}… replaced by ${r.txid.slice(0, 12)}…`); }
    if (this.txs.size >= this.maxCount) { const worst = [...this.txs.entries()].sort((a, b) => a[1].feeRate - b[1].feeRate)[0]; if (worst && worst[1].feeRate >= r.feeRate) return { ok: false, txid: r.txid, error: 'mempool full' }; this.drop(worst[0]); }
    this.txs.set(r.txid, { hex, tx: r.tx, fee: r.fee, vsize: r.vsize, feeRate: r.feeRate, at: Math.floor(Date.now() / 1000), via, fed: via === 'feed' || via === 'seed' }); for (const i of r.tx.inputs) this.spent.add(keyOf(i.prevout));
    this.stats.accepted++; this.onChange?.('add', r.txid); return r;
  }
  drop(txid) { const e = this.txs.get(txid); if (!e) return; this.txs.delete(txid); for (const i of e.tx.inputs) this.spent.delete(keyOf(i.prevout)); this.stats.dropped++; this.onChange?.('drop', txid); }
  // after a block: drop what it confirmed or conflicted with, then re-check the rest against the new state
  afterBlock() { for (const [txid, e] of [...this.txs]) { const c = this.check(e.hex); if (!c.ok || (c.dup && !this.txs.has(txid))) { this.drop(txid); continue; } if (e.tx.inputs.some((i) => !this.node.utxo.get(keyOf(i.prevout)))) this.drop(txid); } }
  // what a block builder wants: by fee rate, highest first
  list() { return [...this.txs.entries()].map(([txid, e]) => ({ txid, ...e })).sort((a, b) => b.feeRate - a.feeRate); }
}

// follow relays for kind 23404 events for this chain; a publisher allowlist is optional
// feedPublishers: the keys whose kind 23404 events say "a node has this transaction" (via 'feed', fed). Anyone else's 23404
// event is still validated and kept, but as a relay echo: it never says a node has it (a stranger could re-post a payment)
// a socket quiet for `quietMs` is opened again, and reopen() does it at once (a page that wakes or comes back online)
export const viaOf = (ev, feedPublishers = null) => (ev.kind === MEMPOOL_KIND && (!feedPublishers || feedPublishers.includes(ev.pubkey)) ? 'feed' : 'relay');
export async function subscribeMempool(mempool, { relays, network, publishers = null, feedPublishers = null, nostr = null, also = [], log = () => {}, quietMs = 600_000 }) {
  const { verifyNostrEvent } = await nostrModule(nostr);
  const seen = new Set(); const sockets = new Map(); let closed = false;
  const open = (url, backoff = 1000) => {
    if (closed) return; let ws;
    try { ws = new WebSocket(url); } catch { return setTimeout(() => open(url, Math.min(backoff * 2, 60000)), backoff); }
    ws.at = Date.now(); sockets.set(url, ws);
    ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify(['REQ', 'mp', { kinds: [MEMPOOL_KIND, ...also], since: Math.floor(Date.now() / 1000) - 600, ...(publishers ? { authors: publishers } : {}) }])); log(`mempool: following kind ${MEMPOOL_KIND} on ${url}`); };
    ws.onmessage = async (m) => {
      ws.at = Date.now(); let msg; try { const d = m.data; msg = JSON.parse(typeof d === 'string' ? d : d instanceof ArrayBuffer ? new TextDecoder().decode(d) : typeof d?.text === 'function' ? await d.text() : String(d)); } catch { return; } // text, or a binary frame from a plain relay
      if (msg[0] !== 'EVENT' || !msg[2]) return; const ev = msg[2];
      if ((ev.kind !== MEMPOOL_KIND && !also.includes(ev.kind)) || seen.has(ev.id)) return; if (ev.kind === MEMPOOL_KIND && !ev.tags?.some((t) => t[0] === 'chain' && t[1] === network)) return;
      if (publishers && !publishers.includes(ev.pubkey)) return; if (!verifyNostrEvent(ev)) return;
      seen.add(ev.id); if (seen.size > 20000) seen.delete(seen.values().next().value);
      mempool.add(String(ev.content).trim().toLowerCase(), `${ev.pubkey.slice(0, 8)}… via ${url.replace('wss://', '')}`, viaOf(ev, feedPublishers));
    };
    ws.onerror = () => {}; ws.onclose = () => { if (sockets.get(url) === ws) sockets.delete(url); if (!closed) setTimeout(() => open(url, Math.min(backoff * 2, 60000)), backoff); };
  };
  const reopen = (only = null) => { for (const [url, ws] of [...sockets]) if (!only || only(ws)) { ws.onclose = null; sockets.delete(url); try { ws.close(); } catch {} open(url); } };
  const watchdog = setInterval(() => reopen((ws) => Date.now() - ws.at > quietMs), 60_000); watchdog.unref?.(); /* never keeps a Node process alive */
  relays.forEach((u) => open(u));
  return { close() { closed = true; clearInterval(watchdog); for (const ws of sockets.values()) { try { ws.close(); } catch {} } }, reopen: () => reopen() };
}
