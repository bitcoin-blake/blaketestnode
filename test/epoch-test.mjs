// MuHash3072 (lib/muhash.mjs) against Core's vectors and Node's ChaCha20, and an epoch package
// (lib/epoch.mjs) built from a toy chain, verified, then broken in each way the file could lie.
import { createCipheriv, randomBytes } from 'node:crypto';
import { MuHash3072, chacha20Keystream, coinBytes, valueHex, digestOf } from '../lib/muhash.mjs';
import { EpochTally, makePackage, packageText, verifyEpoch, bitsToBytes, bytesToBits, toBase64, fromBase64 } from '../lib/epoch.mjs';
let pass = 0, fail = 0; const t = (name, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !d ? '' : `\n        ${d}`}`); ok ? pass++ : fail++; };

// ---- MuHash ----
let same = 0; for (let i = 0; i < 10; i++) { const key = randomBytes(32); if (Buffer.from(chacha20Keystream(new Uint8Array(key), 384)).equals(createCipheriv('chacha20', key, Buffer.alloc(16)).update(Buffer.alloc(384)))) same++; }
t('ChaCha20 keystream agrees with Node\'s cipher (nonce 0, counter 0)', same === 10);
t('the empty set digests to Core\'s value', new MuHash3072().digest() === 'dd5ad2a105c2d29495f577245c357409002329b9f4d6182c0af3dc2f462555c8');
const el = (i) => { const b = new Uint8Array(32); b[0] = i; return b; };
const core = new MuHash3072().insert(el(0)).insert(el(1)).remove(el(2));
t('Core\'s vector: {0} × {1} ÷ {2}', core.digest() === '10d312b100cbd32ada024a6646e40d3482fcff103668d2625f10002a607d5863', core.digest());
const a = new MuHash3072().insert(el(5)).insert(el(7)).remove(el(5)), b = new MuHash3072().insert(el(7));
t('insert then remove cancels; order does not matter', a.value() === b.value() && new MuHash3072().insert(el(7)).insert(el(5)).value() === new MuHash3072().insert(el(5)).insert(el(7)).value());
t('a value carries on: start from a\'s value, add {9}, equals {7,9}', MuHash3072.fromValue(a.value()).insert(el(9)).value() === new MuHash3072().insert(el(7)).insert(el(9)).value());
const coin = { output: { value: 5000000000, scriptPubKey: '0014' + 'ab'.repeat(20) }, height: 150000, coinbase: true };
const ser = coinBytes('ff'.repeat(31) + '01:3', coin);
t('coin serialisation: txid raw, vout, height·2+coinbase, amount, script', ser.length === 32 + 4 + 4 + 8 + 1 + 22 && ser[0] === 1 && ser[31] === 0xff && ser[32] === 3 && ser[36] === ((150000 * 2 + 1) & 0xff) && ser[40] === 0 && ser[41] === 0xf2 && ser[48] === 22 && ser[49] === 0 && ser[50] === 0x14);
t('bitmap round trip', (() => { const bits = [1, 0, 0, 1, 1, 0, 1, 1, 1, 0]; const back = bytesToBits(fromBase64(toBase64(bitsToBytes(bits))), bits.length); return bits.every((x, i) => x === back[i]); })());

// ---- a toy chain: a fake kernel that trusts every block, so only the epoch bookkeeping is under test ----
const k = {
  codec: { txid: (tx) => tx.txid, blockHash: (h) => h.hash },
  headers: { validateChain: (hs, { startHeight }) => hs.map((h, i) => ({ ok: true, height: startHeight + i, hash: h.hash, results: [] })), medianTimePast: () => 0 },
  blocks: { validateBlockStructure: () => ({ ok: true, results: [] }), validateBlockContext: () => ({ ok: true, results: [] }),
    applyBlock: (utxo, block, height) => { block.transactions.forEach((tx, i) => { if (i > 0) for (const inp of tx.inputs) utxo.delete(`${inp.prevout.txid}:${inp.prevout.vout}`); tx.outputs.forEach((o, vout) => { if (!o.scriptPubKey.startsWith('6a')) utxo.set(`${tx.txid}:${vout}`, { outpoint: { txid: tx.txid, vout }, output: o, height, coinbase: i === 0 }); }); }); } },
};
const out = (value, tag) => ({ value, scriptPubKey: '0014' + tag.repeat(20) });
const tx = (txid, inputs, outputs) => ({ txid, inputs: inputs.map(([txid, vout]) => ({ prevout: { txid, vout } })), outputs });
const T = (i) => i.toString(16).padStart(64, '0');
// the set before the epoch: A (old coinbase) and B
const start = new Map([[`${T(0xa)}:0`, { outpoint: { txid: T(0xa), vout: 0 }, output: out(5000000000, 'aa'), height: 100, coinbase: true }], [`${T(0xb)}:1`, { outpoint: { txid: T(0xb), vout: 1 }, output: out(123456, 'bb'), height: 200, coinbase: false }]]);
const startValue = (() => { const m = new MuHash3072(); for (const [key, c] of start) m.insert(coinBytes(key, c)); return m.value(); })();
const H = (height, prev, hash) => ({ height, prevBlockHash: prev, hash });
const blocks = {
  1001: { header: H(1001, 'h1000', 'h1001'), transactions: [tx(T(0xc1), [], [out(5000000000, 'c1')]), tx(T(0xd1), [[T(0xa), 0]], [out(4000000000, 'd1'), out(999999000, 'd2'), { value: 0, scriptPubKey: '6a04deadbeef' }])] },
  1002: { header: H(1002, 'h1001', 'h1002'), transactions: [tx(T(0xc2), [], [out(5000000000, 'c2')]), tx(T(0xe1), [[T(0xd1), 0], [T(0xb), 1]], [out(3999000000, 'e1')]), tx(T(0xf1), [[T(0xe1), 0]], [out(3998000000, 'f1')])] }, // spends an output of the same block
};
const headers = [H(990, 'x', 'h990')]; for (let h = 991; h <= 1002; h++) headers.push(blocks[h]?.header ?? H(h, `h${h - 1}`, `h${h}`));
const utxo = new Map(start); const tally = new EpochTally({ startHeight: 1000, startValue });
for (const h of [1001, 1002]) { const m = tally.block(k, blocks[h], h, utxo); if (m) throw new Error(m); k.blocks.applyBlock(utxo, blocks[h], h); }
const hints = tally.hints(utxo);
t('tally: created outputs in order, OP_RETURN skipped', tally.created.join(' ') === `${T(0xc1)}:0 ${T(0xd1)}:0 ${T(0xd1)}:1 ${T(0xc2)}:0 ${T(0xe1)}:0 ${T(0xf1)}:0`);
t('tally: the older coins spent are A then B, in spend order', tally.spent.map((r) => r[0]).join(' ') === `${T(0xa)}:0 ${T(0xb)}:1` && tally.spent[0][1] === 100 && tally.spent[0][2] === 1 && tally.spent[0][3] === 5000000000);
t('tally: hints mark c1, d2, c2, f1 unspent and d1, e1 spent', hints.join('') === '101101' && tally.spentInEpoch === 2);
const expect = (() => { const m = new MuHash3072(); for (const [key, c] of utxo) m.insert(coinBytes(key, c)); return m.value(); })();
t('the end value equals the MuHash of the set itself', tally.value() === expect);
const pkg = makePackage({ chain: 'toy', alias: 'toy', start: { height: 1000, hash: 'h1000', coins: 2, value: startValue }, end: { height: 1002, hash: 'h1002', coins: utxo.size, value: tally.value() }, tally, hints, built: { at: 'now' } });
t('package: JSON-LD header, counts, hints, 768-hex values', pkg['@type'] === 'Epoch' && pkg.network === 'toy' && pkg.outputs === 6 && pkg.unspent === 4 && pkg.end.coins === 4 && pkg.start.value.length === 768 && pkg.end.muhash === digestOf(tally.value()));
const text = packageText(pkg); const back = JSON.parse(text);
t('package text round-trips and keeps one record per line', JSON.stringify(back) === JSON.stringify(pkg) && text.split('\n').filter((l) => l.startsWith('  [')).length === 2);
const verify = (p) => verifyEpoch(k, p, { blocks: (h) => blocks[h], headers, headersFrom: 990 });
const ok = verify(pkg);
t('verify: the package passes from the blocks and side data alone', ok.ok === true && ok.checks.sideData === 2 && ok.checks.hints === 6 && ok.checks.muhash === pkg.end.muhash, JSON.stringify(ok));
const mutate = (f) => { const p = JSON.parse(JSON.stringify(pkg)); f(p); return verify(p); };
let r = mutate((p) => { const bits = bytesToBits(fromBase64(p.hints), p.outputs); bits[1] = 1; p.hints = toBase64(bitsToBytes(bits)); });
t('a flipped hint is caught by name', !r.ok && /hint 1 .*says unspent, the blocks say spent/.test(r.why), r.why);
r = mutate((p) => { p.spent[0][3] = 4999999999; });
t('a lied amount in the side data breaks the product', !r.ok && /does not reach the end value/.test(r.why), r.why);
r = mutate((p) => { p.spent.splice(1, 1); });
t('a missing side-data coin is caught at the block that spends it', !r.ok && /block 1002 spends .*neither the side data nor the epoch/.test(r.why), r.why);
r = mutate((p) => { p.spent.push([`${T(0xa)}:7`, 100, 1, 1, '0014' + 'aa'.repeat(20)]); });
t('a side-data coin the epoch never spends is caught', !r.ok && /was not spent in the epoch/.test(r.why), r.why);
r = mutate((p) => { p.end.hash = 'h1003'; });
t('a wrong end hash is caught', !r.ok && /the chain ends at h1002/.test(r.why), r.why);
r = mutate((p) => { p.end.coins = 5; });
t('a wrong coin count is caught', !r.ok && /coin count/.test(r.why), r.why);
r = mutate((p) => { p.end.value = valueHex(startValue); p.end.muhash = digestOf(startValue); });
t('a wrong end value is caught', !r.ok && /does not reach the end value/.test(r.why), r.why);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
