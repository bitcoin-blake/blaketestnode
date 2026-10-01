// A wipe run as it runs in the worker (stopForWipe, forgetForWipe and the guards maySync, mayArm, maySubscribe over a
// stand-in chain): the timers are cleared, nothing started before the wipe re-arms a retry, a timer, a sync or the live
// subscription, a tip heard after it leaves no tip.json, and a sync asked again starts over. The loader keeps the error's
// kind (node.errorName) beside its text, and clears both when the node is well again.
//   node test/round16-test.mjs
import { readFileSync } from 'node:fs';
import { setTipOn, liveTipOn, applyPlan, stopForWipe, forgetForWipe, maySync, mayArm, maySubscribe } from '../lib/nip333.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

const H = (h, x) => `${x}${h}`.padStart(64, '0');
const NOW = Date.now(), now = Math.floor(NOW / 1000);
const tip = (height, created_at, x = 'a') => ({ height, hash: H(height, x), first: height - 9, hashes: Array.from({ length: 10 }, (_, i) => H(height - 9 + i, x)), created_at });
const clocks = () => { const cleared = { interval: [], timeout: [] }; return { cleared, clearInterval: (x) => cleared.interval.push(x), clearTimeout: (x) => cleared.timeout.push(x) }; };
const running = () => ({ timer: 'T', retryTimer: 'R', feedTimer: 'F', refusedN: 3, tipHeaders: tip(1000, now - 60), vouchedTo: 999, beat: 1, blocksUrl: 'https://x.test/b-blocks', tipSub: null, syncing: false, syncQueued: false, node: { height: 1000 }, utxo: {}, source: {}, deltas: [1], tipAt: NOW, forcedAt: NOW });

{ // the wipe message: the timers stop, the word on the tip is dropped, the chain is marked wiped
  const c = running(), k = clocks();
  stopForWipe(c, k);
  t('stopForWipe marks the chain wiped and clears the 30 s timer, the retry and the feed timer', c.wiped === true && k.cleared.interval.includes('T') && k.cleared.timeout.includes('R') && k.cleared.interval.includes('F') && c.timer === null && c.retryTimer === null, JSON.stringify(k.cleared));
  t('...the refusal count, the held tip, the vouched height and the heartbeat are dropped', c.refusedN === 0 && c.tipHeaders === null && c.vouchedTo === null && c.beat === null);
  t('...a chain with no timer clears only the feed timer\'s interval', (() => { const d = { ...running(), timer: null }, kk = clocks(); stopForWipe(d, kk); return kk.cleared.interval.length === 1 && kk.cleared.interval[0] === 'F'; })());
}
{ // the guards: nothing started before the wipe starts the node again
  const c = running();
  t('before a wipe a sync may be queued, the timer is armed once and the live tip subscribed once', maySync(c) && !mayArm(c) && mayArm({ ...c, timer: null }) && maySubscribe(c) && !maySubscribe({ ...c, tipSub: {} }));
  stopForWipe(c, clocks());
  t('after the wipe message: no sync queued, no timer armed, no subscription', !maySync(c) && !mayArm(c) && !maySubscribe(c));
  t('...one sync at a time and none without a block source, wiped or not', !maySync({ ...running(), syncing: true }) && !maySync({ ...running(), syncQueued: true }) && !maySync({ ...running(), blocksUrl: null }));
}
{ // wipe(): the files gone, the chain forgets its source, so even a cleared flag queues nothing until the page syncs again
  const c = running(), k = clocks();
  stopForWipe(c, clocks()); forgetForWipe(c, k);
  t('forgetForWipe clears the timers again and forgets the block source, the chain and the times', k.cleared.interval.length === 1 && k.cleared.timeout.length === 1 && c.blocksUrl === null && c.node === null && c.source === null && c.deltas.length === 0 && c.tipAt === null && c.forcedAt === null && c.refusedN === 0);
  c.wiped = false;
  t('...a wiped flag cleared without a new source still queues nothing', !maySync(c));
  c.blocksUrl = 'https://x.test/b-blocks';
  t('...a sync asked again (wiped false, a source) may run, arm its timer and subscribe again', maySync(c) && mayArm(c) && maySubscribe(c));
}
{ // what was in flight when the wipe came
  const c = running(); stopForWipe(c, clocks());
  let saves = 0; const save = async () => { saves++; };
  const taken = await setTipOn(c, tip(1001, now - 30), { save, clockMs: NOW });
  t('a tip heard after the wipe is taken in memory but leaves no tip.json', taken === true && c.tipHeaders?.height === 1001 && saves === 0, `saves ${saves}`);
  const d = { tipHeaders: null, vouchedTo: null }; let s2 = 0;
  await setTipOn(d, tip(1001, now - 30), { save: async () => { s2++; }, clockMs: NOW });
  t('...the same tip on a chain not wiped is saved', s2 === 1);
  const w = { wiped: true, tipHeaders: null, vouchedTo: 1005 }; let s3 = 0;
  await setTipOn(w, tip(1001, now - 30), { save: async () => { s3++; }, clockMs: NOW });
  t('...a wiped chain whose vouched height the tip lowers keeps it in memory and saves nothing', w.vouchedTo === 1001 && s3 === 0, `vouched ${w.vouchedTo}, saves ${s3}`);
  let later = 0; await liveTipOn(c, tip(1002, now - 10), { take: async () => true, later: () => later++, now: NOW });
  t('a live tip after the wipe asks for no sync', later === 0);
  let retried = 0, refused = 0;
  await applyPlan(c, { tipAt: NOW, forcedAt: NOW, refuseAt: 1000, refuseTip: tip(1000, now - 60), retryMs: 60_000 }, { take: async () => {}, retry: () => retried++, refuse: () => refused++ });
  t('a sync refused after the wipe stops but sets no retry', refused === 1 && retried === 0);
}
{ // the loader: the error's kind beside its text, cleared when the node is well again (a stand-in worker the test speaks for)
  const ROOT = new URL('../', import.meta.url); const workers = [];
  globalThis.Worker = class { constructor() { workers.push(this); } postMessage() {} terminate() {} }; globalThis.addEventListener ??= () => {};
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => new Response(readFileSync(new URL(String(u).replace('https://x.test/n/', ''), ROOT)));
  const { createTabNode } = await import('../browser/tabnode.js');
  const tn = createTabNode({ base: 'https://x.test/n', snapshotUrl: 'https://x.test/s', blocksUrl: 'https://x.test/b-blocks' });
  await tn.start({ force: true });
  const say = (m) => workers.at(-1).onmessage({ data: m });
  t('the loader starts with no error and no error kind', tn.node.error === null && tn.node.errorName === null);
  say({ type: 'synced', height: 1000, hash: H(1000, 'a'), applied: 0 });
  say({ type: 'error', name: 'NotFoundError', text: 'A requested file or directory could not be found', req: 'x:1' });
  t('a fault in the node\'s files met by a request: the node\'s error, with its kind', /could not be found/.test(tn.node.error ?? '') && tn.node.errorName === 'NotFoundError', `${tn.node.error} / ${tn.node.errorName}`);
  say({ type: 'synced', height: 1001, hash: H(1001, 'a'), applied: 1 });
  t('...a sync clears both', tn.node.error === null && tn.node.errorName === null, `${tn.node.error} / ${tn.node.errorName}`);
  say({ type: 'error', name: 'Error', text: 'Block not found', req: 'x:2' });
  t('a request\'s own answer sets neither', tn.node.error === null && tn.node.errorName === null);
  say({ type: 'error', text: 'something with no name' });
  t('an error with no name: the text, and no kind', tn.node.error === 'something with no name' && tn.node.errorName === null);
  globalThis.fetch = realFetch;
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
