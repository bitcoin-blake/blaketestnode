// A web miner (datstr SPEC 6.3): the node that built the block is also the gateway that signs the
// share. It is its own master (a miner descriptor, kind 33401, paying its script), speaks the
// coordinator's socket (hello, welcome, split, assignment, ack), builds each height's block from
// its own node with the split it was told, hashes the header, and signs a kind 23400 share that
// carries the header, the coinbase and the merkle path, so a verifier rebuilds the commitment
// from the block this miner built. No node imports: a tab runs this; a test runs it in Node.
import { buildTemplate, checkTemplate } from './template.mjs';
export const KIND = { share: 23400, ack: 23401, assignment: 23402, split: 23403, pool: 33400, miner: 33401 };
const ZERO8 = '00'.repeat(8);
const hex32 = (n) => { const b = new Uint8Array(32); let q = n; for (let i = 31; i >= 0 && q > 0n; i--) { b[i] = Number(q & 0xffn); q >>= 8n; } return b; };
export const meets = (hash, target) => { for (let i = 0; i < 32; i++) { if (hash[i] < target[i]) return true; if (hash[i] > target[i]) return false; } return true; };
// the 80 bytes an ASIC hashes for a v2 header: [hidden prev 32][nonce field 8][ntime field 8][work root 32], work root = blake2b(0x00 ‖ coinb1 ‖ extranonce)
export function workBytes({ blake2b, hash }, { prevBlockHash, h2, extranonce }) {
  const { taggedHash, hexToBytes } = hash; const prevHidden = taggedHash('Bitcoin prevblock header, hashed', hexToBytes(prevBlockHash)); prevHidden.fill(0, 0, 6);
  const leaf = new Uint8Array(52); leaf.set(hexToBytes('000000' + h2), 1); leaf.set(hexToBytes(extranonce), 36); const root = blake2b(leaf, 32);
  const w = new Uint8Array(80); w.set(prevHidden, 0); w.set(root, 48); return w; // nonce and ntime fields zero; the miner writes the nonce at 32
}

// { k, hash, pow, blake2b, signer, node, mempool, key, payScript, chain, url, agent, log, now }
export function makeWebMiner({ k, hash, pow, blake2b, signer, node, mempool = null, key, payScript, chain, url, agent = 'blaketestnode-webminer/0.1', log = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  const { hexToBytes, bytesToHex } = hash; const pub = signer.pubkeyOf(key);
  const sign = (kind, tags, content) => { const ev = { pubkey: pub, created_at: now(), kind, tags, content: typeof content === 'string' ? content : JSON.stringify(content) }; ev.id = bytesToHex(hash.sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])))); ev.sig = bytesToHex(signer.schnorrSign(hexToBytes(ev.id), key)); return ev; };
  const contentOf = (ev) => { try { return JSON.parse(ev.content); } catch { return null; } };
  const descriptor = sign(KIND.miner, [['d', pub], ['chain', chain]], { chain, payout: { [chain]: payScript } });
  const st = { connected: false, pool: null, splits: new Map(), assignment: null, acked: 0, refused: 0, lastAck: null, sent: 0, ws: null, backoff: 1000, closed: false, blocksFound: 0 };
  const listeners = new Set(); const emit = (m) => { for (const f of listeners) { try { f(m); } catch {} } };
  function connect() {
    if (st.closed || !url) return; let ws; try { ws = new WebSocket(url); } catch (e) { log(`pool: ${e.message}`); return setTimeout(connect, st.backoff); }
    st.ws = ws;
    ws.onopen = () => { st.connected = true; st.backoff = 1000; ws.send(JSON.stringify({ type: 'hello', descriptor, agent })); log(`pool: connected to ${url} as ${pub.slice(0, 16)}… (my own master)`); };
    ws.onmessage = async (e) => {
      let m; try { const d = e.data; m = JSON.parse(typeof d === 'string' ? d : typeof d?.text === 'function' ? await d.text() : new TextDecoder().decode(d)); } catch { return; }
      if (m.type === 'welcome') { st.pool = m.pool; if (m.split) onSplit(m.split); log(`pool: welcome from ${m.pool?.pubkey?.slice(0, 16)}…`); }
      else if (m.type === 'split') onSplit(m.event);
      else if (m.type === 'assignment') { const c = contentOf(m.event); if (!c || c.chain !== chain || c.master !== pub) return; st.assignment = { id: m.event.id, target: c.target.toLowerCase(), targetBytes: hexToBytes(c.target), from: Number(c.from ?? 0), difficulty: c.difficulty }; log(`pool: assignment difficulty ${c.difficulty} from h${c.from}`); emit({ type: 'assignment', ...st.assignment }); }
      else if (m.type === 'ack') { const c = contentOf(m.event) ?? {}; st.lastAck = c; if (c.result === 'ok') st.acked++; else st.refused++; emit({ type: 'ack', ...c }); log(`pool: ack ${c.result}${c.weight ? ` weight ${c.weight}` : ''}${c.seq ? ` #${c.seq}` : ''}${c.detail ? ` (${c.detail})` : ''}`); }
      else if (m.type === 'error') log(`pool: error ${m.error}`);
    };
    ws.onclose = () => { st.connected = false; st.ws = null; st.backoff = Math.min(st.backoff * 2, 30000); if (!st.closed) setTimeout(connect, st.backoff); };
    ws.onerror = () => {};
  }
  function onSplit(ev) { const c = contentOf(ev); if (!c || c.chain !== chain) return; st.splits.set(c.height, { id: ev.id, outputs: Array.isArray(c.outputs) ? c.outputs : [] }); for (const h of [...st.splits.keys()]) if (h < c.height - 4) st.splits.delete(h); log(`pool: split for h${c.height}, ${c.outputs?.length ?? 0} outputs`); emit({ type: 'split', height: c.height, id: ev.id }); }
  // the block for the next height, from this node: the split if the coordinator sent one for it (an
  // empty split or none: pay myself alone; none is a solo receipt), the commitment for my key
  function build() {
    const height = node.height + 1; const sp = st.splits.get(height);
    const b = buildTemplate({ k, hash, node, mempool, payScripts: [payScript], splitRaw: sp && sp.outputs.length ? sp.outputs : null, worker: pub, now: now() });
    const c = checkTemplate({ k, node, block: b.block, height }); if (!c.ok) throw new Error(`my own block fails ${c.failed.join(', ')}`);
    const d = pow.hashHeaderV2Detailed(b.header); const extranonce = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const netTarget = hex32(k.codec.expandCompact(b.bits));
    return { ...b, splitId: sp ? sp.id : 'solo', h2: d.h2, extranonce, work: workBytes({ blake2b, hash }, { prevBlockHash: b.prevHash, h2: d.h2, extranonce }), netTarget, shareTarget: st.assignment?.targetBytes ?? null };
  }
  // a nonce the miner found on `job.work` (nonce2: the second word the miner rolled, bytes 36..39 of the work): the full header, the hashes, the signed share
  function share(job, nonce, nonce2 = 0) {
    const header = { ...job.header, nonce, nonce2, nonce3: 0, timeOffset: 0, extranonce: job.extranonce };
    const d = pow.hashHeaderV2Detailed(header); const powBytes = hexToBytes(d.blake2b2), hashBytes = hexToBytes(d.blockHash);
    const target = job.splitId === 'solo' || !st.assignment ? null : st.assignment; const targetHex = target ? target.target : bytesToHex(job.netTarget);
    if (!meets(powBytes, hexToBytes(targetHex))) return { ok: false, reason: 'below the share target', powHex: d.blake2b2 };
    const isBlock = meets(hashBytes, job.netTarget); const blockHex = isBlock ? k.codec.encodeHex('Block', { header, transactions: job.block.transactions }) : null;
    const ev = sign(KIND.share, [['chain', chain], ['h', String(job.height)], ['split', job.splitId]], { chain, height: job.height, header: k.codec.encodeHex('BlockHeader', header), coinbase: k.codec.encodeHex('Transaction', job.coinbase), branches: job.branches, target: targetHex, ...(target ? { assignment: target.id } : {}), split: job.splitId, parents: [], job: `web-${job.height}`, ...(blockHex ? { block: blockHex } : {}) });
    if (isBlock) st.blocksFound++;
    return { ok: true, event: ev, header, hash: d.blockHash, powHex: d.blake2b2, isBlock, blockHex };
  }
  function send(ev) { if (!st.connected || !st.ws) return false; st.ws.send(JSON.stringify({ type: 'share', event: ev })); st.sent++; return true; }
  connect();
  return { pub, descriptor, state: st, build, share, send, on: (f) => { listeners.add(f); return () => listeners.delete(f); }, close() { st.closed = true; try { st.ws?.close(); } catch {} } };
}
