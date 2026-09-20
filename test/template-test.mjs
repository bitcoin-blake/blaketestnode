// The block a web node builds (datstr SPEC 6.3) on a throwaway chain: a node with twelve headers
// of context and a UTXO set, a mempool holding a valid spend, a split. The built block passes every
// kernel rule but proof of work, pays the split plus the fees, carries the witness and datstr
// commitments, and is the same block the datstr gateway's builder makes from the same template.
//   node test/template-test.mjs
import { homedir } from 'node:os';
import { buildTemplate, checkTemplate, VERSION_V2 } from '../lib/template.mjs';
import { Mempool } from '../lib/mempool.mjs';
import { ChainNode } from '../lib/node.mjs';
const SCHEMA = process.env.SCHEMA ?? `${homedir()}/bitcoin-desktop/schema`; const GW = process.env.DATSTR_GATEWAY ?? `${homedir()}/ideas/datstr-wt-mempool/gateway`;
const { loadEngine } = await import(`${GW}/lib/engine.mjs`); const { buildBlock } = await import(`${GW}/lib/block.mjs`); const hash = await import(`${SCHEMA}/codec/hash.js`);
const secp = await import(`${SCHEMA}/codec/secp256k1.js`); const { SIGHASH_UNIFIED } = await import(`${SCHEMA}/codec/interpreter.js`); const S = await import(`${homedir()}/remote/github.com/sidestr/spec/siding/lib/schnorr.mjs`);
let ok = 0, bad = 0; const t = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); cond ? ok++ : bad++; };
const NETWORK = 'btc:regtest-blake2b'; const { k } = await loadEngine({ network: NETWORK, activationHeight: 0, headline: '' });
const signer = S.makeSigner({ hash, secp }); const key = signer.randomKey(), mine = '5120' + signer.pubkeyOf(key), payA = '5120' + signer.pubkeyOf(signer.randomKey()), payB = '5120' + signer.pubkeyOf(signer.randomKey());
// twelve v2 headers of context at min difficulty, ten minutes apart, linked by hash
const utxo = new Map(); const node = new ChainNode({ k, utxo, epochStart: 489 }); const powBits = k.headers.compactFromTarget(k.headers.powLimit); const t0 = 1_700_000_000;
let prev = '00'.repeat(32);
for (let h = 489; h <= 500; h++) { const hdr = k.codec.decode('BlockHeader', k.codec.encodeHex('BlockHeader', { version: VERSION_V2, prevBlockHash: prev, merkleRoot: '11'.repeat(32), timeOnWire: t0 + h * 600, bits: powBits, nonce: 0, nonce2: 0, nonce3: 0, extranonce: '00'.repeat(16), timeOffset: 0, txCount: 1, flags: 0, xorKeyMaskClearBits: 0, xorKey: '00'.repeat(16), height: h, mmRhs: '00'.repeat(32) })); node.headers[h] = hdr; node.chain[h] = k.codec.blockHash(hdr); prev = node.chain[h]; }
node.height = 500;
utxo.set('aa'.repeat(32) + ':0', { output: { value: 100000, scriptPubKey: mine }, height: 10, coinbase: true });
const spend = (prevout, value, fee) => { const tx = { version: 2, inputs: [{ prevout, scriptSig: '', sequence: 0xfffffffd }], outputs: [{ value: value - fee, scriptPubKey: payA }], lockTime: 0, witness: [] }; const prevouts = [{ value, scriptPubKey: mine }]; const ht = 0x01 | SIGHASH_UNIFIED; let m = k.interpreter.sighashUnified(tx, 0, prevouts, ht, 2); if (typeof m === 'string') m = hash.hexToBytes(m); tx.witness = [[hash.bytesToHex(signer.schnorrSign(m, key)) + ht.toString(16).padStart(2, '0')]]; return k.codec.encodeHex('Transaction', tx); };
const mp = new Mempool({ k, node, network: NETWORK }); const r = mp.add(spend({ txid: 'aa'.repeat(32), vout: 0 }, 100000, 700)); t('the mempool holds a valid spend with a 700-sat fee', r.ok && mp.size === 1);
const now = t0 + 501 * 600 + 30; const worker = 'ab'.repeat(32);
const b = buildTemplate({ k, hash, node, mempool: mp, payScripts: [payA], worker, now });
t('the block is at the next height on the tip with a v2 header and the right tx count', b.height === 501 && b.header.prevBlockHash === node.chain[500] && b.header.version === VERSION_V2 && b.header.txCount === 2 && b.header.height === 501);
t('it includes the mempool transaction and pays subsidy plus its fee', b.txids.length === 1 && b.fees === 700 && b.value === k.blocks.subsidy(501) + 700 && b.coinbase.outputs[0].value === b.value);
t('the coinbase ends in the witness commitment then the datstr commitment', b.coinbase.outputs.at(-2).scriptPubKey.startsWith('6a24aa21a9ed') && b.coinbase.outputs.at(-1).scriptPubKey === '6a20' + b.commitment && b.coinbase.inputs[0].scriptSig.endsWith('0400000000'));
t('time is after the median time past and bits follow the chain rules (min difficulty here)', b.time > b.mtp && b.bits === k.headers.expectedBits(node.headers[500], 500, null, { header: { time: b.time }, chainAt: (h) => node.headers[h] }));
const c = checkTemplate({ k, node, block: b.block, height: b.height }); t(`every kernel rule passes but proof of work (${c.failed.join(', ') || 'none failed'})`, c.ok);
t('an unmined header fails no rule but pow, and on regtest pow itself may pass by chance', c.powRules.every((r) => r === 'btc:rule-header-pow'));
// the gateway's builder, from the getblocktemplate-shaped template, makes the same block
const g = buildBlock({ k, hash, template: b.template, payScripts: [payA], worker });
t('the datstr gateway builds the identical coinbase and header from this template', g.cbTxid === b.cbTxid && k.codec.encodeHex('BlockHeader', g.header) === k.codec.encodeHex('BlockHeader', b.header));
// a split from a coordinator: exact outputs, value conserved, refused if it overpays
const sub = k.blocks.subsidy(501); const s = buildTemplate({ k, hash, node, mempool: mp, split: [[payA, sub - 200000000 + 700], [payB, 200000000]], worker, now });
t('a split is paid exactly and the sum matches the block value', s.nSplit === 2 && s.coinbase.outputs[0].value === sub - 200000000 + 700 && s.coinbase.outputs[1].value === 200000000 && checkTemplate({ k, node, block: s.block, height: 501 }).ok);
let threw = null; try { buildTemplate({ k, hash, node, mempool: mp, split: [[payA, k.blocks.subsidy(501) + 701]], worker, now }); } catch (e) { threw = e.message; } t('a split that pays more than the block has is refused', /pays .* the block has/.test(threw ?? ''));
const e = buildTemplate({ k, hash, node, payScripts: [payA], worker, now }); t('with no mempool the block is coinbase-only and still valid', e.txids.length === 0 && e.header.txCount === 1 && checkTemplate({ k, node, block: e.block, height: 501 }).ok);
t('the block round-trips through the codec: hex decodes to the same hash', k.codec.blockHash(k.codec.decode('Block', b.hex).header) === b.hash);
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
