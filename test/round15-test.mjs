// The worker's tip wiring run as it runs in the worker (setTipOn, liveTipOn, applyPlan, realNowFor over a stand-in chain): a
// refusal is counted, retried (not once the node is wiped) and stopped, and the count starts again after a sync that is not
// refused; a live tip moves the time of the last word and asks for a sync only when it is taken and new; setTip judges by the
// real time (the clock less the skew), never takes an older word, and keeps the vouched height under the tip. A wipe stops the
// timers and syncs; a fault in the node's files is the node's error even when a request met it; the demo page pins the engine
// by commit under a policy that matches its script.
//   node test/round15-test.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTipOn, liveTipOn, applyPlan, realNowFor } from '../lib/nip333.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

const H = (h, x) => `${x}${h}`.padStart(64, '0');
const NOW = Date.now(), now = Math.floor(NOW / 1000);
const tip = (height, created_at, x = 'a') => ({ height, hash: H(height, x), first: height - 9, hashes: Array.from({ length: 10 }, (_, i) => H(height - 9 + i, x)), created_at });

{ // setTipOn: the later word only, judged by the real time; the vouched height under the tip; saved when it moved
  const c = { tipHeaders: null, vouchedTo: null }; let saves = 0; const save = async () => { saves++; };
  t('a first tip is taken and is news, and saved', (await setTipOn(c, tip(1000, now - 60), { save, clockMs: NOW })) === true && c.tipHeaders.height === 1000 && saves === 1);
  t('...the same word heard again is taken but is not news, and not saved again', (await setTipOn(c, tip(1000, now - 60), { save, clockMs: NOW })) === false && saves === 1);
  const before = c.tipHeaders;
  t('an older word is refused and changes nothing', (await setTipOn(c, tip(1001, now - 120, 'b'), { save, clockMs: NOW })) === false && c.tipHeaders === before && saves === 1);
  c.vouchedTo = 1005;
  t('a newer, lower tip is taken and the vouched height is brought under it, and saved', (await setTipOn(c, tip(998, now - 30, 'c'), { save, clockMs: NOW })) === true && c.vouchedTo === 998 && saves === 2);
  const ahead = tip(1010, now + 1800, 'd');
  t('a tip half an hour past this clock is refused with no skew', (await setTipOn({ tipHeaders: null }, ahead, { save, clockMs: NOW })) === false);
  const slow = { tipHeaders: null, skewS: -3600 };
  t('...and taken when this clock is an hour slow (the real time is later)', (await setTipOn(slow, ahead, { save, clockMs: NOW })) === true && slow.tipHeaders === ahead);
  t('realNowFor: the clock less the skew', realNowFor({ skewS: 30 }, NOW) === NOW - 30_000 && realNowFor({}, NOW) === NOW && realNowFor({ skewS: -3600 }, NOW) === NOW + 3_600_000);
}
{ // liveTipOn: the time of the last word and a sync only for a tip taken and new
  const run = async (c, taken, height) => { let judged = 0, later = 0; const step = await liveTipOn(c, { height }, { take: async () => taken, judge: () => judged++, later: () => later++, now: NOW }); return { step, judged, later }; };
  const c1 = { tipAt: 5, node: { height: 1000 } }; const a = await run(c1, true, 1001);
  t('a live tip taken above what is applied moves the time of the last word and asks for a sync', c1.tipAt === NOW && a.later === 1 && a.judged === 1);
  const c2 = { tipAt: 5, node: { height: 1000 } }; const b = await run(c2, false, 1001);
  t('a live tip not taken (an older word, or the same one replayed) moves nothing and asks for nothing; it is still judged', c2.tipAt === 5 && b.later === 0 && b.judged === 1);
  const c3 = { tipAt: 5, node: { height: 1000 } }; const d = await run(c3, true, 1000);
  t('a live tip taken at what is applied moves the time but asks for no sync', c3.tipAt === NOW && d.later === 0);
  const c4 = { tipAt: 5, node: null }; const e = await run(c4, true, 5);
  t('...before anything is applied, a taken tip asks for a sync', e.later === 1);
  const c5 = { tipAt: 5, node: { height: 1000 }, wiped: true }; const f = await run(c5, true, 1001);
  t('a wiped node asks for no sync', f.later === 0);
}
{ // applyPlan: a refusal counted, retried and stopped; the count starts again after a sync not refused
  const c = { tipAt: null, forcedAt: null }; const retries = [], refused = [], taken = [];
  const fx = { take: async (x) => taken.push(x), retry: (ms) => retries.push(ms), refuse: (tp, h) => { refused.push([tp, h]); throw new Error('refused'); } };
  const kept = tip(1000, now - 3600), fresh = tip(1001, now - 60, 'b');
  let threw = null; try { await applyPlan(c, { tipAt: NOW, forcedAt: null, setTip: null, refuseAt: 1000, refuseTip: kept, retryMs: 60_000 }, fx); } catch (e) { threw = e.message; }
  t('a refusal: the times taken, the count raised, a retry set with the plan\'s wait, the sync stopped by refuse', threw === 'refused' && c.tipAt === NOW && c.forcedAt === null && c.refusedN === 1 && retries.join() === '60000' && refused.length === 1 && refused[0][0] === kept && refused[0][1] === 1000);
  try { await applyPlan(c, { tipAt: NOW, forcedAt: NOW, setTip: null, refuseAt: 1000, refuseTip: kept, retryMs: 120_000 }, fx); } catch {}
  t('...a second refusal counts two and waits the plan\'s longer time', c.refusedN === 2 && retries.join() === '60000,120000' && c.forcedAt === NOW);
  await applyPlan(c, { tipAt: NOW + 1, forcedAt: NOW, setTip: fresh, refuseAt: null, refuseTip: null, retryMs: null }, fx);
  t('a sync not refused takes the plan\'s tip and starts the count again, with no retry', c.refusedN === 0 && taken[0] === fresh && retries.length === 2 && c.tipAt === NOW + 1);
  const w = { wiped: true }; try { await applyPlan(w, { tipAt: NOW, forcedAt: null, setTip: null, refuseAt: 1000, refuseTip: kept, retryMs: 60_000 }, fx); } catch {}
  t('a refusal on a wiped node sets no retry (it is still counted and stopped)', retries.length === 2 && w.refusedN === 1 && refused.length === 3);
}
{ // the loader: a request's error is that request's answer, unless the node's files failed
  const ROOT = new URL('../', import.meta.url);
  let w = null; globalThis.Worker = class { constructor() { w = this; } postMessage() {} terminate() {} }; globalThis.addEventListener ??= () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(readFileSync(new URL(String(u).replace('https://x.test/n/', ''), ROOT)));
  const { createTabNode, storageFault } = await import('../browser/tabnode.js');
  const tn = createTabNode({ base: 'https://x.test/n', snapshotUrl: 'https://x.test/s', blocksUrl: 'https://x.test/b-blocks' });
  t('the stand-in loader starts', (await tn.start({ force: true })) === true && !!w);
  w.onmessage({ data: { type: 'synced', height: 152110, hash: H(1, 'e'), applied: 0, ms: 1 } });
  w.onmessage({ data: { type: 'error', name: 'Error', text: 'Block not found', req: 'bight:s1.1' } });
  t('a lookup\'s plain error with its req does not become the node\'s error', tn.node.error == null);
  w.onmessage({ data: { type: 'error', name: 'NotFoundError', text: 'A requested file or directory could not be found', req: 'sent:ab' } });
  t('...a NotFoundError from the node\'s files does, though a request met it', /could not be found/.test(tn.node.error ?? ''));
  t('storageFault names the files\' faults only', storageFault({ name: 'NoModificationAllowedError' }) && storageFault({ name: 'QuotaExceededError' }) && !storageFault({ name: 'Error' }) && !storageFault({}) && !storageFault(null));
  globalThis.fetch = realFetch;
}
{ // text checks for what runs only in a browser: the worker calls the functions tested above, and a wipe stops what it started
  const w = readFileSync(new URL('../browser/worker.js', import.meta.url), 'utf8');
  const has = (s) => w.indexOf(s) >= 0;
  t('the worker\'s real time, setTip, live callback and plan go through the tested functions', has('const realNow = () => realNowFor(chain);') && has('const setTip = (t) => setTipOn(chain, t, { save: saveTip });') && has('(t) => liveTipOn(chain, tipFrom(t, k, true), { take: setTip, judge: judgeTip, later: () => setTimeout(() => queueSync(), 3000) })') && has('await applyPlan(chain, plan, { take: setTip, retry: (ms) => {') && has('refuse: refuseServed });'));
  const onWipe = w.slice(w.indexOf("else if (m.type === 'wipe') {")); const wipeFn = w.slice(w.indexOf('async function wipe()'), w.indexOf("post({ type: 'wiped'"));
  t('a wipe marks the node wiped first; queueSync, the timer and the live subscription bail on it; a sync asked again clears it', /^else if \(m\.type === 'wipe'\) \{ chain\.wiped = true;/.test(onWipe) && has('|| chain.wiped) return; chain.syncQueued = true;') && has('if (!chain.timer && !chain.wiped) {') && has('if (!chain.tipSub && !chain.wiped) {') && has('if (chain.wiped) sub.close(); else chain.tipSub = sub;') && has("if (m.type === 'sync') { chain.wiped = false;"));
  t('wipe() stops the timer and the retry and forgets the block source', wipeFn.indexOf('clearInterval(chain.timer); clearTimeout(chain.retryTimer);') >= 0 && wipeFn.indexOf('timer: null, retryTimer: null, blocksUrl: null') >= 0);
  t('the worker\'s errors carry the error\'s name (the loader tells the files\' faults apart by it)', (w.match(/post\(\{ type: 'error', name: err\?\.name \?\? null,/g) ?? []).length === 2);
}
{ // the demo page: the engine by commit, under a policy whose hash is the page's script, and no static import in a blob worker
  const html = readFileSync(new URL('../browser/index.html', import.meta.url), 'utf8');
  const open = '<script type="module">', a = html.indexOf(open) + open.length, b = html.indexOf('</script>', a);
  const hash = createHash('sha256').update(html.slice(a, b)).digest('base64');
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1] ?? '';
  t('the demo page pins the engine by commit, not by a tag', /schema@[0-9a-f]{40}'/.test(html) && !/schema@v\d/.test(html));
  t('...its policy comes before any script, and names its one inline script by hash', !!csp && html.indexOf('Content-Security-Policy') < html.indexOf('<script') && csp.includes(`'sha256-${hash}'`) && (html.match(/<script/g) ?? []).length === 1);
  t('...the policy refuses objects, base and form targets, and names only pinned script prefixes (no whole CDN host)', /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp) && (() => { const src = (csp.match(/script-src ([^;]*)/)?.[1] ?? '').split(/\s+/); const cdn = src.filter((x) => x.startsWith('https:')); return src.includes("'self'") && src.includes('blob:') && cdn.length >= 1 && !cdn.includes('https://cdn.jsdelivr.net') && !cdn.includes('https://cdn.jsdelivr.net/') && cdn.every((x) => x === 'https://cdn.jsdelivr.net/gh/bitcoin-blake/' || /^https:\/\/cdn\.jsdelivr\.net\/(gh\/[\w.-]+\/[\w.-]+@[0-9a-f]{40}\/|npm\/[\w.-]+@\d+\.\d+\.\d+\/)/.test(x)); })());
  const hasher = html.match(/const hasherSrc = `([\s\S]*?)`;/)?.[1] ?? '';
  t('...the hasher worker imports dynamically (a blob worker\'s static imports are refused under the policy)', !!hasher && !/^\s*import\s|;\s*import\s*\{/.test(hasher) && /await Promise\.all\(\[import\(/.test(hasher));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
