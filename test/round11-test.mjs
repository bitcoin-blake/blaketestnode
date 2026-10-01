// The publisher's newest signed word stands (even lower: a reorg to a shorter, heavier branch), an older one replayed does
// not; the height a signed tip has vouched for; block times at most two hours ahead.   node test/round11-test.mjs
import { higherTip, newer, judgeTip, nextVouched } from '../lib/nip333.mjs';
import { ChainNode } from '../lib/node.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

const tip = (height, created_at, hashes = [`h${height - 1}`, `h${height}`]) => ({ height, hash: hashes.at(-1), first: height - hashes.length + 1, hashes, created_at });
{
  const held = tip(105, 1000);
  const shorter = tip(103, 1200, ['x102', 'x103']); // signed later, lower: the publisher reorganised to a shorter branch
  const replay = tip(103, 900, ['h102', 'h103']); // an older event a relay still holds
  t('a newer signed tip at a lower height replaces the held one (a reorg to a shorter branch does not lock the tab out)', higherTip(held, shorter) === shorter);
  t('an older event replayed at a lower height is refused', higherTip(held, replay) === held);
  t('an older event even at a higher height is refused (the newest word stands)', higherTip(held, tip(107, 950)) === held);
  t('the same tip again keeps the held one; nothing fresh keeps it too', higherTip(held, { ...held }).hash === held.hash && higherTip(held, null) === held);
  t('newer: created_at first, then height', newer({ height: 1, created_at: 2 }, { height: 9, created_at: 1 }) && newer({ height: 5, created_at: 2 }, { height: 4, created_at: 2 }) && !newer({ height: 4, created_at: 2 }, { height: 4, created_at: 2 }));
}
{
  const t1 = tip(104, 1, ['a100', 'a101', 'a102', 'a103', 'a104']);
  const applied = { 100: 'a100', 101: 'a101', 102: 'a102' };
  const j = judgeTip(t1, { applied: (h) => applied[h] });
  t('judged: the highest applied height matched to a signed header', j.agree === 3 && j.highest === 102 && !j.diverged && j.firstDiverged === null);
  const jd = judgeTip(t1, { applied: (h) => ({ ...applied, 102: 'zz' })[h] });
  t('...and the first height where it differs', jd.diverged && jd.firstDiverged === 102 && jd.highest === 101);
  t('vouched rises with matches and never falls for a tip that just does not cover the blocks', nextVouched(null, j) === 102 && nextVouched(105, j) === 105 && nextVouched(102, { highest: null, firstDiverged: null }) === 102);
  t('...and is capped below the first height that differs', nextVouched(105, jd) === 101 && nextVouched(null, { firstDiverged: 102 }) === null);
}
{
  // applyNext hands the kernel the present time: the kernel adds its own 2-hour allowance (it was added twice: 4 hours)
  let seen = null;
  const k = { codec: { decode: () => ({ header: { prevBlockHash: 'p' }, transactions: [] }), blockHash: () => 'h' }, headers: { validateChain: (_, ctx) => { seen = ctx.now; return [{ ok: false, results: [{ ok: false, rule: 'stop' }] }]; } } };
  const node = new ChainNode({ k, utxo: new Map(), epochStart: 0, log: () => {} });
  node.height = 9; node.chain = { 9: 'p' }; node.headers = [];
  try { node.applyNext(10, '00'); } catch {}
  const now = Math.floor(Date.now() / 1000);
  t('block times are checked against now, not now + 2 h (the kernel allows 2 h on top)', seen != null && Math.abs(seen - now) <= 2, String(seen - now));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
