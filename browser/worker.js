// The node's worker: owns the origin's files (OPFS), fetches the snapshot in ranges straight to
// disk, hashes it, parses and indexes it with the same code the Node daemon runs.
import { SNAPSHOT, CHAIN } from '../lib/params.mjs';
import { Sha256 } from '../lib/sha256.mjs';
import { buildIndex, indexBytes, parseIndexBytes } from '../lib/packed.mjs';
import { bytesToHex } from '../lib/bytes.mjs';
import { PackedUtxo } from '../lib/packed.mjs';
import { ChainNode } from '../lib/node.mjs';
import { fetchTip, subscribeTip } from '../lib/nip333.mjs';
import { buildTemplate, checkTemplate } from '../lib/template.mjs';
import { makeWebMiner } from '../lib/webminer.mjs';
const SIDESTR = 'https://cdn.jsdelivr.net/gh/sidestr/spec@cec654b7d06907130700fe52c66c3f9d0921495d/siding/lib';
import { Mempool, subscribeMempool } from '../lib/mempool.mjs';
import { OpfsBlockSource } from './blocks.js';

const CDN = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
let engine = null;
async function loadEngine() {
  if (engine) return engine;
  const [{ createKernel }, { knotsBlake2b }, nostr, hash] = await Promise.all([import(`${CDN}/codec/kernel.js`), import(`${CDN}/codec/overlays/knots-blake2b.js`), import(`${CDN}/codec/nostr.js`), import(`${CDN}/codec/hash.js`)]);
  const j = async (p) => (await fetch(`${CDN}/${p}`)).json();
  const k = createKernel({ core: await j('schema/core.jsonld'), proof: await j('schema/proof.jsonld'), script: await j('schema/script.jsonld'), chain: await j('schema/chain.jsonld'), validate: await j('schema/validate.jsonld'), network: CHAIN.network, overlays: [knotsBlake2b(await j('schema/overlays/knots-blake2b.jsonld'))] });
  return (engine = { k, nostr, hash });
}
// small-file helpers over OPFS for the block mirror
const files = {
  handle: (name, create = false) => open(name, create),
  readText: (name) => readSmall(name),
  writeText: (name, text) => writeSmall(name, text),
};

const post = (m) => self.postMessage(m);
const log = (text) => post({ type: 'log', text });
let root;
const dir = async () => (root ??= await navigator.storage.getDirectory());
// a handle on a file. Right after a reload the previous page's worker may still hold one for a
// moment, so wait a little before concluding another tab of this origin has the files open.
async function open(name, create = false) {
  const fh = await (await dir()).getFileHandle(name, { create });
  for (let attempt = 0; ; attempt++) {
    try { return await fh.createSyncAccessHandle(); }
    catch (e) { if (attempt >= 24 || !/Access Handle/.test(e.message)) throw new Error(attempt >= 24 ? `${name} is open in another tab of this site; close it and retry` : e.message); await new Promise((r) => setTimeout(r, 250)); }
  }
}
async function sizeOf(name) { try { const h = await open(name); const n = h.getSize(); h.close(); return n; } catch { return -1; } }

// { size, read(off, len) } over an OPFS sync access handle: the browser twin of FileBytes
class OpfsBytes {
  constructor(handle) { this.h = handle; this.size = handle?.getSize() ?? 0; }
  attach(handle) { this.h = handle; this.size = handle.getSize(); }
  read(off, len) { const b = new Uint8Array(Math.min(len, Math.max(0, this.size - off))); const n = this.h.read(b, { at: off }); return n === b.length ? b : b.subarray(0, n); }
}

async function status() {
  const est = await navigator.storage.estimate().catch(() => ({}));
  const dat = await sizeOf(SNAPSHOT.file), idx = await sizeOf(`${SNAPSHOT.file}.idx`), sha = await readSmall(`${SNAPSHOT.file}.sha256`), partial = (await readSmall(`${SNAPSHOT.file}.ranges`)) != null;
  post({ type: 'status', quota: est.quota ?? null, usage: est.usage ?? null, dat: partial ? Math.min(dat, SNAPSHOT.bytes - 1) : dat, idx, sha, partial, expect: { bytes: SNAPSHOT.bytes, sha256: SNAPSHOT.sha256, txoutsetHash: SNAPSHOT.txoutsetHash, baseHeight: SNAPSHOT.baseHeight, baseHash: SNAPSHOT.baseHash, coins: SNAPSHOT.coins, alias: CHAIN.alias } });
}
async function readSmall(name) { try { const h = await open(name); const b = new Uint8Array(h.getSize()); h.read(b, { at: 0 }); h.close(); return new TextDecoder().decode(b); } catch { return null; } }
async function writeSmall(name, text) { const h = await open(name, true); h.truncate(0); h.write(new TextEncoder().encode(text), { at: 0 }); h.flush(); h.close(); }

// Range-fetch the snapshot into OPFS: several ranges in flight at once (one stream is slow
// over a long path), resuming from what is there; then the whole file is hashed once.
async function fetchSnapshot(url, { parallel = 6, chunk = 32 << 20 } = {}) {
  const h = await open(SNAPSHOT.file, true);
  // ranges are fixed-size chunks from 0; the journal lists the ones that completed, so a
  // resume after an interruption (ranges land out of order) refetches exactly what is missing
  const nChunks = Math.ceil(SNAPSHOT.bytes / chunk);
  const journalName = `${SNAPSHOT.file}.ranges`;
  let done = new Set(); try { const j = JSON.parse(await readSmall(journalName) ?? 'null'); if (j && j.chunk === chunk) done = new Set(j.done); } catch {}
  if (h.getSize() > SNAPSHOT.bytes) { h.truncate(0); done = new Set(); }
  const have = done.size * chunk - (done.has(nChunks - 1) ? nChunks * chunk - SNAPSHOT.bytes : 0);
  if (done.size) log(`resuming: ${done.size} of ${nChunks} ranges already on disk`);
  const t0 = performance.now(); let got = 0, lastReport = 0;
  const ranges = []; for (let i = 0; i < nChunks; i++) if (!done.has(i)) ranges.push([i, i * chunk, Math.min(SNAPSHOT.bytes, (i + 1) * chunk) - 1]);
  const total = SNAPSHOT.bytes - have;
  let journalLock = Promise.resolve(); // one sync access handle at a time on the journal
  const journal = () => (journalLock = journalLock.then(() => writeSmall(journalName, JSON.stringify({ chunk, done: [...done] }))).catch(() => {}));
  const report = () => { if (performance.now() - lastReport > 250) { lastReport = performance.now(); post({ type: 'fetch', have: have + got, total: SNAPSHOT.bytes, rate: got / ((performance.now() - t0) / 1000) }); } };
  const pull = async () => {
    for (;;) {
      const r = ranges.shift(); if (!r) return;
      const [ci, start, end] = r; let at = start;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(url, { headers: { range: `bytes=${at}-${end}` }, cache: 'no-store' });
          if (res.status !== 206) throw new Error(`server answered ${res.status} to a range request (needs Range and CORS)`);
          const reader = res.body.getReader();
          for (;;) { const { value, done } = await reader.read(); if (done) break; h.write(value, { at }); at += value.length; got += value.length; report(); }
          if (at !== end + 1) throw new Error(`short range: got to ${at}, wanted ${end + 1}`);
          h.flush(); done.add(ci); await journal();
          break;
        } catch (e) { if (attempt >= 3) throw e; log(`range ${ci}: ${e.message}, retrying`); got -= at - start; at = start; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, ranges.length) }, pull));
  h.flush(); h.close();
  const ms = performance.now() - t0;
  post({ type: 'fetch', have: SNAPSHOT.bytes, total: SNAPSHOT.bytes, rate: total / (ms / 1000) });
  log(`fetched ${(total / 1048576).toFixed(0)} MiB in ${(ms / 1000).toFixed(1)} s (${(total / 1048576 / (ms / 1000)).toFixed(1)} MiB/s), hashing the file`);
  const hex = await hashFile();
  post({ type: 'fetched', bytes: SNAPSHOT.bytes, ms, sha256: hex, ok: hex === SNAPSHOT.sha256 });
  if (hex !== SNAPSHOT.sha256) { await wipe(); throw new Error(`sha256 mismatch: got ${hex}; the file was discarded`); }
  try { await (await dir()).removeEntry(journalName); } catch {}
}

async function hashFile() { // for a file that landed in an earlier session without a recorded hash
  const h = await open(SNAPSHOT.file); const sha = new Sha256(); const buf = new Uint8Array(8 << 20); const size = h.getSize();
  for (let off = 0; off < size; off += buf.length) { const n = h.read(buf, { at: off }); sha.update(buf.subarray(0, n)); if ((off / buf.length) % 16 === 0) post({ type: 'hashing', at: off, total: size }); }
  h.close(); const hex = bytesToHex(sha.digest()); await writeSmall(`${SNAPSHOT.file}.sha256`, hex); return hex;
}

// Parse, verify hash_serialized_3, build the index, keep it on disk.
async function verify() {
  const h = await open(SNAPSHOT.file);
  const source = new OpfsBytes(h);
  const t0 = performance.now();
  const r = buildIndex(source, { hash: true, log: (text) => post({ type: 'parsing', text }) });
  h.close();
  const ok = r.hashSerialized === SNAPSHOT.txoutsetHash && r.baseHash === SNAPSHOT.baseHash && r.coinsRead === SNAPSHOT.coins && r.networkMagic === CHAIN.networkMagic;
  if (ok) { const ih = await open(`${SNAPSHOT.file}.idx`, true); ih.truncate(0); ih.write(indexBytes({ entries: r.entries, count: r.count, baseHash: r.baseHash }, SNAPSHOT.sha256), { at: 0 }); ih.flush(); ih.close(); }
  post({ type: 'verified', ok, coins: r.coinsRead, txids: r.txids, baseHash: r.baseHash, hashSerialized: r.hashSerialized, networkMagic: r.networkMagic, ms: performance.now() - t0, indexBytes: r.entries.length });
}

async function wipe() { const d = await dir(); for (const n of [SNAPSHOT.file, `${SNAPSHOT.file}.idx`, `${SNAPSHOT.file}.sha256`, `${SNAPSHOT.file}.ranges`]) { try { await d.removeEntry(n); } catch {} } }

// ---- the chain: blocks from the served file, tip from the relays, validation against the set ----
const chain = { node: null, utxo: null, source: null, bytes: null, nostr: null, deltas: [], syncing: false, timer: null, blocksUrl: null, mempool: null, mempoolSub: null, miner: null, job: null, jobKey: 0 };
// ---- mining what this tab built (datstr SPEC 6.3): the node is a gateway of one ----
async function minerDeps() { const { k, hash } = await loadEngine(); const [pow, { blake2b }, secp, { makeSigner }] = await Promise.all([import(`${CDN}/codec/pow/knots-header-v2.js`), import(`${CDN}/codec/pow/blake2b.js`), import(`${CDN}/codec/secp256k1.js`), import(`${SIDESTR}/schnorr.mjs`)]); return { k, hash, pow, blake2b, signer: makeSigner({ hash, secp }) }; }
async function startMining({ url, key, pay }) {
  if (!chain.node) throw new Error('sync first'); if (chain.miner) chain.miner.close();
  const deps = await minerDeps(); const wm = makeWebMiner({ ...deps, node: chain.node, mempool: chain.mempool, key, payScript: pay, chain: CHAIN.network, url, log });
  chain.miner = wm; wm.on((m) => { if (m.type === 'assignment' || m.type === 'split') newWork('the pool sent ' + m.type); if (m.type === 'ack') post({ ...m, type: 'mine-ack', sent: wm.state.sent, acked: wm.state.acked, refused: wm.state.refused, dropped: wm.state.dropped, blocks: wm.state.blocksFound }); });
  post({ type: 'mining', pub: wm.pub, url }); newWork('start');
}
function newWork(why) {
  const wm = chain.miner; if (!wm || !wm.state.assignment) return;
  try { const job = wm.build(); chain.job = job; chain.jobKey++; post({ type: 'work', jobKey: chain.jobKey, height: job.height, work: Array.from(job.work), target: Array.from(job.shareTarget ?? job.netTarget), splitId: job.splitId, txs: job.txids.length, value: job.value, why }); }
  catch (e) { post({ type: 'log', text: 'work: ' + e.message }); }
}
function foundNonce({ jobKey, nonce, nonce2 = 0 }) {
  const wm = chain.miner, job = chain.job; if (!wm || !job || jobKey !== chain.jobKey) return;
  const sh = wm.share(job, nonce, nonce2); if (!sh.ok) return post({ type: 'log', text: `share not sent: ${sh.reason}` });
  const sent = wm.send(sh.event, { isBlock: sh.isBlock }); post({ type: 'share', hash: sh.hash, height: job.height, isBlock: sh.isBlock, sent, sentTotal: wm.state.sent, dropped: wm.state.dropped });
  if (sh.isBlock) post({ type: 'log', text: `BLOCK ${sh.hash} at ${job.height}: in the share; a verifier with a node submits it` });
}
async function loadSet() {
  if (chain.utxo) return chain.utxo;
  const ih = await open(`${SNAPSHOT.file}.idx`); const ib = new Uint8Array(ih.getSize()); ih.read(ib, { at: 0 }); ih.close();
  const index = parseIndexBytes(ib, SNAPSHOT.sha256);
  chain.bytes = new OpfsBytes(null);
  chain.utxo = new PackedUtxo(chain.bytes, index);
  return chain.utxo;
}
// the snapshot handle is held only while a job runs, so a page on its way out never blocks
// the next one for long
async function withSnapshot(fn) {
  await loadSet();
  const h = await open(SNAPSHOT.file); chain.bytes.attach(h);
  try { return await fn(); } finally { h.close(); chain.bytes.h = null; }
}
async function sync(blocksUrl, { noScripts = false } = {}) {
  if (chain.syncing) return; chain.syncing = true;
  const t0 = performance.now();
  try {
    const { k, nostr } = await loadEngine();
    if (noScripts) k.blocks.interpreter = null;
    const utxo = await loadSet();
    chain.blocksUrl = blocksUrl;
    chain.source ??= new OpfsBlockSource(k, blocksUrl, files, { log });
    const u = await chain.source.update();
    post({ type: 'blockfile', ...u });
    const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
    if (!chain.node) {
      const ctx = await chain.source.contextHeaders(blocksUrl.replace(/-blocks$/, '-context-headers.json'));
      if (ctx.from !== epochStart || ctx.to !== SNAPSHOT.baseHeight) throw new Error('context headers cover the wrong range');
      chain.node = new ChainNode({ k, utxo, epochStart, log });
      chain.node.loadContext(ctx.headers.map((h) => k.codec.decode('BlockHeader', h)));
      chain.node.setBase(SNAPSHOT.baseHeight, SNAPSHOT.baseHash);
      // our own record of blocks applied in earlier sessions, replayed if it still follows the served chain
      chain.deltas = JSON.parse((await readSmall('deltas.json')) ?? '[]');
      let replayed = 0;
      for (const d of chain.deltas) {
        if (d.height !== chain.node.height + 1 || (await chain.source.hash(d.height)) !== d.hash) { chain.deltas.length = replayed; break; }
        for (const key of d.spent) utxo.delete(key); for (const [key, coin] of d.created) if (coin) utxo.set(key, coin);
        const b = k.codec.decode('Block', await chain.source.blockHex(d.height)); chain.node.headers[d.height] = b.header; chain.node.chain[d.height] = d.hash; chain.node.height = d.height; replayed++;
      }
      if (replayed) log(`replayed ${replayed} blocks from this tab's delta log`);
    }
    // the relays' word on the tip, checked against the file's tail
    const nip = await fetchTip(k, CHAIN.nip333, { nostr });
    if (nip) {
      let agree = 0; for (let i = 0; i < nip.headers.length; i++) { const h = nip.first + i; const have = await chain.source.hash(h); if (have && have !== k.codec.blockHash(nip.headers[i])) throw new Error(`block file disagrees with the NIP-333 headers at ${h}`); if (have) agree++; }
      chain.nostr = { height: nip.height, hash: nip.hash, relay: nip.relay, created_at: nip.created_at, agree };
      post({ type: 'nostr', ...chain.nostr });
    }
    // rollback if the served chain diverged from what we applied
    let common = chain.node.height;
    while (common > SNAPSHOT.baseHeight && (await chain.source.hash(common)) !== chain.node.chain[common]) common--;
    if (common < chain.node.height) { log(`reorg: rolling back ${chain.node.height - common} block(s)`); chain.node.rollbackTo(common); chain.deltas = chain.deltas.filter((d) => d.height <= common); await writeSmall('deltas.json', JSON.stringify(chain.deltas)); }
    const to = await chain.source.tip();
    let applied = 0, txs = 0;
    for (let h = chain.node.height + 1; h <= to; h++) {
      const r = chain.node.applyNext(h, await chain.source.blockHex(h));
      // a coin created and spent within the block is gone already and must not be replayed back
      const uu = chain.node.undo.at(-1); chain.deltas.push({ height: h, hash: r.hash, spent: uu.spent.map(([key]) => key), created: uu.created.map((key) => [key, utxo.get(key)]).filter(([, c]) => c) });
      applied++; txs += r.txs;
      if (applied % 20 === 0 || h === to) post({ type: 'progress', height: h, to, applied, txs, ms: performance.now() - t0, coins: utxo.size });
    }
    if (applied) await writeSmall('deltas.json', JSON.stringify(chain.deltas));
    if (applied) chain.mempool?.afterBlock();
    if (applied && chain.miner) newWork(`tip ${chain.node.height}`);
    post({ type: 'synced', height: chain.node.height, hash: chain.node.tipHash(), time: chain.node.headers[chain.node.height]?.time ?? null, coins: utxo.size, applied, txs, ms: performance.now() - t0, stats: chain.node.stats, scripts: !noScripts, quiet: applied === 0 && !!chain.timer });
    if (!chain.timer) {
      chain.timer = setInterval(() => enqueue(() => withSnapshot(() => sync(chain.blocksUrl, { noScripts }))), 30_000);
      subscribeTip(k, CHAIN.nip333, (t) => { chain.nostr = { ...t, agree: chain.node.chain[t.height] ? 1 : 0 }; post({ type: 'nostr', ...chain.nostr, live: true }); if (t.height > chain.node.height) setTimeout(() => enqueue(() => withSnapshot(() => sync(chain.blocksUrl, { noScripts }))), 3000); }, { nostr, log });
    }
  } finally { chain.syncing = false; }
}
async function coin(key) {
  const { k } = await loadEngine(); const utxo = await loadSet();
  const c = utxo.get(key);
  if (!c) return post({ type: 'coin', key, found: false });
  const cl = k.script.classify(c.output.scriptPubKey);
  post({ type: 'coin', key, found: true, value: c.output.value, height: c.height, coinbase: c.coinbase, scriptType: cl.type, address: cl.address, scriptPubKey: c.output.scriptPubKey });
}

// one job at a time: every job opens OPFS handles, and two jobs interleaving at an await
// would try to open the same file twice
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((err) => post({ type: 'error', text: err.message })));
self.onmessage = (e) => enqueue(() => handle(e.data));
async function handle(m) {
  try {
    if (m.type === 'sync') await withSnapshot(() => sync(m.blocksUrl, { noScripts: !!m.noScripts }));
    else if (m.type === 'close') { if (chain.timer) { clearInterval(chain.timer); chain.timer = null; } }
    else if (m.type === 'debug') await withSnapshot(async () => {
      const u = chain.utxo; const c = u?.get(m.key) ?? null; let cl = null, err = null;
      try { cl = engine?.k?.script ? engine.k.script.classify(c.output.scriptPubKey) : 'no k.script: ' + Object.keys(engine?.k ?? {}).join(','); } catch (e) { err = e.message + ' ' + (e.stack ?? '').split('\n').slice(0, 3).join(' / '); }
      post({ type: 'debug', key: m.key, hasUtxo: !!u, fresh: u?.fresh.size, freshHas: u?.fresh.has(m.key), get: c, classify: cl, err, height: chain.node?.height, deltas: chain.deltas.length });
    });
    else if (m.type === 'coin') await withSnapshot(() => coin(m.key));
    else if (m.type === 'mempool') { // datstr SPEC 6.3: transactions from relays, validated here
      const { k, nostr } = await loadEngine(); if (!chain.node) throw new Error('sync first'); if (chain.mempoolSub) chain.mempoolSub.close();
      chain.mempool = new Mempool({ k, node: chain.node, network: CHAIN.network, log }); chain.mempoolSub = await subscribeMempool(chain.mempool, { relays: m.relays, network: CHAIN.network, nostr, log }); post({ type: 'mempool', count: 0, relays: m.relays }); }
    else if (m.type === 'mine') await withSnapshot(() => startMining(m));
    else if (m.type === 'found') await withSnapshot(async () => foundNonce(m));
    else if (m.type === 'stop-mining') { chain.miner?.close(); chain.miner = null; chain.job = null; post({ type: 'mining', pub: null }); }
    else if (m.type === 'template') await withSnapshot(async () => { // the block this tab builds for itself
      const { k, hash } = await loadEngine(); if (!chain.node) throw new Error('sync first');
      const b = buildTemplate({ k, hash, node: chain.node, mempool: chain.mempool, payScripts: [m.pay], worker: m.worker }); const c = checkTemplate({ k, node: chain.node, block: b.block, height: b.height });
      post({ type: 'template', height: b.height, hash: b.hash, prevHash: b.prevHash, time: b.time, bits: b.bits.toString(16), rdts: b.rdtsActive, txs: b.txids.length, fees: b.fees, value: b.value, weight: b.weight, cbTxid: b.cbTxid, commitment: b.commitment, checks: c, hex: b.hex, mempool: chain.mempool ? { count: chain.mempool.size, ...chain.mempool.stats } : null }); });
    else if (m.type === 'status') await status();
    else if (m.type === 'fetch') { await fetchSnapshot(m.url); await status(); }
    else if (m.type === 'hash') { const hex = await hashFile(); post({ type: 'fetched', bytes: await sizeOf(SNAPSHOT.file), ms: 0, sha256: hex, ok: hex === SNAPSHOT.sha256 }); await status(); }
    else if (m.type === 'verify') { await verify(); await status(); }
    else if (m.type === 'wipe') { await wipe(); await status(); }
  } catch (err) { post({ type: 'error', text: err.message + (err.stack ? ' @ ' + err.stack.split('\n').slice(1, 4).map((l) => l.trim()).join(' < ') : '') }); }
}
