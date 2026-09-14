#!/usr/bin/env node
// blaketestnode: fetch | verify | sync | bench   (--data <dir>, --conf <bitcoin.conf>, --no-scripts, --to <height>)
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { CHAIN, SNAPSHOT } from '../lib/params.mjs';
import { parseSnapshot } from '../lib/snapshot.mjs';
import { UtxoSet } from '../lib/utxo.mjs';
import { loadEngine } from '../lib/engine.mjs';
import { makeRpc } from '../lib/rpc.mjs';
import { fetchSnapshot, sha256File } from '../lib/fetch.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'bench';
const opt = (n, d) => { const i = argv.indexOf(n); return i > 0 ? argv[i + 1] : d; };
const DATA = opt('--data', `${homedir()}/.blaketestnode/${CHAIN.alias}`).replace(/^~/, homedir());
const CONF = opt('--conf', CHAIN.conf);
const NO_SCRIPTS = argv.includes('--no-scripts');
const TO = opt('--to') ? Number(opt('--to')) : null;
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
  const rpc = await makeRpc(CONF, CHAIN.network);
  const tip = TO ?? await rpc('getblockcount');
  const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
  // headers: the whole current epoch up to the tip, decoded by the codec (v1 before the fork, v2 after)
  let t0 = performance.now();
  const headers = [], hashes = [];
  for (let h = epochStart; h <= tip; h++) {
    const hash = await rpc('getblockhash', h); hashes[h] = hash;
    headers[h] = k.codec.decode('BlockHeader', await rpc('getblockheader', hash, false));
  }
  bench.headersFetch = { ms: +(performance.now() - t0).toFixed(0), count: tip - epochStart + 1 };
  t0 = performance.now();
  const startHeight = SNAPSHOT.baseHeight + 1;
  const verdicts = k.headers.validateChain(headers.slice(startHeight, tip + 1), { startHeight, prevContext: headers.slice(epochStart, startHeight), now: Math.floor(Date.now() / 1000) + 7200 });
  const badHeaders = verdicts.filter((v) => !v.ok);
  const nullHeaderRules = new Set(verdicts.flatMap((v) => v.results.filter((r) => r.ok === null).map((r) => r.rule)));
  bench.headers = { ms: +(performance.now() - t0).toFixed(0), validated: verdicts.length, failed: badHeaders.length, skippedRules: [...nullHeaderRules] };
  for (const v of badHeaders.slice(0, 3)) log('header failed', v.height, v.results.filter((r) => r.ok === false).map((r) => r.rule));
  for (let h = startHeight; h <= tip; h++) if (verdicts[h - startHeight].hash !== hashes[h]) throw new Error(`hash mismatch at ${h}: ${verdicts[h - startHeight].hash}`);
  log(`headers: ${verdicts.length} validated, ${badHeaders.length} failed, hashes match the node, ${(performance.now() - t0).toFixed(0)} ms`);

  // blocks: fetch, decode, structural rules, contextual rules against the UTXO set, apply
  const rulesNull = new Map(), rulesFailed = new Map();
  let txs = 0, bytes = 0, fetchMs = 0, decodeMs = 0, validateMs = 0, applyMs = 0, created = 0, spent = 0, failed = 0;
  const tAll = performance.now();
  for (let h = startHeight; h <= tip; h++) {
    let t = performance.now();
    const hex = await rpc('getblock', hashes[h], 0); fetchMs += performance.now() - t; bytes += hex.length / 2;
    t = performance.now();
    const block = k.codec.decode('Block', hex); decodeMs += performance.now() - t;
    txs += block.transactions.length;
    t = performance.now();
    const s = k.blocks.validateBlockStructure(block);
    const mtp = k.headers.medianTimePast(headers.slice(h - 11, h));
    const c = k.blocks.validateBlockContext(block, { height: h, utxo, mtp });
    validateMs += performance.now() - t;
    for (const r of [...s.results, ...c.results]) {
      if (r.ok === null) rulesNull.set(r.rule, (rulesNull.get(r.rule) ?? 0) + 1);
      if (r.ok === false) { rulesFailed.set(r.rule, (rulesFailed.get(r.rule) ?? 0) + 1); }
    }
    if (!s.ok || !c.ok) { failed++; if (failed <= 5) log(`block ${h} failed:`, [...s.results, ...c.results].filter((r) => r.ok === false).map((r) => r.rule).join(', '), c.spending.missing.slice(0, 2)); }
    t = performance.now();
    const a = k.blocks.applyBlock(utxo, block, h); applyMs += performance.now() - t; created += a.created; spent += a.spent;
    if ((h - startHeight) % 200 === 199) log(`  block ${h}, ${txs} txs, ${mb()}`);
  }
  const ms = performance.now() - tAll;
  bench.blocks = { from: startHeight, to: tip, count: tip - startHeight + 1, txs, MiB: +(bytes / 1048576).toFixed(1), ms: +ms.toFixed(0), blocksPerSec: +((tip - startHeight + 1) / (ms / 1000)).toFixed(1), fetchMs: +fetchMs.toFixed(0), decodeMs: +decodeMs.toFixed(0), validateMs: +validateMs.toFixed(0), applyMs: +applyMs.toFixed(0), failed, created, spent, utxoSize: utxo.size, skippedRules: Object.fromEntries(rulesNull), failedRules: Object.fromEntries(rulesFailed), scripts: !NO_SCRIPTS, rss: mb() };
  log(`blocks: ${bench.blocks.count} validated to ${tip}, ${failed} failed, ${txs} txs, ${(ms / 1000).toFixed(1)} s`);
  // cross-check the resulting set against the node
  const info = await rpc('gettxoutsetinfo', 'none', TO ?? undefined);
  bench.crosscheck = { nodeCoins: info.txouts, ourCoins: utxo.size, match: info.txouts === utxo.size, height: info.height };
  log(`utxo count: ours ${utxo.size.toLocaleString()} vs node ${info.txouts.toLocaleString()} at ${info.height} → ${bench.crosscheck.match ? 'match' : 'MISMATCH'}`);
}

try {
  if (cmd === 'fetch') await fetch();
  else if (cmd === 'verify') load();
  else if (cmd === 'sync') await sync(load());
  else if (cmd === 'bench') { await fetch(); await sync(load()); }
  else throw new Error(`unknown command ${cmd}`);
  console.log(JSON.stringify(bench, null, 2));
} catch (e) { log('error:', e.message); console.log(JSON.stringify(bench, null, 2)); process.exit(1); }
