// The sync's word on the signed tip, by the pure functions the worker calls: a refusal is asked again on its own (a minute,
// doubling to ten) so silent relays on a cold link do not stop the node for good; the fetch comes due after ten minutes, a
// forced one at most once a minute; a held newer tip is never replaced by an older forced fetch; a live tip moves the time of
// the last word and asks for a sync only when it is taken; the real time is the clock less the skew; the live subscription's
// look-back and too-new bound use the skew; a wipe that fails is said as a fatal 'message' by the loader; a request's error
// names the request.
//   node test/round14-test.mjs
import { readFileSync } from 'node:fs';
import { settleOrRefuse, takesTip, sameWord, liveTipStep, realNowOf, subscribeTip, TIP_FETCH_MS, FORCE_MS } from '../lib/nip333.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

const H = (h, x) => `${x}${h}`.padStart(64, '0');
const now = Math.floor(Date.now() / 1000), NOW = Date.now();
const kept = { height: 1000, hash: H(1000, 'a'), first: 991, hashes: Array.from({ length: 10 }, (_, i) => H(991 + i, i === 9 ? 'a' : 'c')), created_at: now - 3600 };
const fresh = { height: 1001, hash: H(1001, 'b'), first: 992, hashes: Array.from({ length: 10 }, (_, i) => H(992 + i, 992 + i < 1000 ? 'c' : 'b')), created_at: now - 60 };
const served = (h) => (h < 1000 ? H(h, 'c') : H(h, 'b'));
const never = async () => { throw new Error('not asked'); };
{ // the first sync with the relays silent: refused, and a retry is planned
  let calls = 0; const silent = async () => { calls++; return null; };
  const p = await settleOrRefuse({ held: kept, tipAt: null, forcedAt: null, now: NOW, fetch: silent, served });
  t('first sync, relays silent: refused at the first differing height, with the kept tip said', p.refuseAt === 1000 && p.refuseTip === kept && p.setTip === null && calls === 1);
  t('...a retry is planned a minute out (not left to a publish, a wake or a reload)', p.retryMs === FORCE_MS);
  t('...the fetch counts as the last word (the ten-minute fetch is not due again at once); no forced fetch was spent', p.tipAt === NOW && p.forcedAt === null && p.due === true);
  const p2 = await settleOrRefuse({ held: kept, tipAt: p.tipAt, forcedAt: p.forcedAt, now: NOW + FORCE_MS + 1, fetch: async () => fresh, served, refusedN: 1 });
  t('the retry a minute later forces a fetch (none due), the newer tip is taken and nothing is refused', p2.due === false && p2.setTip === fresh && p2.refuseAt === null && p2.retryMs === null && p2.forcedAt === NOW + FORCE_MS + 1);
  const backoff = await Promise.all([0, 1, 2, 3, 4, 9].map(async (n) => (await settleOrRefuse({ held: kept, tipAt: NOW, forcedAt: NOW, now: NOW + 1, fetch: never, served, refusedN: n })).retryMs));
  t('retries double from a minute and stop at ten', JSON.stringify(backoff) === JSON.stringify([60_000, 120_000, 240_000, 480_000, 600_000, 600_000]), JSON.stringify(backoff));
}
{ // the once-a-minute limit and the ten-minute due
  const within = await settleOrRefuse({ held: kept, tipAt: NOW - 1000, forcedAt: NOW - FORCE_MS + 1000, now: NOW, fetch: never, served });
  t('within a minute of a forced fetch, a disagreement stands without asking again', within.refuseAt === 1000 && within.forcedAt === NOW - FORCE_MS + 1000 && within.tipAt === NOW - 1000);
  let n = 0; const after = await settleOrRefuse({ held: kept, tipAt: NOW - 1000, forcedAt: NOW - FORCE_MS - 1, now: NOW, fetch: async () => { n++; return null; }, served });
  t('...after the minute, one forced fetch, and its time noted', n === 1 && after.forcedAt === NOW && after.tipAt === NOW);
  let m = 0; const agree = await settleOrRefuse({ held: fresh, tipAt: NOW - TIP_FETCH_MS + 1000, now: NOW, fetch: async () => { m++; return fresh; }, served });
  t('a held tip that agrees costs no fetch before ten minutes have passed since the last word', m === 0 && agree.due === false && agree.refuseAt === null && agree.retryMs === null);
  const due = await settleOrRefuse({ held: fresh, tipAt: NOW - TIP_FETCH_MS - 1, now: NOW, fetch: async () => { m++; return fresh; }, served });
  t('...past ten minutes a fetch is due, and it is not counted as a forced one', m === 1 && due.due === true && due.tipAt === NOW && due.forcedAt === null);
}
{ // a forced fetch that returns an older word than the held tip never replaces it
  const wrong = { ...fresh, hash: H(1001, 'd'), hashes: fresh.hashes.map((x, i) => (i === 9 ? H(1001, 'd') : x)) }; // the newer word, disagreeing
  const p = await settleOrRefuse({ held: wrong, tipAt: NOW - 1000, forcedAt: null, now: NOW, fetch: async () => kept, served });
  t('forced fetch, the relays hand an older tip: the held newer word stands (refused at its own height), the old one is not taken', p.setTip === null && p.refuseTip === wrong && p.refuseAt === 1001);
}
{ // taking a tip, and the live callback's step
  t('a later word is taken; an older one, none, or one dated past the real time is not', takesTip(kept, fresh) && !takesTip(fresh, kept) && !takesTip(fresh, null) && !takesTip(kept, { ...fresh, created_at: now + 86_400 }));
  t('...the same word heard again is taken (its live copy) but is the same word, not news; a later or another word is not the same', takesTip(fresh, { ...fresh, live: true }) && sameWord(fresh, { ...fresh, live: true }) && !sameWord(kept, fresh) && !sameWord(fresh, { ...fresh, created_at: fresh.created_at + 1 }) && !sameWord(null, fresh));
  t('...the too-new bound by the real time handed in', takesTip(kept, { ...fresh, created_at: now + 86_400 }, Date.now() + 86_400_000));
  const s1 = liveTipStep({ taken: false, nodeHeight: null, height: 2000, now: NOW });
  t('a live event refused (replayed, older) moves no time and asks for no sync', s1.tipAt === null && s1.sync === false);
  const s2 = liveTipStep({ taken: true, nodeHeight: null, height: 900, now: NOW });
  t('a live tip taken before anything is applied (a first sync refused) asks for a sync', s2.tipAt === NOW && s2.sync === true);
  t('...taken above the applied height asks for one; at or below it does not', liveTipStep({ taken: true, nodeHeight: 1000, height: 1001 }).sync === true && liveTipStep({ taken: true, nodeHeight: 1001, height: 1001 }).sync === false);
  t('the real time is the clock less the skew (seconds, + when the clock is fast); none or junk is no skew', realNowOf(10_000, 3) === 7_000 && realNowOf(10_000, -2) === 12_000 && realNowOf(10_000) === 10_000 && realNowOf(10_000, 'x') === 10_000);
}
{ // subscribeTip over a stand-in relay: the look-back and the too-new bound by the skew
  const sent = []; let sock = null;
  globalThis.WebSocket = class { constructor(url) { this.url = url; sock = this; setTimeout(() => this.onopen?.(), 1); } send(x) { sent.push(JSON.parse(x)); } close() {} };
  const k = { codec: { decode: (_, hex) => ({ hex }), blockHash: (h) => h.hex.slice(0, 8) } };
  const ev = (height, created_at) => ({ pubkey: 'P', created_at, tags: [['tip', String(height)]], content: 'eeeeeeee' + '0'.repeat(152) });
  for (const [skew, label] of [[0, 'a tab with no skew'], [-3600, 'a tab whose clock is an hour slow']]) {
    sent.length = 0; const got = [];
    const sub = await subscribeTip(k, { d: 'x', pubkey: 'P', relays: ['r'] }, (tip) => got.push(tip), { nostr: { verifyNostrEvent: () => true }, skewS: () => skew });
    await new Promise((r) => setTimeout(r, 10));
    const since = sent[0]?.[2]?.since, want = Math.floor(Date.now() / 1000) - Math.max(600, Math.abs(skew) + 600);
    t(`${label}: the subscription looks back by the skew too (since ${want - Math.floor(Date.now() / 1000)} s)`, Math.abs(since - want) <= 1, `since ${since}, want ${want}`);
    sock.onmessage({ data: JSON.stringify(['EVENT', 'live', ev(1002, now + 1800)]) });
    t(`${label}: an event half an hour past this clock is ${skew ? 'taken (the real time is an hour later)' : 'refused'}`, got.length === (skew ? 1 : 0));
    sub.close();
  }
}
{ // the loader: a wipe that fails twice is said as a fatal 'message' (a stand-in worker that never answers)
  const ROOT = new URL('../', import.meta.url);
  globalThis.Worker = class { postMessage() {} terminate() {} }; globalThis.addEventListener ??= () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(readFileSync(new URL(String(u).replace('https://x.test/n/', ''), ROOT)));
  const { createTabNode } = await import('../browser/tabnode.js');
  const tn = createTabNode({ base: 'https://x.test/n', snapshotUrl: 'https://x.test/s', blocksUrl: 'https://x.test/b-blocks' });
  const msgs = [], errs = []; tn.on('message', (m) => msgs.push(m)); tn.on('error', (m) => errs.push(m));
  t('the stand-in loader starts (the real worker code fetched and checked by hash)', (await tn.start({ force: true })) === true);
  let rejected = null; try { await tn.wipe({ timeoutMs: 30 }); } catch (e) { rejected = e.message; }
  const fatal = msgs.find((m) => m.type === 'error' && m.fatal);
  t('a wipe neither worker answers rejects, and the loader emits a fatal error as a message and as an error', !!rejected && !!fatal && errs.some((m) => m.fatal), rejected ?? 'resolved');
  t('...the node is left in phase error, not synced, with the reason', tn.node.phase === 'error' && tn.node.synced === false && /did not wipe/.test(tn.node.error ?? ''));
  globalThis.fetch = realFetch;
}
{ // text checks for what runs only in a browser
  const w = readFileSync(new URL('../browser/worker.js', import.meta.url), 'utf8'), l = readFileSync(new URL('../browser/tabnode.js', import.meta.url), 'utf8');
  const sync = w.slice(w.indexOf('async function sync('), w.indexOf('// rollback if the served chain diverged'));
  const at = (re) => { const m = re.exec(sync); return m ? m.index : -1; };
  const plan = at(/await applyPlan\(chain, plan, \{ take: setTip, retry: \(ms\) => \{ clearTimeout\(chain\.retryTimer\); chain\.retryTimer = setTimeout\(/), refuse = at(/refuse: refuseServed \}\);/), settle = at(/const plan = await settleOrRefuse\(/);
  t('the worker applies the plan through applyPlan (the times, the tip, a refusal with its retry), right after settling it', settle >= 0 && plan >= 0 && refuse >= 0 && settle < plan && plan < refuse);
  t('...the live callback goes through liveTipOn with setTip; a wipe clears the retry', /liveTipOn\(chain, tipFrom\(t, k, true\), \{ take: setTip, judge: judgeTip, later: /.test(sync) && /m\.type === 'wipe'\) \{[^\n]*clearTimeout\(chain\.retryTimer\)/.test(w));
  t('a request\'s error names the request; the loader does not take it for the node\'s state unless the node\'s files failed', /\.\.\.\(m\.req != null \? \{ req: m\.req \} : \{\}\)/.test(w) && /node\.synced && !storageFault\(m\) && \(m\.req != null \|\|/.test(l));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
