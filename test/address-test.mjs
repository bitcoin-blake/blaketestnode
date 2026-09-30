// The address index and the pair view, end to end on a small real snapshot file: written in the
// dumptxoutset v2 format, packed-indexed and parsed by the node's own code, with two scripts chosen
// to collide in the index hash. Then the API: Esplora's /address routes from the set and the
// mempool, and /address/:a/pair against a stand-in Esplora on the other branch of the fork.
//   SCHEMA=<bitcoin-desktop/schema> node test/address-test.mjs
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { loadEngine } from '../lib/engine.mjs';
import { writeSnapshot } from '../lib/snapshot-write.mjs';
import { buildIndex, PackedUtxo } from '../lib/packed.mjs';
import { FileBytes } from '../lib/filebytes.mjs';
import { ScriptIndex, buildScriptKeys, scriptIndexBytes, parseScriptIndexBytes, followSet, fnv1a } from '../lib/scriptindex.mjs';
import { makePair } from '../lib/pair.mjs';
import { startApi } from '../lib/api.mjs';
import { CHAIN, SNAPSHOT } from '../lib/params.mjs';
import { hexToBytes, bytesToHex, reverse } from '../lib/bytes.mjs';
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const k = await loadEngine(CHAIN.network);
const dir = mkdtempSync(`${tmpdir()}/blaketestnode-address-`);

// two P2WPKH scripts with the same FNV-1a 32, found by the birthday bound (~80k tries)
const seen = new Map(); let collide = null;
for (let i = 0; !collide; i++) { const s = '0014' + createHash('sha256').update(String(i)).digest('hex').slice(0, 40); const h = fnv1a(hexToBytes(s)); if (seen.has(h)) collide = [seen.get(h), s]; else seen.set(h, s); }
const A = '5120' + '11'.repeat(32), B = '0014' + '22'.repeat(20), [C1, C2] = collide;
// the set at the base: our coins among fillers, grouped by txid in raw-txid order as Core writes them
const coins = [['aa', 0, A, 100000, 100], ['aa', 1, B, 5000, 100], ['bb', 1, A, 25000, 140000], ['cc', 0, C1, 700, 1000], ['dd', 3, C2, 900, 1000]].map(([t, v, s, value, height]) => ({ txid: t.repeat(32), vout: v, script: s, value, height }));
for (let i = 0; i < 3000; i++) coins.push({ txid: bytesToHex(randomBytes(32)), vout: i % 3, script: '0014' + bytesToHex(randomBytes(20)), value: 1000 + i, height: 1 + i });
const groups = new Map(); for (const c of coins) (groups.get(c.txid) ?? groups.set(c.txid, []).get(c.txid)).push([c.vout, { height: c.height, coinbase: false, value: c.value, script: hexToBytes(c.script) }, null]);
const raw = (x) => bytesToHex(reverse(hexToBytes(x)));
const ordered = [...groups].sort((a, b) => (raw(a[0]) < raw(b[0]) ? -1 : 1)).map(([x, g]) => [x, g.sort((p, q) => p[0] - q[0])]);
const path = `${dir}/utxo.dat`;
const w = await writeSnapshot(path, { groups: () => ordered }, { baseHeight: SNAPSHOT.baseHeight, baseHash: SNAPSHOT.baseHash, networkMagic: CHAIN.networkMagic, coins: coins.length });
const file = new FileBytes(path); const r = buildIndex(file, { hash: false });
const utxo = new PackedUtxo(file, { entries: r.entries, count: r.count });
const keys = buildScriptKeys(file, utxo.count);
const idx = followSet(utxo, new ScriptIndex(utxo, keys));
const keysOf = (s) => idx.coins(s).map((e) => e.key).sort();

t('every coin of a script is found, and only those', JSON.stringify(keysOf(A)) === JSON.stringify([`${'aa'.repeat(32)}:0`, `${'bb'.repeat(32)}:1`]) && keysOf(B).length === 1);
t('two scripts sharing an index hash are told apart by reading the coin back', fnv1a(hexToBytes(C1)) === fnv1a(hexToBytes(C2)) && keysOf(C1).join() === `${'cc'.repeat(32)}:0` && keysOf(C2).join() === `${'dd'.repeat(32)}:3`);
t('a random filler script is found once, with its value and height', (() => { const c = coins[1234]; const e = idx.coins(c.script); return e.length === 1 && e[0].coin.output.value === c.value && e[0].coin.height === c.height; })());
t('an unknown script finds nothing', idx.coins('0014' + '33'.repeat(20)).length === 0);
utxo.delete(`${'aa'.repeat(32)}:0`);
t('a spent snapshot coin drops out through the set\'s own bitmap', keysOf(A).length === 1);
utxo.unspend(`${'aa'.repeat(32)}:0`);
t('a rollback that restores it brings it back, with no rebuild', keysOf(A).length === 2);
const fresh = `${'ee'.repeat(32)}:0`; utxo.set(fresh, { output: { value: 4242, scriptPubKey: A }, height: 150400, coinbase: false });
t('a coin created after the snapshot is followed into the index', keysOf(A).includes(fresh) && idx.size === coins.length + 1);
utxo.delete(fresh);
t('and forgotten when it is spent', !keysOf(A).includes(fresh) && idx.size === coins.length);
const bytes = scriptIndexBytes(keys, w.sha256);
t('the index file round-trips, bound to the snapshot sha256', parseScriptIndexBytes(bytes, w.sha256).every((x, i) => x === keys[i]) && (() => { try { parseScriptIndexBytes(bytes, '00'.repeat(32)); return false; } catch (e) { return /another snapshot/.test(e.message); } })());
const m = new Map([[`${'ab'.repeat(32)}:0`, { output: { value: 1, scriptPubKey: B }, height: 1 }]]); const mi = followSet(m, new ScriptIndex(m));
m.set(`${'ac'.repeat(32)}:1`, { output: { value: 2, scriptPubKey: B }, height: 2 }); m.delete(`${'ab'.repeat(32)}:0`);
t('a plain Map set (no packed keys) is indexed from its entries and followed', mi.coins(B).map((e) => e.coin.output.value).join() === '2');

// the API over that set
const node = { height: 150500, chain: [], headers: [], tipHash: () => 'tip' }; node.chain[100] = 'h100'.padEnd(64, '0'); node.headers[100] = { time: 1714000000 }; node.chain[CHAIN.forkHeight] = 'ours'.padEnd(64, '0');
const api = await startApi({ port: 0, status: () => ({}), node, source: null, k });
const base = `http://127.0.0.1:${api.server.address().port}`;
const get = async (p) => { const res = await fetch(base + p); return { code: res.status, body: await res.json() }; };
const addrA = k.script.classify(A).address;
t('the address of a key-path taproot coin is tb1p on this chain', /^tb1p/.test(addrA));
t('without --address-index the routes say so', (await (async () => { api.scripts = null; const x = await get(`/address/${addrA}/utxo`); api.scripts = idx; return x.code === 404 && /--address-index/.test(x.body.error); })()));
let x = await get(`/address/${addrA}/utxo`);
t('/address/:a/utxo lists the coins in Esplora\'s shape', x.code === 200 && x.body.length === 2 && x.body.some((u) => u.txid === 'aa'.repeat(32) && u.vout === 0 && u.value === 100000 && u.status.confirmed && u.status.block_height === 100 && u.status.block_hash === node.chain[100] && u.status.block_time === 1714000000));
x = await get(`/address/${addrA}`);
t('/address/:a gives funded - spent = the balance, with no invented history', x.code === 200 && x.body.chain_stats.funded_txo_sum - x.body.chain_stats.spent_txo_sum === 125000 && x.body.chain_stats.tx_count === null && x.body.scriptPubKey === A);
api.mempool = { txs: new Map([['ff'.repeat(32), { tx: { outputs: [{ value: 800, scriptPubKey: B }, { value: 9000, scriptPubKey: A }] } }]]), spent: new Set([`${'bb'.repeat(32)}:1`]) };
x = await get(`/address/${addrA}/utxo`);
t('a mempool output to the address is listed unconfirmed, a coin a mempool spend uses is not listed', x.body.length === 2 && x.body.some((u) => u.txid === 'ff'.repeat(32) && u.vout === 1 && u.status.confirmed === false) && !x.body.some((u) => u.txid === 'bb'.repeat(32)));
x = await get(`/address/${addrA}`);
t('and the stats move as Esplora\'s do: confirmed funds stay, the mempool spends and adds', x.body.chain_stats.funded_txo_sum === 125000 && x.body.mempool_stats.funded_txo_sum === 9000 && x.body.mempool_stats.spent_txo_sum === 25000);
api.mempool = null;
t('a mainnet address is refused on this chain', (await get('/address/bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq/utxo')).code === 400);
t('a malformed address is refused', (await get('/address/tb1qnotanaddressatall/utxo')).code === 400);

// the other branch: a stand-in Esplora that shares the base and diverges at the fork
let theirFork = 'theirs'.padEnd(64, '0'), theirBase = SNAPSHOT.baseHash;
const theirs = [{ txid: 'aa'.repeat(32), vout: 0, value: 100000, status: { confirmed: true, block_height: 100 } }, { txid: '99'.repeat(32), vout: 2, value: 3333, status: { confirmed: true, block_height: 150350 } }, { txid: '98'.repeat(32), vout: 0, value: 1, status: { confirmed: false } }];
const esplora = createServer((req, res) => { const p = req.url; if (p === `/block-height/${SNAPSHOT.baseHeight}`) return res.end(theirBase); if (p === `/block-height/${CHAIN.forkHeight}`) return res.end(theirFork); if (p === `/address/${addrA}/utxo`) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(theirs)); } res.statusCode = 404; res.end('no'); });
await new Promise((ok) => esplora.listen(0, '127.0.0.1', ok)); const pairUrl = `http://127.0.0.1:${esplora.address().port}/`;
t('without --pair-api the pair route says so', (await get(`/address/${addrA}/pair`)).code === 404);
api.pair = makePair({ api: pairUrl, alias: CHAIN.pairAlias, forkHeight: CHAIN.forkHeight });
x = await get(`/address/${addrA}/pair`);
t('/address/:a/pair finds the coin unspent on both branches', x.code === 200 && x.body.both.length === 1 && x.body.both[0].txid === 'aa'.repeat(32) && x.body.both[0].height === 100);
t('and what is only on this branch and only on the other, confirmed coins only', x.body.txbt4.only.coins === 1 && x.body.txbt4.only.value === 25000 && x.body.tbtc4.only.coins === 1 && x.body.tbtc4.only.value === 3333 && x.body.utxo.tbtc4[0].txid === '99'.repeat(32));
t('the view is symmetric: each side\'s totals count the shared coin once', x.body.txbt4.value === 125000 && x.body.tbtc4.value === 103333 && x.body.fork.base.hash === SNAPSHOT.baseHash);
theirFork = node.chain[CHAIN.forkHeight]; api.pair = makePair({ api: pairUrl, alias: CHAIN.pairAlias, forkHeight: CHAIN.forkHeight });
x = await get(`/address/${addrA}/pair`);
t('a pair API on this same branch is refused', x.code === 502 && /follows this branch/.test(x.body.error));
theirFork = 'theirs'.padEnd(64, '0'); theirBase = '00'.repeat(32); api.pair = makePair({ api: pairUrl, alias: CHAIN.pairAlias, forkHeight: CHAIN.forkHeight });
x = await get(`/address/${addrA}/pair`);
t('a pair API on another chain entirely is refused', x.code === 502 && /another chain/.test(x.body.error));

api.server.close(); esplora.close(); file.close(); rmSync(dir, { recursive: true });
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
