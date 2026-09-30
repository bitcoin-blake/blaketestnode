#!/usr/bin/env node
// Publishes the local node's mempool as kind 23404 events, and hands blocks found by web nodes (kind 23405, the block hex) to the local node with submitblock; (datstr SPEC 6.3: one transaction each,
// tagged with the chain), so a web node can validate them itself and keep its own mempool; and
// writes <alias>-mempool.json beside the block file so a web node can fill its mempool on start.
//   node tools/publish-mempool.mjs --key-file ~/.datstr/mempool-txbt4.key --relays wss://a,wss://b [--loop 3] [--dir ~/knots-testnet4/snapshots] [--rsync user@host:path/]
// Signing and publishing come from the sidestr library (SIDESTR_LIB=<path to siding/lib>); the key is a 32-byte hex file, never an argument.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { CHAIN } from '../lib/params.mjs';
import { makeRpc } from '../lib/rpc.mjs';
import { SCHEMA } from '../lib/engine.mjs';
import { MEMPOOL_KIND } from '../lib/mempool.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const H = (p) => p.replace(/^~/, homedir());
const KEY_FILE = opt('--key-file'); if (!KEY_FILE) { console.error('--key-file is required'); process.exit(2); }
const RELAYS = String(opt('--relays', '')).split(',').map((s) => s.trim()).filter(Boolean); if (!RELAYS.length) { console.error('--relays is required'); process.exit(2); }
const LOOP = Number(opt('--loop', 3)); const DIR = H(opt('--dir', '~/knots-testnet4/snapshots')); const RSYNC = opt('--rsync', null);
const LIB = H(process.env.SIDESTR_LIB ?? ''); if (!LIB) { console.error('SIDESTR_LIB (path to sidestr siding/lib) is required'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const [{ makeSigner }, { makeEvents, publish, subscribe }, hash, secp, { verifyNostrEvent }] = await Promise.all([import(`${LIB}/schnorr.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${SCHEMA}/codec/nostr.js`)]);
const signer = makeSigner({ hash, secp }); const events = makeEvents({ signer, hash });
const key = (await readFile(H(KEY_FILE), 'utf8')).trim(); if (!/^[0-9a-f]{64}$/.test(key)) { console.error('the key file must hold 32 bytes as hex'); process.exit(2); }
log(`publishing ${CHAIN.network} mempool as kind ${MEMPOOL_KIND} from ${signer.pubkeyOf(key).slice(0, 12)}… to ${RELAYS.length} relays`);
const rpc = await makeRpc(CHAIN.conf, CHAIN.network);
const file = `${DIR}/${CHAIN.alias}-mempool.json`;
const published = new Map(); // txid → { hex, fee, vsize, time }
let lastJson = '';

async function once() {
  const pool = await rpc('getrawmempool', true); const now = [];
  for (const [txid, e] of Object.entries(pool)) {
    if (!published.has(txid)) {
      let hex; try { hex = await rpc('getrawtransaction', txid); } catch (err) { continue; } // gone between the two calls
      const entry = { hex, fee: Math.round((e.fees?.base ?? e.fee ?? 0) * 1e8), vsize: e.vsize, time: e.time };
      published.set(txid, entry); // before the publish, so a slow relay cannot make the next pass publish it again
      const event = events.signEvent(key, { kind: MEMPOOL_KIND, tags: [['chain', CHAIN.network], ['txid', txid]], content: hex });
      const r = await publish({ relays: RELAYS, event }); const ok = Object.values(r).filter((x) => x === 'ok').length;
      log(`${txid.slice(0, 16)}… ${entry.vsize} vB ${entry.fee} sat → ${ok}/${RELAYS.length} relays${ok ? '' : ' ' + JSON.stringify(r)}`);
    }
    now.push(txid);
  }
  for (const txid of [...published.keys()]) if (!pool[txid]) published.delete(txid);
  const height = await rpc('getblockcount');
  const json = JSON.stringify({ network: CHAIN.network, height, time: Math.floor(Date.now() / 1000), txs: now.map((txid) => ({ txid, ...published.get(txid) })) });
  if (json !== lastJson) { lastJson = json; await writeFile(file, json); if (RSYNC) await new Promise((resolve) => execFile('rsync', ['-a', file, RSYNC], (e) => { if (e) log(`rsync: ${e.message}`); resolve(); })); }
}
// blocks from web nodes: kind 23405, content the block hex, tagged with the chain; the node judges it, nothing else does
const BLOCK_KIND = 23405; const seenBlocks = new Set();
subscribe({ relays: RELAYS, chainId: CHAIN.network, kind: BLOCK_KIND, verify: verifyNostrEvent, since: 600, log, onEvent: async (ev) => {
  if (seenBlocks.has(ev.id)) return; seenBlocks.add(ev.id); if (seenBlocks.size > 5000) seenBlocks.delete(seenBlocks.values().next().value);
  const hex = String(ev.content).trim().toLowerCase(); const h = ev.tags.find((t) => t[0] === 'h')?.[1] ?? '?'; if (!/^[0-9a-f]+$/.test(hex) || hex.length > 8_000_000) return log(`block event ${ev.id.slice(0, 8)}… ignored: not block hex`);
  try { const r = await rpc('submitblock', hex); log(`block from ${ev.pubkey.slice(0, 12)}… for height ${h} (${hex.length / 2} bytes): ${r === null ? 'ACCEPTED by the node' : 'refused: ' + r}`); }
  catch (e) { log(`block from ${ev.pubkey.slice(0, 12)}… for height ${h}: submitblock failed: ${e.message}`); } } });
let running = false; // one pass at a time: a pass waits on relays and can outlast the interval
const pass = () => { if (running) return; running = true; once().catch((e) => log('error:', e.message)).finally(() => { running = false; }); };
pass(); setInterval(pass, LOOP * 1000);
