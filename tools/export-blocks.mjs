#!/usr/bin/env node
// Keeps the served block file current from the local node: appends new post-fork blocks,
// unwinds a reorg, and writes the context headers (the epoch before the fork) once.
//   node tools/export-blocks.mjs [--dir ~/knots-testnet4/snapshots] [--loop <seconds>] [--rsync user@host:path/]
//   --rsync pushes the block file, its index and the context headers to a remote directory after every change
import { existsSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { CHAIN, SNAPSHOT } from '../lib/params.mjs';
import { makeRpc } from '../lib/rpc.mjs';
import { readIndex, writeIndex, appendBlock, truncateFrom } from '../lib/blockfile.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const DIR = opt('--dir', `${homedir()}/knots-testnet4/snapshots`).replace(/^~/, homedir());
const LOOP = opt('--loop') ? Number(opt('--loop')) : 0;
const RSYNC = opt('--rsync', null);
const name = `${CHAIN.alias}-blocks`;
const dat = `${DIR}/${name}.dat`, idx = `${DIR}/${name}.json`, ctx = `${DIR}/${CHAIN.alias}-context-headers.json`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const rpc = await makeRpc(CHAIN.conf, CHAIN.network);
const from = SNAPSHOT.baseHeight + 1;

if (!existsSync(ctx)) { // the retarget epoch before the fork, for MTP and difficulty context
  const epochStart = Math.floor(SNAPSHOT.baseHeight / CHAIN.retargetInterval) * CHAIN.retargetInterval;
  const headers = [];
  for (let h = epochStart; h <= SNAPSHOT.baseHeight; h++) headers.push(await rpc('getblockheader', await rpc('getblockhash', h), false));
  writeFileSync(ctx, JSON.stringify({ network: CHAIN.network, from: epochStart, to: SNAPSHOT.baseHeight, headers }));
  log(`context headers ${epochStart}-${SNAPSHOT.baseHeight} written`);
}

async function once() {
  const index = readIndex(idx) ?? { network: CHAIN.network, from, to: from - 1, blocks: [] };
  // unwind: walk back while the node disagrees with our hash at that height
  while (index.blocks.length) {
    const last = index.blocks.at(-1);
    if (await rpc('getblockhash', last.height) === last.hash) break;
    log(`reorg: dropping ${last.height} ${last.hash.slice(0, 16)}`);
    truncateFrom(dat, index, last.height);
  }
  const tip = await rpc('getblockcount');
  let added = 0;
  for (let h = index.to + 1; h <= tip; h++) {
    const hash = await rpc('getblockhash', h);
    appendBlock(dat, index, h, hash, Buffer.from(await rpc('getblock', hash, 0), 'hex'));
    added++;
  }
  if (added) { writeIndex(idx, index); log(`+${added} blocks, file now ${index.from}-${index.to} (${index.blocks.length} blocks)`); }
  else if (!existsSync(idx)) writeIndex(idx, index);
  if (RSYNC && (added || !pushed)) await push();
}
let pushed = false;
// the served copy: the data file first, then the index that points into it, so a reader never
// sees an index entry the file does not yet have
function push() {
  return new Promise((resolve) => {
    execFile('rsync', ['-a', '--partial', dat, ctx, RSYNC], (e1) => {
      if (e1) { log(`rsync: ${e1.message}`); return resolve(); }
      execFile('rsync', ['-a', idx, RSYNC], (e2) => { if (e2) log(`rsync: ${e2.message}`); else { pushed = true; log(`pushed to ${RSYNC}`); } resolve(); });
    });
  });
}

await once();
if (LOOP) setInterval(() => once().catch((e) => log('error:', e.message)), LOOP * 1000);
