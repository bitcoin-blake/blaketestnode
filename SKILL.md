---
name: blaketestnode
description: How the BLAKE2b testnet4 (txbt4) JavaScript node works and how to run, check, bench and extend it — "is the node synced", "how long does a sync take", "replay the chain from the snapshot", "record a benchmark", "what does the daemon do on restart", "where do blocks come from".
---
# blaketestnode

A full node for the BLAKE2b testnet4 chain, in JavaScript, that trusts nothing it is handed. It starts
from the fork-point UTXO snapshot, proves the snapshot is the one pinned in the code, then validates every
block since the fork with the bitcoin-kernel engine (`bitcoin-desktop/schema` plus the knots-blake2b
overlay), signatures included. The same code runs as a daemon under Node and as a worker in a browser tab.

## The idea in one paragraph

Bitcoin Core's `dumptxoutset` writes the whole UTXO set at one height into a file with a hash
(`hash_serialized_3`) that the node also reports from `gettxoutsetinfo`. If you know that hash, a file
anyone sends you is either exactly the set at that height or it is not. This node pins the snapshot at
height 150307, the last block the two branches of the fork share (`lib/params.mjs`: base hash, txoutset
hash, sha256, byte size, infohash). From there every block of the BLAKE2b branch is fetched, validated
against that set and applied, so the node's state at the tip is its own work, not a copy of anyone's.

## Where things come from

- **The snapshot** (870 MB): WebTorrent, magnet with WebRTC and udp trackers, plus an optional HTTP
  webseed (`--webseed` or `BLAKETESTNODE_WEBSEED`). Its sha256 is checked before anything else reads it.
  It is announced on Nostr as a NIP-35 torrent event.
- **Blocks**: a served block file and its index (`<url>.dat`, `<url>.json`) fetched with Range requests
  and mirrored into the data directory, so a re-run only takes the tail. Every record is hashed against
  the index and linked to its parent. There is no default host on purpose: pass `--blocks-url` or
  `BLAKETESTNODE_BLOCKS_URL`. With `--source rpc` the blocks come from a local Knots node instead.
  `tools/export-blocks.mjs --loop 20` keeps a served file current from a node.
- **The tip**: NIP-333 header events (kind 33333, `d` = `tbtc4b2`, from the publisher key in
  `lib/params.mjs`, signature verified) from several relays. The newest event carries 12 headers and
  they must agree with the block file's tail, so a mirror cannot quietly serve another chain. A later
  divergence is caught when the differing block is served or applied, not only on arrival.
- **The engine**: `$SCHEMA` or `~/bitcoin-desktop/schema` for Node (`lib/engine.mjs`), a pinned commit
  from jsDelivr for the browser. It needs v0.0.26 or later for `SIGHASH_UNIFIED` (0x21, the fork's
  replay protection) and v0.0.27 for pay-to-anchor.

## A sync from nothing (`bench`)

```
node --max-old-space-size=8192 bin/blaketestnode.mjs bench --blocks-url <url> [--record]
```

1. `fetch`: torrent the snapshot unless it is already present with the right size; sha256 it.
2. `verify`: parse the Core `dumptxoutset` v2 format coin by coin and recompute `hash_serialized_3`.
   One pass also builds the **packed index** (`lib/packed.mjs`): 16 bytes per coin in file order, a
   txid-prefix binary search with the full txid confirmed in the file, a spent bitmap, and a side map for
   coins created after the snapshot. The index is written beside the snapshot (`.idx`, ~217 MB) and read
   back in about 50 ms on every later start. The set is never loaded into memory as objects.
3. `sync`: fetch the block file and the pre-fork context headers, take the NIP-333 tip, validate the
   header chain (BLAKE2b v2 headers, the testnet4 min-difficulty rule, median time past, timewarp), then
   for each block run the structural rules, the contextual rules against the UTXO set (inputs unspent and
   mature, values, scripts with the chain's sighash), and apply it. When a Knots node is reachable through
   `--conf` the final coin count is cross-checked against `gettxoutsetinfo`.

Measured on 12 Oct 2026 (one core of a Ryzen 9950X3D, Node 24, engine 0.0.27): sha256 0.4 s, parse and
index 10 s, 2,577 blocks with scripts in 61 s (42 blocks/s, about 4,150 µs per transaction, nearly all of
it pure-JS secp256k1), coin count matching the node. About 90 s end to end with a local seed; with
`--no-scripts` the block stage is a few seconds. The first 200 post-fork blocks take about 18 of the 61 s
because they carry the large replayed faucet sweeps.

## The daemon (`run`)

```
node --max-old-space-size=8192 bin/blaketestnode.mjs run --api 3337 --poll 10 --blocks-url <url>
```

On start it does not re-validate the chain. It loads the newest **checkpoint** from `state/` (a full
snapshot it wrote itself in the same `dumptxoutset` format, with `hash_serialized_3` in its manifest;
one every `--checkpoint-every` blocks, 2016 by default, a write takes about 90 s), or the fork snapshot
through the packed index, then replays `deltas.jsonl`, one small record per block applied since that
checkpoint (`lib/delta.mjs`; replay is seconds). Anything beyond the log is fetched, validated with
scripts and applied as in `sync`, with a delta appended after each block. Then it follows the tip: the
block file every `--poll` seconds and every NIP-333 event. Each applied block keeps an undo record for
the last 100 (`lib/node.mjs`), so a reorg is a pop, including right after a reload. A checkpoint at
151078 reproduced the hash Knots reported at that height, and `roundtrip` rewrites the fork snapshot
from the packed set byte for byte, same sha256.

The daemon holds about 450 MB. It serves on `--api`: a status page at `/`, `/status.json` (height, hash,
coins, state, checkpoint, delta count, the NIP-333 tip, mempool and pair when enabled), `/block/<h>`,
`/header/<h>`, `/coin/<txid>:<vout>`, `/utxo`, `/template?pay=<script hex>` (the next block built from its
own state, every kernel rule run on it), `/mempool` and `/mempool/<txid>` with `--mempool-relays`,
`/pair` with `--pair-api`, and a `/tip` WebSocket stream. `--address-index` adds an index by script
hash (`lib/scriptindex.mjs`), built once beside the snapshot. `ops/blaketestnode.config.example.cjs` is
the pm2 shape; `kill_timeout` is long because a checkpoint write must finish.

## The same node in a tab

`browser/index.html` with `?snapshot=<url>&blocks=<url>`: the snapshot is fetched in parallel ranges into
the origin's private file system (OPFS, resumable), hashed, parsed and indexed by `browser/worker.js`
through a sync access handle; the block file is mirrored into OPFS with the same checks; the engine is
pinned by commit from jsDelivr under a content-security policy naming the script hashes; the delta log
makes a reload seconds. OPFS sync handles are exclusive, so a second tab of the same origin waits.
Measured in Chromium: fetch 2 s locally, sha256 15 s, parse and index 37 s, 797 blocks in 48 s, replay 9 s.

## Mempool, templates, mining

With `--mempool-relays` the daemon follows kind 23404 events (one transaction each) and validates every
one against its own set before holding it. `lib/template.mjs` builds the next block from the mempool by
fee rate within the weight limit, with the datstr coinbase layout; `lib/webminer.mjs` makes the node a
datstr gateway of one, speaking the coordinator's socket and signing kind 23400 shares from blocks it
built itself. `lib/pair.mjs` reads the other branch of the fork through an Esplora API so one address
can be compared on both.

## Benchmarks over time

`bench --record [path]` appends one JSON line to `bench/history.jsonl`: date, commit, engine version and
commit, Node, processor, stage times, blocks per second, µs per transaction, whether the coin count
matched, and the elapsed time at every 200th block. `node tools/bench-report.mjs` rewrites the table in
README.md (between `<!-- bench:start -->` and `<!-- bench:end -->`) and draws `bench/history.svg`.
Compare runs by µs per transaction with scripts on; block counts grow with the chain, so blocks per second
alone is not a fair comparison across dates.

## Checking it

- `node --test` runs every file in `test/` (zero dependencies beyond webtorrent). `test/webminer-test.mjs`
  needs `BLAKETESTNODE_BLOCKS_URL` set to a blocks mirror and fails by design without it.
- `curl http://127.0.0.1:3337/status.json` for a running daemon: `state` should be `synced` and `height`
  should equal the Knots node's.
- `node bin/blaketestnode.mjs verify --data <dir>` proves a snapshot file alone.
- `node bin/blaketestnode.mjs roundtrip` proves the writer: the packed set rewritten as a snapshot
  must hash to the original.

## Layout

`lib/params.mjs` is the only file that changes for another chain. `lib/snapshot.mjs`, `lib/varint.mjs`
parse the Core format; `lib/packed.mjs`, `lib/delta.mjs`, `lib/state.mjs` are the set, its log and its
checkpoints; `lib/blockfile.mjs`, `lib/source.mjs`, `lib/nip333.mjs` are where blocks and the tip come
from; `lib/node.mjs` is the chain state machine; `lib/api.mjs` the routes; `lib/benchlog.mjs` the
benchmark history; `bin/blaketestnode.mjs` the CLI (`fetch | verify | sync | bench | run | roundtrip`).
The README has the longer account of each part and the measured numbers.

## Things that bite

- Node needs `--max-old-space-size=8192` for a full parse; the daemon is started with 12288.
- pm2 `restart` keeps old arguments; to change a flag, delete the process and start it from its config.
- The `.idx` beside a snapshot is derived and safe to delete; it is rebuilt by one parse.
- Never put a host name in the repo; mirrors are passed by flag or environment.
- A Knots restart rewrites its RPC cookie; anything holding the old one must be restarted.
