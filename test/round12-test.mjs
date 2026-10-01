// A transaction the mirror's file lists is "fed" when the file is read again, not only on the first read; a signed tip dated
// past the clock is refused; a newer, lower tip takes back the vouched height; the live tip looks back past a fast clock.
//   node test/round12-test.mjs
import { readFileSync } from 'node:fs';
import { Mempool } from '../lib/mempool.mjs';
import { higherTip, tooNew, sinceFor, vouchedUnder, nextVouched, MAX_AHEAD_S } from '../lib/nip333.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };

{ // a pool whose check is a stand-in: every hex is a valid transaction with txid = the hex
  const changes = []; const mp = new Mempool({ k: null, node: null, network: 'x', onChange: (what) => changes.push(what) });
  mp.check = (hex) => (mp.txs.has(hex) ? { ok: true, dup: true, txid: hex } : { ok: true, txid: hex, tx: { inputs: [], outputs: [] }, fee: 100, vsize: 100, feeRate: 1 });
  mp.add('aa', 'a wallet', 'relay'); mp.add('bb', 'a wallet', 'relay');
  t('a payment heard only from a relay is not fed', !mp.txs.get('aa').fed && !mp.txs.get('bb').fed);
  const n = mp.markFed(['AA', 'cc']);
  t('the file read again marks what this pool holds as fed (case-blind), and says so once', n === 1 && mp.txs.get('aa').fed && !mp.txs.get('bb').fed && changes.at(-1) === 'fed');
  t('...and marking it again changes nothing', mp.markFed(['aa']) === 0);
  mp.add('bb', 'the mirror', 'seed');
  t('a seed add of a transaction already held marks it fed', mp.txs.get('bb').fed === true);
  mp.add('dd', 'the mirror', 'seed');
  t('a seed add of a new one is fed from the start', mp.txs.get('dd').fed === true);
}
{
  const now = 1_800_000_000_000, s = now / 1000;
  t('a tip dated more than ten minutes past this clock is too new; at the bound it is not', tooNew(s + MAX_AHEAD_S + 1, now) && !tooNew(s + MAX_AHEAD_S, now) && !tooNew(s - 3600, now));
  t('a tip with no time, or a time that is not a number, is refused', tooNew(undefined, now) && tooNew('x', now));
  const tip = (height, created_at) => ({ height, hash: `h${height}`, first: height, hashes: [`h${height}`], created_at });
  const held = tip(100, Math.floor(Date.now() / 1000) - 60);
  const future = tip(101, Math.floor(Date.now() / 1000) + 86_400);
  t('a future-dated tip does not replace the held one, nor become the first', higherTip(held, future) === held && higherTip(null, future) === null);
  t('...and the next honest tip is still taken', higherTip(held, tip(101, Math.floor(Date.now() / 1000))).height === 101);
  t('the live look-back is ten minutes, and the clock\'s error more', sinceFor(now, 0) === s - 600 && sinceFor(now, 120) === s - 720 && sinceFor(now, -300) === s - 900 && sinceFor(now, 'x') === s - 600);
}
{
  t('a newer tip lower than the vouched height takes it back to the tip', vouchedUnder(110, { height: 109 }) === 109);
  t('a higher tip leaves it; none vouched stays none', vouchedUnder(105, { height: 109 }) === 105 && vouchedUnder(null, { height: 109 }) === null);
  // the R3 case end to end: vouched 110, the publisher signs 109 later; judged against it, 109 stays the vouched height
  t('...and judging the new tip does not raise it again', nextVouched(vouchedUnder(110, { height: 109 }), { highest: 109 }) === 109);
}
{ // the worker's wiring, read as text (it runs only in a browser)
  const w = readFileSync(new URL('../browser/worker.js', import.meta.url), 'utf8'), l = readFileSync(new URL('../browser/tabnode.js', import.meta.url), 'utf8');
  t('the worker reads a changed file again and marks it fed', /if \(e !== etag\) await read\(true\)/.test(w) && /mp\.markFed\(/.test(w));
  t('setTip caps the vouched height; tip.json keeps the block source and refuses a future-dated tip', /const setTip = \(t\) => setTipOn\(chain, t, \{ save: saveTip \}\)/.test(w) && /source: chain\.blocksUrl/.test(w) && /keptTip\(JSON\.parse/.test(w));
  t('a delta log that breaks off caps the vouched height at what was replayed', /chain\.vouchedTo > chain\.node\.height\) setVouched\(chain\.node\.height\)/.test(w));
  t('block replies carry the coinbase value', /coinbaseValue,/.test(w));
  t('the loader\'s wipe stops its retry and marks the node wiped; a wake ignores it', /wipe\(\{ timeoutMs = 20_000 \} = \{\}\) \{ swarmTeardown\(true\); clearTimeout\(retryTimer\)/.test(l) && /node\.phase === 'wiped'\) return/.test(l));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
