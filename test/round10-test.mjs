// The signed tip is chosen from every relay and never lowered; the context headers must chain to the snapshot base; only
// the estate's key makes a mempool entry "fed".   node test/round10-test.mjs
import { fetchTip, higherTip } from '../lib/nip333.mjs';
import { checkContextHeaders } from '../lib/node.mjs';
import { viaOf, MEMPOOL_KIND } from '../lib/mempool.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

// a fake engine: a "header" is 80 bytes of hex whose first 4 bytes name it; its hash is its name
const fakeK = { codec: { decode: (_, hex) => JSON.parse(Buffer.from(hex, 'hex').toString().replace(/\0+$/, '')), blockHash: (h) => h.id } };
const hdr = (id) => Buffer.from(JSON.stringify({ id }).padEnd(80, '\0')).toString('hex');
// relays on a stand-in WebSocket: each answers its events after `ms`, then EOSE
function fakeRelays(spec) {
  globalThis.WebSocket = class { constructor(url) { this.url = url; const r = spec[url]; setTimeout(() => this.onopen?.(), 1);
      this.send = () => { if (!r) return setTimeout(() => this.onerror?.(), 2); setTimeout(() => { for (const ev of r.events) this.onmessage?.({ data: JSON.stringify(['EVENT', 'tip', ev]) }); this.onmessage?.({ data: JSON.stringify(['EOSE', 'tip']) }); }, r.ms); }; }
    close() { setTimeout(() => this.onclose?.(), 0); } };
}
const PK = 'p'.repeat(64);
const ev = (tip, ids) => ({ pubkey: PK, created_at: tip, tags: [['tip', String(tip)]], content: ids.map(hdr).join('') });
const nostr = { verifyNostrEvent: () => true };
{
  fakeRelays({ a: { ms: 10, events: [ev(90, ['h89', 'h90'])] }, b: { ms: 150, events: [ev(100, ['h99', 'h100'])] }, c: { ms: 200, events: [ev(100, ['h99', 'h100'])] } });
  const tip = await fetchTip(fakeK, { d: 'x', pubkey: PK, relays: ['a', 'b', 'c'] }, { nostr, timeoutMs: 1000 });
  t('one fast relay holding an older tip does not win: every relay is heard, the highest verified tip is taken', tip?.height === 100 && tip.hash === 'h100', JSON.stringify(tip && { h: tip.height, r: tip.relays }));
  t('...and how many relays handed it is said', tip?.relays === 2);
}
{
  fakeRelays({ a: { ms: 10, events: [ev(90, ['h89', 'h90'])] } });
  const t0 = Date.now(); const tip = await fetchTip(fakeK, { d: 'x', pubkey: PK, relays: ['a', 'dead'] }, { nostr, timeoutMs: 300 });
  t('a tip from one relay is still a tip when the others fail', tip?.height === 90 && Date.now() - t0 < 1000);
}
{
  const kept = { height: 100, hash: 'h100', first: 99, hashes: ['h99', 'h100'], created_at: 100 }, older = { height: 90, hash: 'h90', first: 89, hashes: ['h89', 'h90'], created_at: 90 }, newer = { height: 101, hash: 'h101', first: 100, hashes: ['h100', 'h101'], created_at: 101 };
  t('the kept tip is not lowered by an older one, nor by none', higherTip(kept, older) === kept && higherTip(kept, null) === kept);
  t('a newer tip replaces it; with nothing kept, the fresh one is taken', higherTip(kept, newer) === newer && higherTip(null, older) === older);
}
{
  const ctx = { from: 10, to: 12, headers: [hdr('a'), Buffer.from(JSON.stringify({ id: 'b', prevBlockHash: 'a' }).padEnd(80, '\0')).toString('hex'), Buffer.from(JSON.stringify({ id: 'base', prevBlockHash: 'b' }).padEnd(80, '\0')).toString('hex')] };
  t('context headers that link and end at the snapshot base are taken', checkContextHeaders(fakeK, ctx, 'base').length === 3);
  const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
  t('...ones that end elsewhere are refused', throws(() => checkContextHeaders(fakeK, ctx, 'other'), /do not end at the snapshot base/));
  const broken = { ...ctx, headers: [ctx.headers[0], Buffer.from(JSON.stringify({ id: 'b', prevBlockHash: 'z' }).padEnd(80, '\0')).toString('hex'), ctx.headers[2]] };
  t('...ones that do not link are refused, and a short set too', throws(() => checkContextHeaders(fakeK, broken, 'base'), /do not link at 11/) && throws(() => checkContextHeaders(fakeK, { ...ctx, headers: ctx.headers.slice(1) }, 'base'), /2 of 3/));
}
{
  const feed = 'f'.repeat(64), other = 'o'.repeat(64);
  t('a kind 23404 event from the estate\'s key is a feed entry; anyone else\'s is a relay echo; a wallet\'s payment event is an echo', viaOf({ kind: MEMPOOL_KIND, pubkey: feed }, [feed]) === 'feed' && viaOf({ kind: MEMPOOL_KIND, pubkey: other }, [feed]) === 'relay' && viaOf({ kind: 23503, pubkey: feed }, [feed]) === 'relay');
  t('with no allowlist known, no relay event is a feed entry ("fed" comes from the mirror\'s file only)', viaOf({ kind: MEMPOOL_KIND, pubkey: other }, null) === 'relay');
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
