// Benchmarks over time (lib/benchlog.mjs): a bench reduced to one record, records to a table and a chart, the README block replaced in place.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { benchRecord, appendRecord, readRecords, reportTable, reportSvg, spliceMarked, runContext } from '../lib/benchlog.mjs';
let pass = 0, fail = 0; const t = (name, ok, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !d ? '' : `\n        ${d}`}`); ok ? pass++ : fail++; };
const bench = { sha256: { ms: 391, ok: true }, parse: { ms: 9480, coins: 14230182, coinsPerSec: 1501093, rss: '466 MiB rss' }, index: { ms: 9552, from: 'built' }, headers: { ms: 273 },
  blocks: { from: 150308, to: 152883, count: 2576, txs: 14596, ms: 60784, validateMs: 60475, applyMs: 302, blocksPerSec: 42.4, failed: 0, scripts: true, source: 'http', rss: '832 MiB rss', series: [[150507, 4000], [152883, 60784]] }, crosscheck: { match: true } };
const r = benchRecord(bench, { at: '2026-10-12T07:34:16.000Z', commit: 'abc1234', engine: { version: '0.0.27', commit: 'b8cbf63' }, node: 'v24.16.0', cpu: 'cpu', cores: 32 });
t('a record keeps the stage times and what ran', r.tip === 152883 && r.blocks === 2576 && r.parseMs === 9480 && r.validateMs === 60475 && r.engine.version === '0.0.27' && r.commit === 'abc1234');
t('µs per transaction is validate time over transactions', r.usPerTx === Math.round(60475 * 1000 / 14596));
t('the 200-block series rides along', r.series.length === 2 && r.series[1][0] === 152883);
t('a bench without blocks gives nulls, not a throw', benchRecord({ parse: { ms: 1 } }).blocks === null && benchRecord({}).usPerTx === null);
const dir = mkdtempSync(`${tmpdir()}/bench-`); const hist = `${dir}/history.jsonl`;
appendRecord(hist, r); appendRecord(hist, { ...r, at: '2026-10-13T00:00:00.000Z', scripts: false, usPerTx: 90, parseMs: 9000 });
const recs = readRecords(hist);
t('records append as JSON lines and read back in order', recs.length === 2 && recs[0].at < recs[1].at && readRecords(`${dir}/none.jsonl`).length === 0);
const table = reportTable(recs);
t('the table has a header, a rule and one row per run with date, commit and engine', table.split('\n').length === 4 && table.includes('| 2026-10-12 | abc1234 | 0.0.27 |') && table.includes('| off |') && table.includes('| match |'));
const svg = reportSvg(recs);
t('the chart plots scripts-on runs only, one dot per run with a title', svg.startsWith('<svg') && (svg.match(/<circle/g) ?? []).length === 2 && svg.includes('2026-10-12') && !svg.includes('2026-10-13'));
t('a chart of one run still renders', reportSvg([r]).includes('<circle'));
const readme = '# x\n\nintro\n\n<!-- bench:start -->\nold\n<!-- bench:end -->\n\ntail\n';
const out = spliceMarked(readme, 'bench', table);
t('the README block is replaced between the markers, the rest untouched', out.includes('intro\n\n<!-- bench:start -->\n| date') && out.endsWith('<!-- bench:end -->\n\ntail\n') && !out.includes('old'));
t('missing markers: the block is appended', spliceMarked('# y\n', 'bench', 'b').endsWith('<!-- bench:start -->\nb\n<!-- bench:end -->\n'));
const ctx = runContext({ repo: new URL('..', import.meta.url).pathname, schema: '/nonexistent' });
t('the run context names node and the processor; a missing engine is null, not a throw', ctx.node === process.version && ctx.cores > 0 && ctx.engine === null && typeof ctx.commit === 'string');
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
