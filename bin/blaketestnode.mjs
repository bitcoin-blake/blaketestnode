#!/usr/bin/env node
// blaketestnode: fetch | verify | sync | bench | run   (--data <dir>, --source http|rpc, --conf <bitcoin.conf>, --no-scripts, --to <height>, --api <port>, --poll <s>, --checkpoint-every <n>)
import { readFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { CHAIN, SNAPSHOT } from '../lib/params.mjs';
import { parseSnapshot } from '../lib/snapshot.mjs';
import { UtxoSet } from '../lib/utxo.mjs';
import { loadEngine } from '../lib/engine.mjs';
import { makeRpc } from '../lib/rpc.mjs';
import { fetchSnapshot, sha256File } from '../lib/fetch.mjs';
import { HttpBlockSource, RpcBlockSource } from '../lib/source.mjs';
import { fetchTip, subscribeTip } from '../lib/nip333.mjs';
import { ChainNode } from '../lib/node.mjs';
import { listStates, saveState } from '../lib/state.mjs';
import { startApi } from '../lib/api.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'bench';
const opt = (n, d) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : d; };
const DATA = opt('--data', `${homedir()}/.blaketestnode/${CHAIN.alias}`).replace(/^~/, homedir());
const CONF = opt('--conf', CHAIN.conf);
const NO_SCRIPTS = argv.includes('--no-scripts');
const TO = opt('--to') ? Number(opt('--to')) : null;
const SOURCE = opt('--source', 'http'); // http: the served block file + NIP-333 tip; rpc: the local node
const API = Number(opt('--api', 3336)); const POLL = Number(opt('--poll', 30)); const CKPT = Number(opt('--checkpoint-every', 100));
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const bench = {};
const mb = () => (process.memoryUsage().rss / 1048576).toFixed(0) + ' MiB rss';
mkdirSync(DATA, { recursive: true });
const snapPath = `${DATA}/${SNAPSHOT.file}`;

async function fetch() {
  const r = await fetchSnapshot(DATA, { log });
  if (!r.skipped) { bench.fetch = { ms: r.ms, MiBps: +(r.bytes / 1048576 / (r.ms / 1000)).toFixed(2), peers: r.peers }; log(`fetched in ${(r.ms / 1000).toFixed(1)} s, ${bench.fetch.MiBps} MiB/s`); }
  const t0 = performance.now(); const sha = await sha256File(snapPath); bench.sha256 = { ms: +(performance.now() - t0).toFixed(0), ok: sha === SNAPSHOT.sha256 };
  if (!bench.sha256.ok) throw new Error(`sha256 mismatch: ${sha}`);
  log('sha256 ok');
}

function load({ hash = true } = {}) {
  if (!existsSync(snapPath)) throw new Error(`no snapshot at ${snapPath}; run fetch first`);
  let t0 = performance.now();
  const buf = readFileSync(snapPath);
  bench.read = { ms: +(performance.now() - t0).toFixed(0), bytes: buf.length };
  const utxo = new UtxoSet(buf);
  t0 = performance.now();
  const r = parseSnapshot(buf, { hash, log, onCoin: (txid, vout, off) => utxo.addSnapshotCoin(txid, vout, off) });
  bench.parse = { ms: +r.ms.toFixed(0), coins: r.coinsRead, txids: r.txids, coinsPerSec: Math.round(r.coinsRead / (r.ms / 1000)), rss: mb() };
  const checks = { magic: true, network: r.networkMagic === CHAIN.networkMagic, baseHash: r.baseHash === SNAPSHOT.baseHash, coins: r.coinsRead === SNAPSHOT.coins, hashSerialized: hash ? r.hashSerialized === SNAPSHOT.txoutsetHash : null };
  bench.snapshot = { ...checks, baseHash: r.baseHash, hashSerialized: r.hashSerialized };
  if (Object.values(checks).includes(false)) throw new Error(`snapshot check failed: ${JSON.stringify(checks)} got ${r.hashSerialized}`);
  log(`snapshot ok: ${r.coinsRead.toLocaleString()} coins in ${r.txids.toLocaleString()} txids, hash_serialized_3 matches, ${(r.ms / 1000).toFixed(1)} s, ${mb()}`);
  return utxo;
}

async function sync(utxo) {
  const k = await loadEngine(CHAIN.network);
  if (NO_SCRIPTS) k.blocks.interpreter = null;
  const http = SOURCE !== 'rpc';
  let rpc = null;
  if (!http || existsSync(CONF.replace(/^~/, homedir()))) { try { rpc = await makeRpc(CONF, CHAIN.network); await rpc('getblockcount'); } catch { rpc = null; } }
  if (!http && !rpc) throw new Error(`--source rpc needs a node at ${CONF}`);
  const source = http ? new HttpBlockSource(k, CHAIN.blocksUrl, DATA, { log }) : new RpcBlockSource(rpc);
  const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
  const startHeight = SNAPSHOT.baseHeight + 1;
  let t0 = performance.now();

  // the block file (mirrored with Range requests) and the NIP-333 tip as the independent check
  let contextHeaders;
  if (http) {
    const u = await source.update();
    bench.blockFile = { ...u, ms: +(performance.now() - t0).toFixed(0) };
    log(`block file ${u.from}-${u.to}: ${u.fetched} bytes fetched, ${u.verified} blocks hash-checked`);
    t0 = performance.now();
    const nip = await fetchTip(k, CHAIN.nip333);
    if (nip) {
      bench.nip333 = { height: nip.height, hash: nip.hash, relay: nip.relay, ageS: Math.floor(Date.now() / 1000) - nip.created_at, ms: +(performance.now() - t0).toFixed(0) };
      let checked = 0;
      for (let i = 0; i < nip.headers.length; i++) {
        const h = nip.first + i; const want = k.codec.blockHash(nip.headers[i]); const have = await source.hash(h);
        if (have && have !== want) throw new Error(`block file disagrees with the NIP-333 headers at ${h}: ${have} vs ${want}`);
        if (have) checked++;
      }
      bench.nip333.crossChecked = checked;
      if (nip.height > u.to) log(`note: block file lags the nostr tip by ${nip.height - u.to} blocks`);
      log(`nostr tip ${nip.height} ${nip.hash.slice(0, 16)}… from ${nip.relay}, ${bench.nip333.ageS} s old, ${checked} tail hashes agree with the block file`);
    } else { bench.nip333 = null; log('no NIP-333 tip event reachable; trusting the block file alone'); }
    t0 = performance.now();
    const ctx = await source.contextHeaders(CHAIN.blocksUrl.replace(/-blocks$/, '-context-headers.json'));
    if (ctx.from !== epochStart || ctx.to !== SNAPSHOT.baseHeight) throw new Error('context headers cover the wrong range');
    contextHeaders = ctx.headers.map((h) => k.codec.decode('BlockHeader', h));
  } else {
    contextHeaders = [];
    for (let h = epochStart; h <= SNAPSHOT.baseHeight; h++) contextHeaders.push(k.codec.decode('BlockHeader', await rpc('getblockheader', await rpc('getblockhash', h), false)));
  }
  const tip = TO ?? await source.tip();

  // fetch + decode every post-fork block; the headers come out of the blocks
  let fetchMs = 0, decodeMs = 0, bytes = 0;
  const blocks = [], hashes = [];
  for (let h = startHeight; h <= tip; h++) {
    let t = performance.now();
    const hex = await source.blockHex(h); fetchMs += performance.now() - t; bytes += hex.length / 2;
    t = performance.now();
    blocks[h] = k.codec.decode('Block', hex); decodeMs += performance.now() - t;
    hashes[h] = await source.hash(h);
  }
  bench.headersFetch = { ms: +(performance.now() - t0).toFixed(0), count: tip - epochStart + 1, source: http ? 'block file' : 'rpc' };
  t0 = performance.now();
  const headers = blocks.slice(startHeight, tip + 1).map((b) => b.header);
  const verdicts = k.headers.validateChain(headers, { startHeight, prevContext: contextHeaders, now: Math.floor(Date.now() / 1000) + 7200 });
  const badHeaders = verdicts.filter((v) => !v.ok);
  const nullHeaderRules = new Set(verdicts.flatMap((v) => v.results.filter((r) => r.ok === null).map((r) => r.rule)));
  bench.headers = { ms: +(performance.now() - t0).toFixed(0), validated: verdicts.length, failed: badHeaders.length, skippedRules: [...nullHeaderRules] };
  for (const v of badHeaders.slice(0, 3)) log('header failed', v.height, v.results.filter((r) => r.ok === false).map((r) => r.rule));
  for (let h = startHeight; h <= tip; h++) if (verdicts[h - startHeight].hash !== hashes[h]) throw new Error(`hash mismatch at ${h}: ${verdicts[h - startHeight].hash}`);
  log(`headers: ${verdicts.length} validated, ${badHeaders.length} failed, hashes match the source, ${(performance.now() - t0).toFixed(0)} ms`);

  // structural rules, contextual rules against the UTXO set, apply
  const all = [...contextHeaders, ...headers]; // for MTP windows
  const rulesNull = new Map(), rulesFailed = new Map();
  let txs = 0, validateMs = 0, applyMs = 0, created = 0, spent = 0, failed = 0;
  const tAll = performance.now();
  for (let h = startHeight; h <= tip; h++) {
    const block = blocks[h];
    txs += block.transactions.length;
    let t = performance.now();
    const s = k.blocks.validateBlockStructure(block);
    const i = h - epochStart;
    const mtp = k.headers.medianTimePast(all.slice(i - 11, i));
    const c = k.blocks.validateBlockContext(block, { height: h, utxo, mtp });
    validateMs += performance.now() - t;
    for (const r of [...s.results, ...c.results]) {
      if (r.ok === null) rulesNull.set(r.rule, (rulesNull.get(r.rule) ?? 0) + 1);
      if (r.ok === false) rulesFailed.set(r.rule, (rulesFailed.get(r.rule) ?? 0) + 1);
    }
    if (!s.ok || !c.ok) { failed++; if (failed <= 5) log(`block ${h} failed:`, [...s.results, ...c.results].filter((r) => r.ok === false).map((r) => r.rule).join(', '), c.spending.missing.slice(0, 2)); }
    t = performance.now();
    const a = k.blocks.applyBlock(utxo, block, h); applyMs += performance.now() - t; created += a.created; spent += a.spent;
    if ((h - startHeight) % 200 === 199) log(`  block ${h}, ${txs} txs, ${mb()}`);
  }
  const ms = performance.now() - tAll;
  bench.blocks = { from: startHeight, to: tip, count: tip - startHeight + 1, txs, MiB: +(bytes / 1048576).toFixed(1), ms: +ms.toFixed(0), blocksPerSec: +((tip - startHeight + 1) / (ms / 1000)).toFixed(1), fetchMs: +fetchMs.toFixed(0), decodeMs: +decodeMs.toFixed(0), validateMs: +validateMs.toFixed(0), applyMs: +applyMs.toFixed(0), failed, created, spent, utxoSize: utxo.size, skippedRules: Object.fromEntries(rulesNull), failedRules: Object.fromEntries(rulesFailed), scripts: !NO_SCRIPTS, source: http ? 'http' : 'rpc', rss: mb() };
  log(`blocks: ${bench.blocks.count} validated to ${tip}, ${failed} failed, ${txs} txs, ${(ms / 1000).toFixed(1)} s`);
  // cross-check the resulting set against a node when one is reachable
  if (rpc) {
    try {
      const info = await rpc('gettxoutsetinfo', 'none', TO ?? undefined);
      bench.crosscheck = { nodeCoins: info.txouts, ourCoins: utxo.size, match: info.txouts === utxo.size, height: info.height };
      log(`utxo count: ours ${utxo.size.toLocaleString()} vs node ${info.txouts.toLocaleString()} at ${info.height} → ${bench.crosscheck.match ? 'match' : 'MISMATCH'}`);
    } catch (e) { bench.crosscheck = { ourCoins: utxo.size, note: e.message }; }
  } else { bench.crosscheck = { ourCoins: utxo.size, node: 'none' }; log(`utxo count: ${utxo.size.toLocaleString()} coins at ${tip} (no node to compare with)`); }
}

// The running node: load the newest checkpoint (or the fork snapshot), follow the block
// file and the NIP-333 stream, apply new blocks, pop reorgs, checkpoint, serve status.
async function run() {
  const k = await loadEngine(CHAIN.network);
  if (NO_SCRIPTS) k.blocks.interpreter = null;
  const source = new HttpBlockSource(k, CHAIN.blocksUrl, DATA, { log });
  const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
  const startedAt = Date.now();
  const st = { state: 'starting', nostr: null, file: null, checkpoint: null, saving: false, lastTickAt: null, rollbacks: 0, startedFrom: null, tipTime: null };
  let node = null, utxo = null, api = null;
  const status = () => ({ network: CHAIN.network, alias: CHAIN.alias, height: node?.height ?? -1, hash: node?.tipHash() ?? null, tipTime: st.tipTime, coins: utxo?.size ?? 0, state: st.state, saving: st.saving,
    checkpoint: st.checkpoint, nostr: st.nostr, file: st.file, lastTickAt: st.lastTickAt, uptimeS: Math.floor((Date.now() - startedAt) / 1000), rssMiB: Math.round(process.memoryUsage().rss / 1048576),
    run: node ? { blocks: node.stats.blocks, txs: node.stats.txs, validateMs: Math.round(node.stats.validateMs), failed: node.stats.failed, rollbacks: st.rollbacks, startedFrom: st.startedFrom, skipped: node.stats.skipped } : { blocks: 0, txs: 0, validateMs: 0, failed: 0, rollbacks: 0, startedFrom: st.startedFrom } });
  api = await startApi({ port: API, status, node: () => node, source, k, log }); // before the long load, so a port clash fails fast
  let file = await source.update(); st.file = { ...file, blocks: source.index.blocks.length, at: Math.floor(Date.now() / 1000) };
  const ctx = await source.contextHeaders(CHAIN.blocksUrl.replace(/-blocks$/, '-context-headers.json'));
  const magic = CHAIN.networkMagic;

  // newest checkpoint still on the served chain, else the fork snapshot
  let base;
  for (const m of listStates(DATA)) {
    if (m.base_height > source.index.to || (await source.hash(m.base_height)) !== m.base_hash) { log(`checkpoint ${m.base_height} is not on the served chain, skipping`); continue; }
    log(`loading checkpoint ${m.base_height} ${m.base_hash.slice(0, 16)}…`);
    const buf = readFileSync(m.path); utxo = new UtxoSet(buf);
    const r = parseSnapshot(buf, { log, onCoin: (txid, vout, off) => utxo.addSnapshotCoin(txid, vout, off) });
    if (r.baseHash !== m.base_hash || r.hashSerialized !== m.txoutset_hash || r.coinsRead !== m.coins) { log('checkpoint corrupt, skipping'); utxo = null; continue; }
    base = { height: m.base_height, hash: m.base_hash }; st.checkpoint = { height: m.base_height, hash: m.base_hash, bytes: m.bytes }; break;
  }
  if (!utxo) { utxo = load(); base = { height: SNAPSHOT.baseHeight, hash: SNAPSHOT.baseHash }; }
  st.startedFrom = `${base.height}`;
  node = new ChainNode({ k, utxo, epochStart, log });
  node.loadContext(ctx.headers.map((h) => k.codec.decode('BlockHeader', h)));
  node.setBase(base.height, base.hash);
  // headers between the base and the checkpoint are needed for MTP and difficulty context
  for (let h = SNAPSHOT.baseHeight + 1; h <= base.height; h++) { const b = k.codec.decode('Block', await source.blockHex(h)); node.headers[h] = b.header; node.chain[h] = await source.hash(h); }
  if (base.height > SNAPSHOT.baseHeight) st.tipTime = node.headers[base.height].time;

  let sinceSave = 0, ticking = false, dirty = false;

  async function checkpoint(reason) {
    if (st.saving) return;
    st.saving = true; const t0 = performance.now();
    try {
      const m = await saveState(DATA, utxo, { height: node.height, hash: node.tipHash(), networkMagic: magic, network: CHAIN.network, log });
      st.checkpoint = { height: m.base_height, hash: m.base_hash, bytes: m.bytes, txoutset_hash: m.txoutset_hash }; sinceSave = 0; dirty = false;
      log(`checkpoint ${m.base_height} written (${reason}): ${m.coins.toLocaleString()} coins, ${(m.bytes / 1048576).toFixed(0)} MiB, hash_serialized_3 ${m.txoutset_hash.slice(0, 16)}…, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) { log('checkpoint failed:', e.message); } finally { st.saving = false; }
  }

  async function tick(reason) {
    if (ticking) return; ticking = true;
    try {
      file = await source.update(); st.file = { ...file, blocks: source.index.blocks.length, at: Math.floor(Date.now() / 1000) };
      // reorg: our applied hashes must match the served chain
      let common = node.height;
      while (common > SNAPSHOT.baseHeight && (await source.hash(common)) !== node.chain[common]) common--;
      if (common < node.height) {
        log(`reorg: served chain diverges above ${common}, rolling back ${node.height - common} block(s)`);
        try { node.rollbackTo(common); st.rollbacks += node.height - common; dirty = true; }
        catch (e) { log(`${e.message}; discarding checkpoints above ${common} and restarting`); for (const m of listStates(DATA)) if (m.base_height > common) { unlinkSync(m.path); unlinkSync(m.path.replace(/\.dat$/, '.json')); } process.exit(3); }
      }
      const to = source.index.to;
      if (to > node.height) st.state = 'syncing';
      for (let h = node.height + 1; h <= to; h++) {
        const r = node.applyNext(h, await source.blockHex(h));
        st.tipTime = r.time; sinceSave++; dirty = true;
        api?.broadcast({ type: 'block', height: h, hash: r.hash, txs: r.txs, time: r.time });
        if (h % 50 === 0 || h === to) log(`block ${h} ${r.hash.slice(0, 16)}… ${r.txs} txs${h === to ? ' (tip)' : ''}`);
      }
      st.state = 'synced'; st.lastTickAt = Math.floor(Date.now() / 1000);
      if (st.nostr) st.nostr.agree = st.nostr.height > node.height ? null : node.chain[st.nostr.height] === st.nostr.hash;
      if (sinceSave >= CKPT || (!st.checkpoint && dirty)) await checkpoint(sinceSave >= CKPT ? `${sinceSave} blocks` : 'first sync');
    } catch (e) { st.state = 'error: ' + e.message; log('tick error:', e.message); } finally { ticking = false; }
  }

  await tick('start');
  setInterval(() => tick('poll'), POLL * 1000);
  const t0 = performance.now(); const nip = await fetchTip(k, CHAIN.nip333);
  if (nip) { st.nostr = { height: nip.height, hash: nip.hash, relay: nip.relay, created_at: nip.created_at, agree: node.chain[nip.height] ? node.chain[nip.height] === nip.hash : null }; log(`nostr tip ${nip.height} ${nip.hash.slice(0, 16)}… (${Math.round(performance.now() - t0)} ms)`); }
  subscribeTip(k, CHAIN.nip333, (t) => { st.nostr = { ...t, agree: node.chain[t.height] ? node.chain[t.height] === t.hash : null }; log(`nostr: tip ${t.height} ${t.hash.slice(0, 16)}… via ${t.relay}`); if (t.height > node.height) setTimeout(() => tick('nostr'), 3000); }, { log });
  const stop = async (sig) => { log(`${sig}: ${dirty ? 'checkpointing before exit' : 'nothing to save'}`); if (dirty) await checkpoint('shutdown'); process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
  log(`running: height ${node.height}, ${utxo.size.toLocaleString()} coins, polling every ${POLL} s, checkpoint every ${CKPT} blocks`);
  await new Promise(() => {});
}

try {
  if (cmd === 'run') await run();
  else if (cmd === 'fetch') await fetch();
  else if (cmd === 'verify') load();
  else if (cmd === 'sync') await sync(load());
  else if (cmd === 'bench') { await fetch(); await sync(load()); }
  else throw new Error(`unknown command ${cmd}`);
  console.log(JSON.stringify(bench, null, 2));
} catch (e) { log('error:', e.message); console.log(JSON.stringify(bench, null, 2)); process.exit(1); }
