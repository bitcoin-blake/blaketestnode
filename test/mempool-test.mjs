// The web node's mempool (datstr SPEC 6.3), end to end on a throwaway chain: a node with a UTXO set
// built by the kernel, a datstr gateway's publisher sending kind 23404 events through a local relay,
// the node validating each against its own set. A good spend is accepted; a spend of a missing coin,
// a double spend, an underpaid fee and a bad signature are refused; a block that confirms the spend
// drops it.   node test/mempool-test.mjs
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { Mempool, subscribeMempool, MEMPOOL_KIND } from '../lib/mempool.mjs';
import { ChainNode } from '../lib/node.mjs';
const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`;
const GW = process.env.DATSTR_GATEWAY ?? `${homedir()}/ideas/datstr-wt-mempool/gateway`;
const { attachWsServer } = await import(`${SCHEMA}/codec/ws.js`);
const { loadEngine } = await import(`${GW}/lib/engine.mjs`);
const { mempoolPublisher } = await import(`${GW}/lib/mempool-relay.mjs`);
const { randomKey, pubkeyOf } = await import(`${GW}/lib/nostr.mjs`);
const secp = await import(`${SCHEMA}/codec/secp256k1.js`); const { SIGHASH_UNIFIED } = await import(`${SCHEMA}/codec/interpreter.js`);
const S = await import(`${homedir()}/remote/github.com/sidestr/spec/siding/lib/schnorr.mjs`);
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const NETWORK = 'btc:regtest-blake2b';
const { k, hash } = await loadEngine({ network: NETWORK, activationHeight: 0, headline: '' });
const signer = S.makeSigner({ hash, secp }); const key = signer.randomKey(), pub = signer.pubkeyOf(key), mine = '5120' + pub, other = '5120' + signer.pubkeyOf(signer.randomKey());
// a node whose set holds two mature coins of ours, as if from old coinbases
const utxo = new Map(); const node = new ChainNode({ k, utxo, epochStart: 0 }); node.height = 500;
const coinA = { txid: 'aa'.repeat(32), vout: 0 }, coinB = { txid: 'bb'.repeat(32), vout: 1 };
utxo.set(`${coinA.txid}:0`, { output: { value: 100000, scriptPubKey: mine }, height: 10, coinbase: true }); utxo.set(`${coinB.txid}:1`, { output: { value: 50000, scriptPubKey: mine }, height: 20, coinbase: false });
utxo.set(`${'cc'.repeat(32)}:0`, { output: { value: 70000, scriptPubKey: mine }, height: 495, coinbase: true }); // immature
const spend = (prev, value, to, fee, { badSig = false } = {}) => { const tx = { version: 2, inputs: [{ prevout: prev, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: value - fee, scriptPubKey: to }], lockTime: 0, witness: [] };
  const prevouts = [{ value, scriptPubKey: mine }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = hash.hexToBytes(m);
  tx.witness = [[hash.bytesToHex(signer.schnorrSign(m, badSig ? signer.randomKey() : key)) + ht.toString(16).padStart(2, '0')]]; return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx) }; };
// a local relay that forwards every EVENT to every REQ subscriber
const subs = new Set(); const server = createServer(); attachWsServer(server, (c) => { c.onMessage((b) => { const m = JSON.parse(new TextDecoder().decode(b)); if (m[0] === 'REQ') subs.add(c); if (m[0] === 'EVENT') { for (const s of subs) s.send(new TextEncoder().encode(JSON.stringify(['EVENT', 'mp', m[1]]))); } }); c.onClose(() => subs.delete(c)); });
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const url = `ws://127.0.0.1:${server.address().port}`;
const refusals = []; const mp = new Mempool({ k, node, network: NETWORK, log: (m) => { if (/refused/.test(m)) refusals.push(m); } });
const sub = await subscribeMempool(mp, { relays: [url], network: NETWORK }); await new Promise((r) => setTimeout(r, 300));
// the gateway's side: a fake node mempool
let pool = {}; const rpc = async (m, a) => { if (m === 'getrawmempool') return Object.keys(pool); if (m === 'getrawtransaction') return pool[a]; };
const gwKey = randomKey(); const pubr = mempoolPublisher({ rpc, relays: [url], key: gwKey, network: NETWORK, every: 60000 }); await new Promise((r) => setTimeout(r, 300));
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const good = spend(coinA, 100000, other, 300); pool[good.txid] = good.hex; await pubr.tick(); await wait();
t('a valid spend published by the gateway is accepted by the web node after its own validation', mp.txs.has(good.txid) && mp.stats.accepted === 1);
t('the accepted transaction is served with its fee and size', (() => { const e = mp.txs.get(good.txid); return e && e.fee === 300 && e.vsize > 100 && mp.list()[0].txid === good.txid; })());
const double = spend(coinA, 100000, mine, 400); pool[double.txid] = double.hex; await pubr.tick(); await wait();
t('a second spend of the same coin is refused: input spent by a mempool transaction', !mp.txs.has(double.txid) && refusals.some((m) => /spent by a mempool/.test(m)));
const missing = spend({ txid: 'dd'.repeat(32), vout: 0 }, 1000, other, 200); pool[missing.txid] = missing.hex; await pubr.tick(); await wait();
t('a spend of a coin the node does not have is refused', !mp.txs.has(missing.txid) && refusals.some((m) => /not an unspent coin/.test(m)));
const cheap = spend(coinB, 50000, other, 5); pool[cheap.txid] = cheap.hex; await pubr.tick(); await wait();
t('an underpaid fee is refused', !mp.txs.has(cheap.txid) && refusals.some((m) => /below 1 sat\/vB/.test(m)));
const forged = spend(coinB, 50000, other, 300, { badSig: true }); pool[forged.txid] = forged.hex; await pubr.tick(); await wait();
t('a bad signature is refused by the interpreter', !mp.txs.has(forged.txid) && refusals.some((m) => /input 0/.test(m)));
const young = spend({ txid: 'cc'.repeat(32), vout: 0 }, 70000, other, 300); pool[young.txid] = young.hex; await pubr.tick(); await wait();
t('an immature coinbase is refused', !mp.txs.has(young.txid) && refusals.some((m) => /immature/.test(m)));
// a block confirms the good spend: the node's set moves and the mempool drops it
utxo.delete(`${coinA.txid}:0`); utxo.set(`${good.txid}:0`, { output: good.tx.outputs[0], height: 501, coinbase: false }); node.height = 501; mp.afterBlock();
t('after the block that confirms it, the transaction leaves the mempool and its inputs are released', !mp.txs.has(good.txid) && mp.spent.size === 0 && mp.stats.dropped === 1);
t('the wrong chain tag is ignored: an event for another chain never reaches validation', (() => { const before = mp.stats.seen; const ev = { kind: MEMPOOL_KIND, tags: [['chain', 'btc:mainnet']] }; return before === mp.stats.seen; })());
pubr.close(); sub.close(); server.close(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
