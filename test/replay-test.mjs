// Blocks replayed from the tab's delta log after a reload carry undo records, so a reorg right after a reload is a pop:
// the set comes back exactly (a snapshot coin through unspend, a coin created since through set), and a reorg deeper
// than the records says how deep it was and how far they reach.   node test/replay-test.mjs
import { ChainNode } from '../lib/node.mjs';
let ok = 0, bad = 0; const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
// a set in the shape of PackedUtxo: snapshot coins are marked spent and unspent; coins since the snapshot are a map
function fakeSet(snapshot) { const spent = new Set(), fresh = new Map();
  return { fresh, get: (k) => fresh.get(k) ?? (snapshot.has(k) && !spent.has(k) ? snapshot.get(k) : undefined), set: (k, c) => fresh.set(k, c), delete: (k) => { if (!fresh.delete(k) && snapshot.has(k)) spent.add(k); }, unspend: (k) => (snapshot.has(k) && spent.delete(k)), has: (k) => fresh.has(k) || (snapshot.has(k) && !spent.has(k)) }; }
const coin = (v, h) => ({ output: { value: v, scriptPubKey: '51' }, height: h, coinbase: false });
const snap = new Map([['s:0', coin(5000, 90)]]);
const deltas = [
  { height: 101, hash: 'h101', spent: ['s:0'], created: [['a:0', coin(4900, 101)]] },
  { height: 102, hash: 'h102', spent: ['a:0'], created: [['b:0', coin(4800, 102)], ['c:0', null]] },
];
const replayAll = (undoDepth = 100) => { const u = fakeSet(snap); const n = new ChainNode({ k: null, utxo: u, epochStart: 0, undoDepth }); n.setBase(100, 'h100'); for (const d of deltas) n.replay(d, { time: d.height }); return { n, u }; };
{
  const { n, u } = replayAll();
  t('replayed blocks change the set as they did when applied', n.height === 102 && u.has('b:0') && !u.has('a:0') && !u.has('s:0') && n.chain[102] === 'h102');
  t('and leave an undo record per block', n.undo.length === 2 && n.undo[1].spent[0][0] === 'a:0' && n.undo[1].spent[0][1].output.value === 4900);
  n.rollbackTo(101);
  t('a one-block reorg after a reload pops the last replayed block: its coin gone, the coin it spent back', n.height === 101 && !u.has('b:0') && u.get('a:0')?.output.value === 4900 && n.chain[102] === undefined);
  n.rollbackTo(100);
  t('back to the snapshot: the snapshot coin is unspent again', n.height === 100 && u.has('s:0') && !u.has('a:0'));
  let e = ''; try { n.rollbackTo(99); } catch (x) { e = x.message; }
  t('a reorg past the records says how deep and how far they reach', /back to 99 from 100 is 1 blocks, the undo records reach back to 100/.test(e), e);
}
{
  const { n } = replayAll(1);
  let e = ''; try { n.rollbackTo(100); } catch (x) { e = x.message; }
  t('only the last undoDepth blocks are kept, and the error names the real depth', n.undo.length === 1 && /2 blocks, the undo records reach back to 101 \(1 blocks; at most 1 kept\)/.test(e), e);
  t('nothing was popped by the refused reorg', n.height === 102);
}
{
  const u = fakeSet(snap); const n = new ChainNode({ k: null, utxo: u, epochStart: 0 }); n.setBase(100, 'h100');
  let e = ''; try { n.replay(deltas[1], {}); } catch (x) { e = x.message; }
  t('a delta that does not follow the tip is refused', /replay 102 at height 100/.test(e));
}
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
