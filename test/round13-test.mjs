// A kept signed tip the chain has moved past (a reorg while the tab was closed) does not wedge the node: the relays are asked
// before a disagreement stands; only the publisher's later word is held against the served chain, so stale relays raise none;
// the too-new bound and the early settle of a fetch go by the real time and the tip held; tip.json and a change of block
// source are judged by the same functions the worker calls.
//   node test/round13-test.mjs
import { readFileSync } from 'node:fs';
import { settleTip, keptTip, sourceVouched, fetchTip, higherTip, servedDisagreement } from '../lib/nip333.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

// the wedge: tip.json kept the publisher's tip at 1000 = A (headers 991..1000); while the tab was closed 1000 was orphaned, and
// the mirror now serves 1000' and 1001'. The publisher's newer tip is at 1001' (headers 992..1001).
const H = (h, x) => `${x}${h}`.padStart(64, '0');
const now = Math.floor(Date.now() / 1000);
const kept = { height: 1000, hash: H(1000, 'a'), first: 991, hashes: Array.from({ length: 10 }, (_, i) => H(991 + i, i === 9 ? 'a' : 'c')), created_at: now - 3600 };
const fresh = { height: 1001, hash: H(1001, 'b'), first: 992, hashes: Array.from({ length: 10 }, (_, i) => H(992 + i, 992 + i < 1000 ? 'c' : 'b')), created_at: now - 60 };
const served = (h) => (h < 1000 ? H(h, 'c') : H(h, 'b'));
{
  t('the scenario: the kept tip disagrees with the served chain at 1000', (await servedDisagreement(kept, served)) === 1000);
  let calls = 0; const fetch = async () => { calls++; return fresh; };
  const r = await settleTip({ held: kept, due: false, fetch, served });
  t('a kept tip that disagrees is not final: the relays are asked, the newer tip wins, nothing disagrees', r.tip === fresh && r.at === null && r.fetched && calls === 1);
  const none = await settleTip({ held: kept, due: false, fetch: async () => null, served });
  t('...with no relay answering, the disagreement stands (refused, not followed)', none.tip === kept && none.at === 1000 && none.fetched);
  const later = await settleTip({ held: kept, due: false, mayForce: false, fetch: async () => { throw new Error('not asked'); }, served });
  t('...and within the minute after a forced fetch, it stands without asking again', later.at === 1000 && !later.fetched);
  const agreeing = await settleTip({ held: fresh, due: false, fetch: async () => { throw new Error('not asked'); }, served });
  t('a held tip that agrees costs no fetch when none is due', agreeing.tip === fresh && agreeing.at === null && !agreeing.fetched);
  const wrongNewer = { ...fresh, created_at: now - 30, hashes: fresh.hashes.map((x, i) => (i === 9 ? H(1001, 'd') : x)), hash: H(1001, 'd') };
  const bad = await settleTip({ held: kept, due: false, fetch: async () => wrongNewer, served });
  t('a newer signed tip that still disagrees is refused at its first differing height', bad.tip === wrongNewer && bad.at === 1001);
}
{ // stale relays: two of them hand the old tip (A at 1000); the held tip is the newer word (1001')
  const r = await settleTip({ held: fresh, due: true, fetch: async () => kept, served });
  t('an older tip from the relays is never held against the chain: the held newer tip wins, no disagreement', r.tip === fresh && r.at === null && r.fetched);
  t('...and higherTip keeps the newer word over an older higher one', higherTip(fresh, { ...kept, height: 5000 }) === fresh);
  const fut = { ...fresh, created_at: now + 86_400 };
  t('a too-new tip is judged by the real time handed in: refused by a tab that knows its clock, taken by one told it is slow', higherTip(kept, fut, Date.now()) === kept && higherTip(kept, fut, Date.now() + 86_400_000) === fut);
}
{ // tip.json as the worker reads it
  const j = { ...fresh, vouchedTo: 1001, source: 'https://m/a-blocks' };
  const a = keptTip(j, 'https://m/a-blocks');
  t('a well-formed kept tip is taken, with its vouched height for the same block source', a?.tip.height === 1001 && a.tip.relay === 'this tab (kept)' && a.tip.live === false && a.vouchedTo === 1001);
  t('...counted against another block source, the vouched height is dropped; a file from before sources were noted keeps it', keptTip(j, 'https://m/b-blocks').vouchedTo === null && keptTip({ ...j, source: undefined }, 'https://m/b-blocks').vouchedTo === 1001);
  t('...a vouched height above the kept tip is capped at it', keptTip({ ...j, vouchedTo: 1500 }, 'https://m/a-blocks').vouchedTo === 1001);
  t('...a run of headers that does not end at the tip, or none, is refused', keptTip({ ...j, height: 1002 }, 'x') === null && keptTip({ ...j, hashes: [] }, 'x') === null && keptTip(null, 'x') === null);
  t('...a kept tip dated past the real time is refused; the same tip on a tab told its clock is slow is kept', keptTip({ ...j, created_at: now + 3600 }, 'https://m/a-blocks') === null && keptTip({ ...j, created_at: now + 3600 }, 'https://m/a-blocks', Date.now() + 3_600_000) !== null);
  t('a sync asked of another block source starts from nothing vouched; the same or a first source keeps it', sourceVouched('https://m/a', 'https://m/b', 1001) === null && sourceVouched('https://m/a', 'https://m/a', 1001) === 1001 && sourceVouched(undefined, 'https://m/a', 1001) === 1001 && sourceVouched('https://m/a', 'https://m/a', undefined) === null);
}
{ // fetchTip over stand-in relays: each socket answers with its events after `delay` ms, then EOSE
  const plan = new Map(); globalThis.WebSocket = class { constructor(url) { this.url = url; setTimeout(() => this.onopen?.(), 1); } send() { const { events, delay } = plan.get(this.url); setTimeout(() => { for (const ev of events) this.onmessage?.({ data: JSON.stringify(['EVENT', 'tip', ev]) }); this.onmessage?.({ data: JSON.stringify(['EOSE', 'tip']) }); }, delay); } close() {} };
  const k = { codec: { decode: (_, hex) => ({ hex }), blockHash: (h) => h.hex.slice(0, 8) } };
  const nostr = { verifyNostrEvent: () => true };
  const ev = (height, created_at, mark) => ({ pubkey: 'P', created_at, tags: [['tip', String(height)]], content: (mark + '00000000').slice(0, 8) + '0'.repeat(152) });
  const cfg = (relays) => ({ d: 'x', pubkey: 'P', relays });
  plan.set('r1', { events: [ev(1000, now - 3600, 'aaaa')], delay: 5 }); plan.set('r2', { events: [ev(1000, now - 3600, 'aaaa')], delay: 5 }); plan.set('r3', { events: [ev(1001, now - 60, 'bbbb')], delay: 80 });
  const quick = await fetchTip(k, cfg(['r1', 'r2', 'r3']), { nostr, timeoutMs: 1000 });
  t('with nothing held, two relays agreeing settle the fetch early (the stand-in for the stale case)', quick?.height === 1000);
  const held = { height: 1001, created_at: now - 60 };
  const patient = await fetchTip(k, cfg(['r1', 'r2', 'r3']), { nostr, timeoutMs: 1000, held });
  t('with a newer tip held, two relays agreeing on an older event do not settle it: the relay with the newer word is heard', patient?.height === 1001 && patient.hash === 'bbbb0000');
  plan.set('f', { events: [ev(1002, now + 1800, 'cccc')], delay: 1 });
  t('an event dated half an hour past the real time is refused', (await fetchTip(k, cfg(['f']), { nostr, timeoutMs: 300 })) === null);
  t('...and taken by a tab whose clock is an hour slow, once it is told (nowMs: its clock less the skew)', (await fetchTip(k, cfg(['f']), { nostr, timeoutMs: 300, nowMs: () => Date.now() + 3_600_000 }))?.height === 1002);
}
{ // the worker and the loader call these, read as text (they run only in a browser)
  const w = readFileSync(new URL('../browser/worker.js', import.meta.url), 'utf8'), l = readFileSync(new URL('../browser/tabnode.js', import.meta.url), 'utf8');
  const sync = w.slice(w.indexOf('async function sync('), w.indexOf('// rollback if the served chain diverged'));
  t('the worker settles the tip with settleTip before any rollback or apply, and subscribes before it', /settleTip\(\{ held: chain\.tipHeaders/.test(sync) && sync.indexOf('chain.tipSub ??= await subscribeTip') < sync.indexOf('settleTip(') && sync.indexOf('settleTip(') < sync.indexOf('new ChainNode'));
  t('...fetching with the tip held and the real time; tip.json through keptTip; a source change through sourceVouched', /fetchTip\(k, CHAIN\.nip333, \{ nostr, held: chain\.tipHeaders, nowMs: realNow \}\)/.test(w) && /keptTip\(JSON\.parse\(.*\), chain\.blocksUrl, realNow\(\)\)/.test(w) && /sourceVouched\(chain\.blocksUrl, blocksUrl, chain\.vouchedTo\)/.test(sync));
  t('a wipe that fails says so: phase error, an error message, nothing left looking live', /node\.phase = 'error'; node\.synced = false; node\.error = text/.test(l) && /type: 'error', text, fatal: true/.test(l));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
