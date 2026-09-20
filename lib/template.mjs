// The block a web node builds for itself (datstr SPEC 6.3): from its own tip, its own mempool and
// the split it was told, the coinbase exactly as SPEC 6.1 has it, the witness commitment, the
// datstr commitment output, the merkle root and a v2 header; then every block rule the kernel
// knows is run on the result before it is handed to a miner. No node import: a tab runs this.
export const VERSION_V2 = 0xa0000000; // header v2 flag (bit 31) over the BIP9 base version
export const REDUCED_DATA_MAX_BLOCK_WEIGHT = 800000;
const ZERO16 = '00'.repeat(16), ZERO32 = '00'.repeat(32);
const heightPush = (h, bytesToHex) => { const out = []; let n = h; while (n > 0) { out.push(n & 0xff); n >>>= 8; } if (out.length && out[out.length - 1] & 0x80) out.push(0); return h >= 1 && h <= 16 ? (0x50 + h).toString(16) : bytesToHex(Uint8Array.from([out.length, ...out])); };

// the bits this chain's rules expect for the next block at `time`, from the node's own headers
export function expectedBitsAt(k, node, height, time) {
  const prev = node.headers[height - 1]; if (!prev) throw new Error(`no header at ${height - 1}`);
  const interval = k.headers.interval; const epochFirst = height % interval === 0 ? node.headers[height - interval] ?? null : null;
  const bits = k.headers.expectedBits(prev, height - 1, epochFirst, { header: { time }, chainAt: (h) => node.headers[h] ?? null });
  if (bits == null) throw new Error(`not enough header context for the difficulty at ${height}`);
  return bits;
}

// a coordinator's split (datstr 9.3) scaled to this block's value: proportions kept, rounding to the first output
export function scaleSplit(outputs, V) { const S = outputs.reduce((a, [, v]) => a + v, 0); if (S === V || S === 0) return outputs.map(([s, v]) => [s, v]); const scaled = outputs.map(([s, v]) => [s, Math.floor(v * V / S)]); scaled[0][1] += V - scaled.reduce((a, [, v]) => a + v, 0); return scaled; }
// the merkle path from the coinbase (index 0) to the root, Bitcoin style: dsha256 over internal-order hashes, odd levels duplicate their last node
export function coinbaseBranches(hash, txids) { const { dsha256, hexToBytes, bytesToHex } = hash; const rev = (h) => bytesToHex(hexToBytes(h).reverse()); const pair = (a, b) => rev(bytesToHex(dsha256(new Uint8Array([...hexToBytes(rev(a)), ...hexToBytes(rev(b))])))); const out = []; let level = txids.slice(); while (level.length > 1) { if (level.length % 2) level.push(level[level.length - 1]); out.push(level[1]); const next = []; for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1])); level = next; } return out; }

// build: { k, hash, node, mempool?, payScripts | split (scaled) | splitRaw (a coordinator's, scaled here), worker, parentsRoot, now, rdts? }
export function buildTemplate({ k, hash, node, mempool = null, payScripts = [], split = null, splitRaw = null, worker = ZERO32, parentsRoot = ZERO32, now = Math.floor(Date.now() / 1000), rdts = null } = {}) {
  const { taggedHash, hexToBytes, bytesToHex } = hash; const p = k.params;
  const height = node.height + 1; const prevHash = node.tipHash(); const mtp = node.mtp(height);
  const time = Math.max(now, mtp + 1); const bits = expectedBitsAt(k, node, height, time);
  const rdtsActive = rdts ?? (p.blake2bHeight != null && height >= p.blake2bHeight && mtp < (p.rdtsExpiryTime ?? Infinity));
  const budget = (rdtsActive ? REDUCED_DATA_MAX_BLOCK_WEIGHT : p.maxBlockWeight) - 4000; // room for the header and a coinbase of a few outputs
  // selection: the mempool's transactions by fee rate, greedily within the weight budget
  const chosen = []; let weight = 0, fees = 0;
  for (const e of mempool?.list() ?? []) { const w = k.codec.txWeight(e.tx); if (weight + w > budget) continue; chosen.push(e); weight += w; fees += e.fee; }
  const txs = chosen.map((e) => e.tx), txids = chosen.map((e) => e.txid);
  const value = k.blocks.subsidy(height) + fees;
  // the coinbase, SPEC 6.1: the split outputs, the witness commitment, the datstr commitment last
  let outputs;
  if (splitRaw && splitRaw.length) split = scaleSplit(splitRaw, value);
  if (split) outputs = split.map(([scriptPubKey, v]) => ({ value: v, scriptPubKey }));
  else { if (!payScripts.length) throw new Error('a pay script or a split is needed'); const each = Math.floor(value / payScripts.length); outputs = payScripts.map((scriptPubKey, i) => ({ value: i === 0 ? value - each * (payScripts.length - 1) : each, scriptPubKey })); }
  const paid = outputs.reduce((a, o) => a + o.value, 0); if (paid > value) throw new Error(`the split pays ${paid}, the block has ${value}`);
  const nSplit = outputs.length;
  const provisional = { version: 2, inputs: [{ prevout: { txid: ZERO32, vout: 0xffffffff }, scriptSig: '00', sequence: 0xffffffff }], outputs: [], witness: [[ZERO32]], lockTime: 0 };
  const witnessCommitment = '6a24aa21a9ed' + k.blocks.witnessCommitmentHash({ transactions: [provisional, ...txs] });
  outputs.push({ value: 0, scriptPubKey: witnessCommitment });
  const commitment = bytesToHex(taggedHash('datstr/share', hexToBytes(worker + parentsRoot)));
  outputs.push({ value: 0, scriptPubKey: '6a20' + commitment });
  const scriptSig = heightPush(height, bytesToHex) + '0400000000';
  const coinbase = { version: 2, inputs: [{ prevout: { txid: ZERO32, vout: 0xffffffff }, scriptSig, sequence: 0xffffffff }], outputs, witness: [[ZERO32]], lockTime: 0 };
  const cbTxid = k.codec.txid(coinbase);
  const header0 = { version: VERSION_V2, prevBlockHash: prevHash, merkleRoot: k.codec.merkleRoot([cbTxid, ...txids]), timeOnWire: time, bits, nonce: 0, nonce2: 0, nonce3: 0, extranonce: ZERO16, timeOffset: 0, txCount: txs.length + 1, flags: 0, xorKeyMaskClearBits: 0, xorKey: ZERO16, height, mmRhs: ZERO32 };
  // round-trip through the codec: derived fields (time) appear, and the block is proven serializable
  const hex = k.codec.encodeHex('Block', { header: header0, transactions: [coinbase, ...txs] });
  const block = k.codec.decode('Block', hex); const header = block.header; const blockHash = k.codec.blockHash(header);
  const template = { version: VERSION_V2, previousblockhash: prevHash, transactions: chosen.map((e) => ({ data: k.codec.encodeHex('Transaction', e.tx), txid: e.txid, fee: e.fee, weight: k.codec.txWeight(e.tx) })), coinbasevalue: value, height, bits: bits.toString(16).padStart(8, '0'), curtime: time, default_witness_commitment: witnessCommitment, mintime: mtp + 1 };
  return { height, prevHash, time, mtp, bits, rdtsActive, txids, branches: coinbaseBranches(hash, [cbTxid, ...txids]), fees, value, weight: k.blocks.blockWeight(block), coinbase, cbTxid, header, block, hex, hash: blockHash, commitment, nSplit, template };
}

// every rule the kernel knows, on a block that is not yet mined: the proof-of-work rule is the one
// expected to fail and is reported apart. { ok, failed: [rule], pow: true|false }
export function checkTemplate({ k, node, block, height, now = null }) {
  const prevContext = node.headers.slice(node.epochStart, height);
  const [hv] = k.headers.validateChain([block.header], { startHeight: height, prevContext, now: now ?? block.header.time + 7200 });
  const s = k.blocks.validateBlockStructure(block); const c = k.blocks.validateBlockContext(block, { height, utxo: node.utxo, mtp: node.mtp(height) });
  const failed = [...hv.results, ...s.results, ...c.results].filter((r) => r.ok === false).map((r) => r.rule);
  const pow = failed.filter((r) => r === 'btc:rule-header-pow'); const rest = failed.filter((r) => !pow.includes(r));
  return { ok: rest.length === 0, failed: rest, pow: pow.length > 0, powRules: pow };
}
