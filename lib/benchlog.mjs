// Benchmarks over time: one JSON line per run (bench/history.jsonl), the same stages the bench
// prints, reduced to what a reader compares across runs, plus what ran them (commit, engine, node,
// machine). The report renders the lines as a table and a chart; both are rewritten in place.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { cpus } from 'node:os';

const sh = (cmd, cwd) => { try { return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };

// What ran: this repo's commit, the engine's version and commit, Node, the processor.
export function runContext({ repo, schema } = {}) {
  let engine = null;
  try { engine = { version: JSON.parse(readFileSync(`${schema}/package.json`, 'utf8')).version, commit: sh('git rev-parse --short HEAD', schema) }; } catch {}
  return { commit: sh('git rev-parse --short HEAD', repo), engine, node: process.version, cpu: cpus()[0]?.model?.replace(/\s+/g, ' ').trim() ?? null, cores: cpus().length };
}

// A bench object (as the CLI prints it) reduced to one record.
export function benchRecord(bench, { at = new Date().toISOString(), ...ctx } = {}) {
  const b = bench.blocks ?? {}, p = bench.parse ?? {};
  const r = {
    at, ...ctx,
    scripts: b.scripts ?? null, source: b.source ?? null,
    tip: b.to ?? null, blocks: b.count ?? null, txs: b.txs ?? null,
    sha256Ms: bench.sha256?.ms ?? null,
    parseMs: p.ms ?? null, coinsPerSec: p.coinsPerSec ?? null, coins: p.coins ?? null,
    indexMs: bench.index?.ms ?? null, indexFrom: bench.index?.from ?? null,
    headersMs: bench.headers?.ms ?? null,
    blocksMs: b.ms ?? null, validateMs: b.validateMs ?? null, applyMs: b.applyMs ?? null,
    blocksPerSec: b.blocksPerSec ?? null,
    usPerTx: b.validateMs && b.txs ? Math.round(b.validateMs * 1000 / b.txs) : null,
    failed: b.failed ?? null,
    utxoMatch: bench.crosscheck?.match ?? null,
    rss: b.rss ?? p.rss ?? null,
    series: b.series ?? null, // [[height, ms since the first block]] every 200 blocks
  };
  return r;
}

export function appendRecord(path, record) { appendFileSync(path, JSON.stringify(record) + '\n'); return record; }
export function readRecords(path) { return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }

const s = (ms) => ms == null ? '' : ms >= 10000 ? `${(ms / 1000).toFixed(0)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
const n = (x) => x == null ? '' : x.toLocaleString('en-US');

// A markdown table, newest last, one row per run.
export function reportTable(records) {
  const head = '| date | commit | engine | blocks | txs | scripts | parse | coins/s | headers | blocks | validate | blocks/s | µs/tx | utxo |';
  const sep = '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = records.map((r) => `| ${r.at.slice(0, 10)} | ${r.commit ?? ''} | ${r.engine?.version ?? ''} | ${n(r.blocks)} | ${n(r.txs)} | ${r.scripts === false ? 'off' : 'on'} | ${s(r.parseMs)} | ${n(r.coinsPerSec)} | ${s(r.headersMs)} | ${s(r.blocksMs)} | ${s(r.validateMs)} | ${r.blocksPerSec ?? ''} | ${n(r.usPerTx)} | ${r.utxoMatch === true ? 'match' : r.utxoMatch === false ? 'MISMATCH' : '—'} |`);
  return [head, sep, ...rows].join('\n');
}

// A small chart: µs per transaction (scripts on) and parse time per run, by date. No dependencies.
export function reportSvg(records, { w = 720, h = 240 } = {}) {
  const runs = records.filter((r) => r.scripts !== false && r.usPerTx != null);
  const pad = { l: 56, r: 56, t: 24, b: 40 }; const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (runs.length < 2 ? iw / 2 : i * iw / (runs.length - 1));
  const maxUs = Math.max(1, ...runs.map((r) => r.usPerTx)), maxParse = Math.max(1, ...runs.map((r) => r.parseMs ?? 0));
  const yUs = (v) => pad.t + ih - v / maxUs * ih, yP = (v) => pad.t + ih - v / maxParse * ih;
  const path = (f, key) => runs.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${f(r[key]).toFixed(1)}`).join(' ');
  const dots = (f, key, c) => runs.map((r, i) => `<circle cx="${x(i).toFixed(1)}" cy="${f(r[key]).toFixed(1)}" r="4" fill="${c}"><title>${r.at.slice(0, 10)} ${r.commit ?? ''}: ${key} ${r[key]}</title></circle>`).join('');
  const labels = runs.map((r, i) => `<text x="${x(i).toFixed(1)}" y="${h - 14}" text-anchor="middle">${r.at.slice(0, 10)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace,monospace" font-size="11">
<rect width="${w}" height="${h}" fill="#fff"/>
<text x="${pad.l}" y="14" fill="#1d4ed8">µs per tx (validate, scripts on), max ${n(maxUs)}</text>
<text x="${w - pad.r}" y="14" text-anchor="end" fill="#b45309">parse s, max ${(maxParse / 1000).toFixed(0)}</text>
<line x1="${pad.l}" y1="${pad.t + ih}" x2="${w - pad.r}" y2="${pad.t + ih}" stroke="#e3e6eb"/>
<path d="${path(yUs, 'usPerTx')}" fill="none" stroke="#1d4ed8" stroke-width="2"/>${dots(yUs, 'usPerTx', '#1d4ed8')}
<path d="${path(yP, 'parseMs')}" fill="none" stroke="#b45309" stroke-width="2" stroke-dasharray="4 3"/>${dots(yP, 'parseMs', '#b45309')}
${labels}
</svg>
`;
}

// Replace the block between two markers in a text, or append it when the markers are missing.
export function spliceMarked(text, name, body) {
  const a = `<!-- ${name}:start -->`, z = `<!-- ${name}:end -->`;
  const i = text.indexOf(a), j = text.indexOf(z);
  if (i < 0 || j < 0) return `${text.trimEnd()}\n\n${a}\n${body}\n${z}\n`;
  return `${text.slice(0, i + a.length)}\n${body}\n${text.slice(j)}`;
}
