// Epoch packages: the chain from one retarget boundary to the next as a verifiable unit, after
// SwiftSync. A package carries the MuHash value of the UTXO set at both ends, a bitmap saying which
// of the outputs the epoch created are still unspent at its end (the hints), and the data of every
// older coin the epoch spent (the side data). A verifier with the blocks and this file, and no UTXO
// set at all, validates every block with the kernel (the side data plays the set), multiplies in
// every created coin and divides out every spent one, and the product must land on the end value.
// Nothing in the file is trusted: a wrong hint, a wrong amount or a missing coin breaks the product.
import { MuHash3072, coinBytes, valueHex, valueFromHex, digestOf } from './muhash.mjs';

export const CONTEXT = 'https://bitcoin-desktop.github.io/schema/context.jsonld';
export const TYPE = 'Epoch';
const keyOf = (p) => `${p.txid}:${p.vout}`;
const spendable = (o) => !o.scriptPubKey.startsWith('6a');

// ---- the hints bitmap: bit i (LSB first within each byte) = created output i is unspent at the end ----
export function bitsToBytes(bits) { const out = new Uint8Array((bits.length + 7) >> 3); for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (i & 7); return out; }
export function bytesToBits(bytes, n) { const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1; return out; }
export function toBase64(bytes) { if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64'); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
export function fromBase64(b64) { if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64')); const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }

// a side-data record <-> the kernel's coin shape
export const spentRecord = (key, c) => [key, c.height, c.coinbase ? 1 : 0, c.output.value, c.output.scriptPubKey];
export const recordCoin = ([key, height, coinbase, value, scriptPubKey]) => { const i = key.indexOf(':'); return { outpoint: { txid: key.slice(0, i), vout: Number(key.slice(i + 1)) }, output: { value, scriptPubKey }, height, coinbase: coinbase === 1 }; };

// The running tally for one epoch, fed each block before it is applied to the set. `utxo.get` must
// resolve every input (the real set when building, the side data when verifying); outputs created
// earlier in the same block are resolved here.
export class EpochTally {
  constructor({ startHeight, startValue }) {
    this.startHeight = startHeight; this.acc = MuHash3072.fromValue(startValue);
    this.created = []; this.createdSet = new Set(); this.spent = []; this.spentSet = new Set();
    this.blocks = 0; this.txs = 0; this.spentInEpoch = 0;
  }
  // returns null, or the key of an input whose coin could not be found
  block(k, block, height, utxo) {
    this.height = height;
    const here = new Map();
    for (let i = 0; i < block.transactions.length; i++) {
      const tx = block.transactions[i]; const txid = k.codec.txid(tx);
      if (i > 0) for (const inp of tx.inputs) {
        const key = keyOf(inp.prevout);
        const coin = here.get(key) ?? utxo.get(key);
        if (!coin) return key;
        here.delete(key);
        this.acc.remove(coinBytes(key, coin));
        if (this.createdSet.has(key)) this.spentInEpoch++;
        else if (!this.spentSet.has(key)) { this.spentSet.add(key); this.spent.push(spentRecord(key, coin)); }
      }
      tx.outputs.forEach((output, vout) => {
        if (!spendable(output)) return;
        const key = `${txid}:${vout}`; const coin = { outpoint: { txid, vout }, output, height: this.height, coinbase: i === 0 };
        here.set(key, coin); this.created.push(key); this.createdSet.add(key);
        this.acc.insert(coinBytes(key, coin));
      });
    }
    this.blocks++; this.txs += block.transactions.length;
    return null;
  }
  // which created outputs the set still holds once the last block is applied
  hints(utxo) { return this.created.map((key) => (utxo.has ? utxo.has(key) : utxo.get(key) !== undefined) ? 1 : 0); }
  value() { return this.acc.value(); }
}

export function makePackage({ chain, alias, start, end, tally, hints, built }) {
  return {
    '@context': CONTEXT, '@type': TYPE, network: alias, chain,
    start: { height: start.height, hash: start.hash, coins: start.coins, muhash: digestOf(start.value), value: valueHex(start.value) },
    end: { height: end.height, hash: end.hash, coins: end.coins, muhash: digestOf(end.value), value: valueHex(end.value) },
    outputs: tally.created.length, unspent: hints.reduce((n, b) => n + b, 0), hints: toBase64(bitsToBytes(hints)),
    spent: tally.spent,
    blocks: { count: tally.blocks, txs: tally.txs },
    built,
  };
}

// the file: one line per top-level field, one line per side-data record, so a diff reads
export function packageText(pkg) {
  const lines = Object.entries(pkg).map(([k, v]) => k === 'spent' ? ` "spent": [${v.length ? '\n' + v.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n ' : ''}]` : ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

// Verify one package from its blocks alone. `blocks(h)` returns the decoded block at h, `headers`
// every header from `headersFrom` to end.height (for difficulty and median time), in order.
// Returns { ok, checks, stats, why }.
export function verifyEpoch(k, pkg, { blocks, headers, headersFrom, log = () => {} }) {
  const checks = {}; const fail = (why) => ({ ok: false, checks, why });
  if (pkg['@type'] !== TYPE) return fail(`not an ${TYPE}`);
  const from = pkg.start.height + 1, to = pkg.end.height;
  if (headersFrom > from - 11 || headers.length !== to - headersFrom + 1) return fail(`headers must cover ${from - 11}..${to}`);
  // the side data plays the set
  const utxo = new Map(); const side = new Set();
  for (const r of pkg.spent) { const c = recordCoin(r); if (c.height > pkg.start.height) return fail(`side data coin ${r[0]} was created inside the epoch`); if (utxo.has(r[0])) return fail(`side data repeats ${r[0]}`); utxo.set(r[0], c); side.add(r[0]); }
  checks.sideData = pkg.spent.length;
  const tally = new EpochTally({ startHeight: pkg.start.height, startValue: valueFromHex(pkg.start.value) });
  if (digestOf(tally.acc.value()) !== pkg.start.muhash) return fail('start value and start digest disagree');
  // headers: the chain links, ends on the end hash, and every header passes the kernel's rules
  const hv = k.headers.validateChain(headers.slice(from - headersFrom), { startHeight: from, prevContext: headers.slice(0, from - headersFrom), now: Math.floor(Date.now() / 1000) + 7200 });
  const bad = hv.filter((v) => !v.ok); if (bad.length) return fail(`header ${bad[0].height} failed: ${bad[0].results.filter((r) => r.ok === false).map((r) => r.rule).join(', ')}`);
  checks.headers = hv.length;
  let prev = pkg.start.hash, t0 = performance.now();
  for (let h = from; h <= to; h++) {
    const block = blocks(h); const hash = k.codec.blockHash(block.header);
    if (block.header.prevBlockHash !== prev) return fail(`block ${h} does not link to ${prev}`);
    if (hash !== hv[h - from].hash) return fail(`block ${h} is not the header validated at ${h}`);
    const s = k.blocks.validateBlockStructure(block);
    const mtp = k.headers.medianTimePast(headers.slice(h - 11 - headersFrom, h - headersFrom));
    const c = k.blocks.validateBlockContext(block, { height: h, utxo, mtp });
    if (!s.ok || !c.ok) return fail(`block ${h} failed: ${[...s.results, ...c.results].filter((r) => r.ok === false).map((r) => r.rule).join(', ')}`);
    // every input must have resolved against the side data or the epoch's own outputs: the kernel lets an unknown coin through as unverified, the tally does not
    const missing = tally.block(k, block, h, utxo); if (missing) return fail(`block ${h} spends ${missing}, which is in neither the side data nor the epoch`);
    k.blocks.applyBlock(utxo, block, h);
    prev = hash;
    if ((h - from) % 500 === 499) log(`  verified to ${h}, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  if (prev !== pkg.end.hash) return fail(`the chain ends at ${prev}, the package says ${pkg.end.hash}`);
  checks.blocks = tally.blocks; checks.txs = tally.txs;
  for (const key of side) if (utxo.has(key)) return fail(`side data coin ${key} was not spent in the epoch`);
  checks.sideDataConsumed = true;
  if (tally.created.length !== pkg.outputs) return fail(`the epoch created ${tally.created.length} outputs, the package says ${pkg.outputs}`);
  const hints = bytesToBits(fromBase64(pkg.hints), pkg.outputs); const ours = tally.hints(utxo);
  for (let i = 0; i < ours.length; i++) if (ours[i] !== hints[i]) return fail(`hint ${i} (${tally.created[i]}) says ${hints[i] ? 'unspent' : 'spent'}, the blocks say ${ours[i] ? 'unspent' : 'spent'}`);
  checks.hints = ours.length;
  const unspent = ours.reduce((n, b) => n + b, 0);
  if (pkg.end.coins !== pkg.start.coins + unspent - pkg.spent.length) return fail(`coin count: ${pkg.start.coins} + ${unspent} − ${pkg.spent.length} ≠ ${pkg.end.coins}`);
  checks.coins = pkg.end.coins;
  const value = tally.value();
  if (valueHex(value) !== pkg.end.value) return fail('the product of created over spent coins does not reach the end value');
  if (digestOf(value) !== pkg.end.muhash) return fail('end value and end digest disagree');
  checks.muhash = pkg.end.muhash;
  return { ok: true, checks, stats: { blocks: tally.blocks, txs: tally.txs, created: tally.created.length, unspent, spentOlder: pkg.spent.length, spentInEpoch: tally.spentInEpoch, ms: Math.round(performance.now() - t0) } };
}
