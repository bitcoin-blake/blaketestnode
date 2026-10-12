#!/usr/bin/env node
// Renders bench/history.jsonl into README.md (between <!-- bench:start --> and <!-- bench:end -->)
// and bench/history.svg. Usage: node tools/bench-report.mjs [history.jsonl]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords, reportTable, reportSvg, spliceMarked } from '../lib/benchlog.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const history = process.argv[2] ?? `${root}/bench/history.jsonl`;
const records = readRecords(history);
if (!records.length) { console.error(`no records in ${history}`); process.exit(1); }
writeFileSync(`${root}/bench/history.svg`, reportSvg(records));
const readme = `${root}/README.md`;
writeFileSync(readme, spliceMarked(readFileSync(readme, 'utf8'), 'bench', reportTable(records)));
console.error(`${records.length} runs → README.md table, bench/history.svg`);
