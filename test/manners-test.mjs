// The web miner's manners (datstr SPEC 6.3): at most N shares a second go to the coordinator, the
// excess is dropped and counted, a block is never dropped, and the bucket refills each second.
//   node test/manners-test.mjs   (no chain, no coordinator: a fake socket and a fake clock)
import { homedir } from 'node:os';
import { makeWebMiner } from '../lib/webminer.mjs';
import { loadEngine, SCHEMA } from '../lib/engine.mjs'; import { CHAIN } from '../lib/params.mjs';
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const k = await loadEngine(CHAIN.network); const hash = await import(`${SCHEMA}/codec/hash.js`); const pow = await import(`${SCHEMA}/codec/pow/knots-header-v2.js`); const { blake2b } = await import(`${SCHEMA}/codec/pow/blake2b.js`);
const secp = await import(`${SCHEMA}/codec/secp256k1.js`); const { makeSigner } = await import(`${homedir()}/remote/github.com/sidestr/spec/siding/lib/schnorr.mjs`); const signer = makeSigner({ hash, secp });
let ms = 1_000_000; const notes = [];
const wm = makeWebMiner({ k, hash, pow, blake2b, signer, node: { height: 0, headers: [], utxo: new Map(), tipHash: () => '00'.repeat(32), mtp: () => 0, epochStart: 0 }, key: signer.randomKey(), payScript: '5120' + '11'.repeat(32), chain: CHAIN.network, url: null, log: (m) => notes.push(m), maxSharesPerSecond: 5, clock: () => ms });
const sent = []; wm.state.connected = true; wm.state.ws = { send: (s) => sent.push(s), close() {} };
const ev = { id: 'x', kind: 23400 };
for (let i = 0; i < 12; i++) wm.send(ev);
t('twelve shares in one second: five sent, seven dropped', sent.length === 5 && wm.state.dropped === 7 && wm.state.sent === 5);
t('a block is never dropped, even over the cap', wm.send(ev, { isBlock: true }) === true && sent.length === 6);
t('the drop is noted once, not per share', notes.filter((m) => /manners/.test(m)).length === 1);
ms += 1000; for (let i = 0; i < 3; i++) wm.send(ev); t('the next second admits shares again', sent.length === 9 && wm.state.dropped === 7);
ms += 20000; wm.send(ev); for (let i = 0; i < 10; i++) wm.send(ev); t('a later flood is noted again after ten seconds of quiet', notes.filter((m) => /manners/.test(m)).length === 2);
wm.close(); console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
