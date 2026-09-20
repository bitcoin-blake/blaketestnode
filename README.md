# blaketestnode

A node for Bitcoin BLAKE2b testnet4 (`txbt4`) in plain JavaScript. It starts from an
assumeUTXO snapshot at the fork point and validates every BLAKE2b block forward with the
[bitcoin-kernel](https://bitcoin-kernel.com/) engine. Node first; the same library is
meant to run in the browser next (OPFS for the snapshot, WebTorrent for transport).

Part of the [bitcoin-blake](https://github.com/bitcoin-blake) family, next to
[blaketest](https://github.com/bitcoin-blake/blaketest) (the wallet) and the
[datstr](https://datstr.com/) pool.

## What it does

1. **fetch** the snapshot over WebTorrent (magnet with WebRTC and udp trackers, plus an
   HTTP webseed) and check its sha256. The snapshot is announced on Nostr as a NIP-35
   torrent event; see it on [ntorrent](https://nostrapps.github.io/ntorrent/?q=assumeutxo).
2. **verify** the snapshot: parse the Core `dumptxoutset` v2 format and recompute
   `hash_serialized_3` over all coins, byte for byte as `gettxoutsetinfo` does. The result
   must equal the `txoutset_hash` pinned in `lib/params.mjs`.
3. **sync**: get every post-fork block, validate the header chain (BLAKE2b v2 headers,
   testnet4 min-difficulty rule, MTP, timewarp), then run the structural and contextual
   block rules against the UTXO set and apply each block. When a local Knots node is
   reachable the coin count is cross-checked against its `gettxoutsetinfo`.

   Blocks come from one of two sources (`--source`):
   - **http** (default, no node needed): a served block file plus index, mirrored into the
     data directory with Range requests so a re-run fetches only the tail. Every record is
     checked against the index hash and linked to its parent. The newest NIP-333 header
     event for the chain (kind 33333, `d` = `tbtc4b2`, from the pinned publisher key,
     signature verified) is fetched from relays and its 12 headers must agree with the
     file's tail, so the file cannot quietly serve a different chain. The epoch of headers
     before the fork comes from a context file the same way.
   - **rpc**: the local Knots node, as before.

   The block file is kept current by `tools/export-blocks.mjs` from a node, appending new
   blocks and unwinding reorgs. Any host that serves the two files with Range requests and
   CORS will do (a datstr gateway's `--files` directory does); pass it as `--blocks-url`
   or `BLAKETESTNODE_BLOCKS_URL`.

4. **run**: the long-running node. It loads its newest checkpoint (a snapshot it wrote
   itself in the same dumptxoutset format, `hash_serialized_3` in the manifest) or the fork
   snapshot through the packed index, replays its per-block delta log on top, follows the
   block file every 30 s and on every NIP-333 event, applies new blocks with undo records
   for the last 100 so a reorg is a pop, appends a delta after each block, writes a full
   checkpoint every 2016 blocks, and serves a status page, `/status.json`, `/block/<h>`,
   `/header/<h>`, `/coin/<txid>:<vout>` and a `/tip` WebSocket stream on `--api` (3337).
   The snapshots it writes are exact: a checkpoint at 151,078 has the `hash_serialized_3`
   the Knots node reports at that height, and `roundtrip` rewrites the fork snapshot from
   the packed set byte for byte, same sha256. The daemon holds about 450 MB.

```
node --max-old-space-size=8192 bin/blaketestnode.mjs run --api 3337 --blocks-url <url>   # the daemon (pm2 example in ops/)
node --max-old-space-size=8192 bin/blaketestnode.mjs bench            # fetch, verify, sync: no node needed
node bin/blaketestnode.mjs verify --data ./data                        # snapshot only
node bin/blaketestnode.mjs sync --source rpc                           # blocks from the local node
node bin/blaketestnode.mjs sync --no-scripts                           # skip signature checks
node tools/export-blocks.mjs --loop 20                                 # keep the served block file current (needs a node)
```

Options: `--data <dir>` (default `~/.blaketestnode/txbt4`), `--source http|rpc`, `--blocks-url <url>`,
`--webseed <url>`, `--conf <bitcoin.conf>`, `--to <height>`, `--no-scripts`; for `run` also `--api <port>`,
`--poll <seconds>`, `--checkpoint-every <blocks>` (2016). A restart with the index on disk
takes seconds; building the index for a new snapshot takes about 20 s. The engine is loaded from `$SCHEMA` or
`~/bitcoin-desktop/schema`; it needs bitcoin-desktop/schema v0.0.27 or later (unified sighash, pay-to-anchor).

## In the browser

`browser/index.html` is the same node starting in a tab: it fetches the snapshot into the
origin's private file system in parallel ranges (resumable, a journal of finished ranges),
hashes it, then a module worker runs the same parser and index builder over the file
through a sync access handle and keeps the 217 MB index beside it. Nothing leaves the tab
and no server is trusted: the pinned sha256 and `hash_serialized_3` decide. Give it a
snapshot URL with `?snapshot=` (a plain file with Range and CORS). Measured in Chromium
on this machine: fetch 2 s from a local server, sha256 15 s, parse plus index 37 s.
Storage needed is about 1.1 GB; the page shows the origin's quota first.

With `?blocks=` (the served block file, as for the daemon) the tab is a node: the worker
mirrors the block file into OPFS with the same hash and link checks, takes the tip from
the NIP-333 relays and requires it to agree with the file's tail, validates every block
against its own UTXO set with the engine from jsDelivr (signatures included), keeps a
delta log so a reload replays in seconds, then follows the tip every 30 s and on every
NIP-333 event. Measured in Chromium: 797 blocks validated in 48 s, replay 9 s, a new
block applied live. A coin lookup box answers from the tab's own set.

## Mempool (datstr SPEC 6.3)

With `--mempool-relays wss://a,wss://b` the daemon follows kind 23404 events (one transaction
each, `chain` tag = this chain; a datstr gateway publishes its node's mempool that way) and
validates every one against its own UTXO set before holding it: structure, inputs unspent and
mature, value, scripts with the chain's sighash, a fee floor. What passes is served at
`/mempool` and `/mempool/<txid>` and dropped when a block confirms or conflicts with it.
`--mempool-publishers pk,pk` limits the publishers. `node test/mempool-test.mjs` runs both ends
through a local relay (it imports the gateway's publisher from `$DATSTR_GATEWAY`).

## The block it builds (datstr SPEC 6.3)

`lib/template.mjs` builds the next block from the node's own state: time after the median time
past, bits from the chain's rules, transactions from the mempool by fee rate within the weight
limit (the RDTS 800,000 while it is active), the coinbase as datstr SPEC 6.1 has it (the split or
the pay scripts, the witness commitment, the datstr commitment output last), the merkle root and a
v2 header. `checkTemplate` then runs every kernel rule on it; the only one an unmined block may
fail is proof of work. The daemon serves it at `/template?pay=<script hex>`; the tab has a "build a
block" button. Proven against Knots: a block built by the daemon for height 151,412 was accepted by
both a 29.4.1 and a 29.4.2rc2 node in `getblocktemplate` proposal mode; so was one built in a
Chromium tab that had fetched the snapshot (36 s), verified it (23 s) and synced 1,104 blocks with
signatures (22 s) on its own, with no server trusted. `node test/template-test.mjs`
covers a throwaway chain and checks the datstr gateway's builder makes the identical block from the
same template.

## Mining what it built (datstr SPEC 6.3 and 8)

`lib/webminer.mjs` makes the node a datstr gateway of one: it is its own master (a miner
descriptor paying its script), speaks the coordinator's socket (hello, welcome, split,
assignment, ack), builds each height's block with `lib/template.mjs` and the coordinator's split,
hashes the 80-byte work an ASIC would (`workBytes`), and signs the kind 23400 share carrying the
header, the coinbase and the merkle path, so the coordinator rebuilds the commitment from the
block this miner built. `lib/open.mjs` opens a daemon's state read-only in another process.
`node test/webminer-test.mjs` runs it against a standalone datstr coordinator on the live chain:
the share for height 151,413 was verified by SPEC 8.1 and credited (#1); a coinbase paying the
wrong script was refused as `split`. In the tab, the "mine" card does the same with hashing
workers (the datstr miner's core from jsDelivr, WebAssembly): a Chromium tab that had replayed its
own delta log to the tip in 1.5 s connected to a coordinator as its own master, built block
151,413 with the coordinator's split, and had 2,072 shares credited in a minute, none refused,
vardiff raising its difficulty from 0.0001 to 0.0016 on the way. Against the live pool's
coordinator (start difficulty 1,000) the same tab, hashing at about 100 MH/s, found nothing for
minutes: at that rate the 32-bit nonce space is exhausted in 42 seconds and a piece of work at a
real difficulty rarely holds a valid nonce at all. The hashers now roll the second nonce word
(`header.nonce2`, bytes 36..39 of the work) on every wrap, as a rig rolls its extranonce, and the
share carries it; after that the live coordinator credited the tab's shares (#145,218 onward).

## Snapshot

| | |
|---|---|
| base | 150,307 `000000000017ec2251d81c8d2ca401c713e98e85196c7f660a4088a7ca57b1cc` (last block shared with Core) |
| txoutset_hash | `372bfcaeef1e93892acccda9e700b00bf90f45d73746d69959d33620a3df5518` |
| coins | 14,230,182 in 9,356,185 txids, 869,836,053 bytes |
| infohash | `242e9b7dcba15cc0ed8f1bc5f06b68da008f87c0` |
| webseed | optional, `--webseed <url>` or `BLAKETESTNODE_WEBSEED`; peers and the NIP-35 event carry the rest |

## Benchmark (14 Sep 2026, one core of a desktop, Node 24)

| step | result |
|---|---|
| torrent fetch | 870 MB in 9.8 s, 85 MiB/s (webseed + one peer) |
| sha256 of file | 1.8 s |
| parse + hash_serialized_3 | 14 s (26 s with the old string map); index build 3 s, reload 50 ms |
| block file, 2.4 MB, 766 blocks | 0.8 s fetch, 1.4 s with hash and link checks |
| NIP-333 tip from relays | tip 151,073 verified, 12 tail hashes agree with the file |
| headers 150,308 to 151,073 | 766 validated, 0 failed, 150 ms |
| blocks, scripts off | 763 blocks, 5,045 txs, 2.5 s (300 blocks/s) |
| blocks, scripts on | 51 s, 0 failures and no skipped rules on engine v0.0.27 (16 script failures on v0.0.25) |
| UTXO count vs node | 14,233,524 both, match (rpc cross-check when a node is reachable) |

Post-fork transactions are signed with `SIGHASH_ALL | SIGHASH_UNIFIED` (0x21), the
fork's replay protection. Engine v0.0.25 fails 16 blocks on that; from v0.0.26
([bitcoin-desktop/schema#92](https://github.com/bitcoin-desktop/schema/pull/92)) every block
validates with scripts on. Signature checks are about 48 of the 51 s, pure-JS secp256k1.

## Layout

- `lib/params.mjs` chain and snapshot parameters, the only file that changes for mainnet
- `lib/varint.mjs` Core VARINT, CompactSize, amount and script decompression
- `lib/snapshot.mjs` snapshot parser and `hash_serialized_3`
- `lib/packed.mjs` the UTXO set: a packed index of the snapshot (16 bytes per coin, file
  order, binary search on a txid prefix with the full txid checked in the file), a spent
  bitmap, and a side map of new coins; built in one pass with the hash, read back in 50 ms
- `lib/delta.mjs` per-block deltas appended after each block and replayed on restart
- `lib/bytes.mjs`, `lib/sha256.mjs` byte helpers and an incremental SHA-256, so the parser
  and index run unchanged in Node and in a worker
- `lib/snapshot-write.mjs`, `lib/filebytes.mjs` the Node-only writer and file access
- `browser/index.html`, `browser/worker.js`, `browser/blocks.js` the page, its worker and the block mirror over OPFS
- `lib/fetch.mjs` WebTorrent fetch and sha256
- `lib/blockfile.mjs`, `lib/source.mjs` the block file format and the http/rpc block sources
- `lib/nip333.mjs` the chain tip from NIP-333 header events, one-shot and live
- `lib/node.mjs` the chain state machine: headers, applied hashes, undo records
- `lib/state.mjs` checkpoints: the UTXO set written as a snapshot with a manifest
- `lib/api.mjs`, `lib/status.html` the HTTP routes, tip stream and status page
- `ops/blaketestnode.config.example.cjs` pm2 example
- `tools/export-blocks.mjs` keeps the served block file current from a node
- `lib/engine.mjs`, `lib/rpc.mjs` engine and node RPC loaders
- `bin/blaketestnode.mjs` the CLI
