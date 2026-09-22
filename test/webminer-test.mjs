// A web miner end to end (datstr SPEC 6.3 + 8): this process is a web node (the daemon's state,
// read-only), its own master, connected to a standalone datstr coordinator that reads the same
// chain from a Knots node. It builds the block for the next height with the coordinator's split,
// hashes it to the assignment's target, signs the share, and the coordinator verifies it by SPEC
// 8.1 (merkle, commitment, split, pow, assignment) and credits it. A tampered coinbase is refused.
//   node test/webminer-test.mjs      (needs the daemon's data dir and a Knots conf; ~1 min)
import { spawn } from 'node:child_process'; import { homedir, tmpdir } from 'node:os'; import { mkdtempSync } from 'node:fs'; import { join } from 'node:path';
import { openNode } from '../lib/open.mjs'; import { makeWebMiner, meets } from '../lib/webminer.mjs'; import { loadEngine, SCHEMA } from '../lib/engine.mjs'; import { CHAIN } from '../lib/params.mjs';
const H = homedir(); const GW = process.env.DATSTR_GATEWAY ?? `${H}/ideas/datstr-wt-mempool/gateway`; const DATSTR = `${GW}/..`;
const CONF = process.env.BITCOIN_CONF ?? `${H}/knots-testnet4/bitcoin.conf`; const DATA = process.env.BLAKETESTNODE_DATA ?? `${H}/.blaketestnode/txbt4`; const BLOCKS = process.env.BLAKETESTNODE_BLOCKS_URL; // a blocks mirror for the chain under test; no default, set it for your own
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const log = (...a) => console.log('   ', ...a);
const k = await loadEngine(CHAIN.network); const hash = await import(`${SCHEMA}/codec/hash.js`); const pow = await import(`${SCHEMA}/codec/pow/knots-header-v2.js`); const { blake2b } = await import(`${SCHEMA}/codec/pow/blake2b.js`);
const secp = await import(`${SCHEMA}/codec/secp256k1.js`); const { makeSigner } = await import(`${H}/remote/github.com/sidestr/spec/siding/lib/schnorr.mjs`); const signer = makeSigner({ hash, secp });
const { mine } = await import(`${GW}/miner-core.mjs`);
const tmp = mkdtempSync(join(tmpdir(), 'webminer-')); const port = 3480 + Math.floor(Math.random() * 100);
const co = spawn(process.execPath, [`${DATSTR}/plugin/standalone.mjs`, '--conf', CONF, '--network', CHAIN.network, '--data', `${tmp}/co`, '--port', String(port), '--min-difficulty', '0.0001', '--start-difficulty', '0.0001', '--window-min-weight', '0', '--window-multiple', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
let colog = ''; co.stdout.on('data', (d) => { colog += d; }); co.stderr.on('data', (d) => { colog += d; }); process.on('exit', () => co.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && !/coordinator: ws/.test(colog); i++) await sleep(500); t('a standalone coordinator is up on the same chain', /coordinator: ws/.test(colog));
if (!BLOCKS) { console.log('set BLAKETESTNODE_BLOCKS_URL to a blocks mirror for the chain under test'); process.exit(1); }
const { node, sync } = await openNode({ k, data: DATA, blocksUrl: BLOCKS, scratch: `${tmp}/src`, log });
t('this process is a web node at the served tip', node.height > 151000 && node.utxo.size > 14000000);
const key = signer.randomKey(); const payScript = '5120' + signer.pubkeyOf(signer.randomKey());
const wm = makeWebMiner({ k, hash, pow, blake2b, signer, node, key, payScript, chain: CHAIN.network, url: `ws://127.0.0.1:${port}/ws`, log });
for (let i = 0; i < 40 && !wm.state.assignment; i++) await sleep(250); t('hello as my own master: welcome and an assignment arrived', !!wm.state.pool && !!wm.state.assignment && wm.state.assignment.difficulty === 0.0001);
for (let i = 0; i < 40 && !wm.state.splits.size; i++) await sleep(250); log(`splits held: ${[...wm.state.splits.keys()].join(', ')} · my next height ${node.height + 1}`);
// the coordinator's tip must be ours: sync once if the served file lags the node
const coTip = async () => (await (await fetch(`http://127.0.0.1:${port}/stats.json`)).json()).tip?.height; let ct = await coTip(); if (ct && ct !== node.height + 1) { await sync(); ct = await coTip(); }
t(`the coordinator mines height ${ct}; so do I`, ct === node.height + 1);
const job = wm.build(); t('the block for the next height carries the split the coordinator sent (or pays me alone) and my commitment', job.height === node.height + 1 && job.coinbase.outputs.at(-1).scriptPubKey === '6a20' + job.commitment && (job.splitId === 'solo' || wm.state.splits.get(job.height)?.id === job.splitId));
// hash it: the 80-byte work over the nonce, to the assignment's target
const t0 = Date.now(); let found = null, n = 0; while (!found && Date.now() - t0 < 120000) { const r = mine(blake2b, job.work, job.shareTarget, n, 1, 200000); n = (n + r.hashes) >>> 0; if (r.nonce !== null) found = r.nonce; }
t(`a share was found in ${((Date.now() - t0) / 1000).toFixed(1)} s (${n.toLocaleString()} hashes)`, found !== null);
const sh = wm.share(job, found); t('the full header hashes to what the miner found: the work bytes and the header agree', sh.ok && meets(hash.hexToBytes(sh.powHex), job.shareTarget));
const acks = []; wm.on((m) => { if (m.type === 'ack') acks.push(m); }); wm.send(sh.event); for (let i = 0; i < 40 && !acks.length; i++) await sleep(250);
t(`the coordinator credited the share: ${JSON.stringify(acks[0] ?? null)}`, acks[0]?.result === 'ok' && (job.splitId === 'solo' ? acks[0].weight === 0 : acks[0].weight > 0));
t('the coordinator log says it verified merkle, commitment, split and pow (share #1)', /share #1|receipt /.test(colog));
// a tampered share: the coinbase pays somebody else → the split check refuses it
const bad1 = { ...job, coinbase: { ...job.coinbase, outputs: job.coinbase.outputs.map((o, i) => i === 0 ? { ...o, scriptPubKey: '5120' + 'ee'.repeat(32) } : o) } };
const cbTxid = k.codec.txid(bad1.coinbase); bad1.header = { ...job.header, merkleRoot: k.codec.merkleRoot([cbTxid, ...job.txids]) }; bad1.branches = job.branches;
const d1 = pow.hashHeaderV2Detailed({ ...bad1.header, nonce: 0, nonce2: 0, nonce3: 0, timeOffset: 0, extranonce: job.extranonce });
const w1 = (await import('../lib/webminer.mjs')).workBytes({ blake2b, hash }, { prevBlockHash: job.prevHash, h2: d1.h2, extranonce: job.extranonce }); let f1 = null, n1 = 0; const t1 = Date.now(); while (f1 === null && Date.now() - t1 < 120000) { const r = mine(blake2b, w1, job.shareTarget, n1, 1, 200000); n1 = (n1 + r.hashes) >>> 0; if (r.nonce !== null) f1 = r.nonce; }
const sh1 = wm.share({ ...bad1, h2: d1.h2, work: w1 }, f1); acks.length = 0; wm.send(sh1.event); for (let i = 0; i < 40 && !acks.length; i++) await sleep(250);
t(`a share whose coinbase pays the wrong script is refused as '${acks[0]?.result}'`, acks[0]?.result === 'split' || acks[0]?.result === 'merkle');
// a solo receipt: the same block named 'solo' pays me alone
const solo = wm.build(); solo.splitId = 'solo'; const rebuilt = (await import('../lib/template.mjs')).buildTemplate({ k, hash, node, payScripts: [payScript], worker: wm.pub, now: Math.floor(Date.now() / 1000) });
const d2 = pow.hashHeaderV2Detailed(rebuilt.header); const w2 = (await import('../lib/webminer.mjs')).workBytes({ blake2b, hash }, { prevBlockHash: rebuilt.prevHash, h2: d2.h2, extranonce: job.extranonce }); const netT = job.netTarget;
let f2 = null, n2 = 0; const t2 = Date.now(); while (f2 === null && Date.now() - t2 < 20000) { const r = mine(blake2b, w2, job.shareTarget, n2, 1, 200000); n2 = (n2 + r.hashes) >>> 0; if (r.nonce !== null) f2 = r.nonce; }
const sh2 = wm.share({ ...rebuilt, splitId: 'solo', h2: d2.h2, extranonce: job.extranonce, work: w2, netTarget: netT, shareTarget: job.shareTarget }, f2 ?? 0);
t('a solo share is built against the network target; at real difficulty it is (almost surely) below it and not sent', !sh2.ok || sh2.isBlock);
wm.close(); co.kill(); console.log(`\n${ok} passed, ${bad} failed`); if (bad) console.log(colog.split('\n').slice(-12).join('\n')); process.exit(bad ? 1 : 0);
