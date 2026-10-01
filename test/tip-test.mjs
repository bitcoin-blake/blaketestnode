// The signed tip held against the applied chain and the served block file (lib/nip333.mjs judgeTip): a fork the mirror
// serves is caught when its block is served or applied, not only at the moment the tip arrives.
import { judgeTip, servedDisagreement, rollbackAllowed } from '../lib/nip333.mjs';
let pass = 0, fail = 0; const t = (name, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !d ? '' : `\n        ${d}`}`); ok ? pass++ : fail++; };
const tip = { first: 10, hashes: ['a10', 'a11', 'a12'] };
const map = (o) => (h) => o[h];
t('a tip ahead of the chain: nothing to compare yet, no agreement and no divergence', JSON.stringify(judgeTip(tip, { applied: map({ 9: 'x' }) })) === '{"agree":0,"diverged":false,"highest":null,"firstDiverged":null}');
t('once the node applies the same blocks, they agree', judgeTip(tip, { applied: map({ 10: 'a10', 11: 'a11', 12: 'a12' }) }).agree === 3);
t('a mirror that serves another block at a covered height diverges before it is applied', judgeTip(tip, { applied: map({ 10: 'a10' }), served: map({ 11: 'b11' }) }).diverged === true);
t('an applied block that differs diverges', judgeTip(tip, { applied: map({ 10: 'a10', 11: 'b11' }) }).diverged === true);
t('every header of the event counts, not the tip alone (a fork below the tip)', judgeTip(tip, { applied: map({ 10: 'b10', 11: 'a11', 12: 'a12' }) }).diverged === true);
t('no tip: nothing', JSON.stringify(judgeTip(null, { applied: () => undefined })) === '{"agree":0,"diverged":false,"highest":null,"firstDiverged":null}');
t('the served chain is held against the signed headers first: the first height that differs', (await servedDisagreement(tip, async (h) => ({ 10: 'a10', 11: 'b11', 12: 'b12' })[h])) === 11);
t('...none when it agrees or does not reach that far', (await servedDisagreement(tip, async (h) => ({ 10: 'a10' })[h])) === null && (await servedDisagreement(null, async () => 'x')) === null);
t('a rollback that replaces blocks below the signed headers is refused; one within them, or with no tip, is allowed', !rollbackAllowed(8, tip) && rollbackAllowed(9, tip) && rollbackAllowed(11, tip) && rollbackAllowed(3, null));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
