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
   blocks and unwinding reorgs; it is served at `https://melvin.me/datstr/snapshots/txbt4-blocks.{dat,json}`
   by a datstr gateway's `--files` directory.

```
node --max-old-space-size=8192 bin/blaketestnode.mjs bench            # fetch, verify, sync: no node needed
node bin/blaketestnode.mjs verify --data ./data                        # snapshot only
node bin/blaketestnode.mjs sync --source rpc                           # blocks from the local node
node bin/blaketestnode.mjs sync --no-scripts                           # skip signature checks
node tools/export-blocks.mjs --loop 20                                 # keep the served block file current (needs a node)
```

Options: `--data <dir>` (default `~/.blaketestnode/txbt4`), `--source http|rpc`,
`--conf <bitcoin.conf>`, `--to <height>`, `--no-scripts`. The engine is loaded from `$SCHEMA` or
`~/bitcoin-desktop/schema`; it needs bitcoin-desktop/schema v0.0.27 or later (unified sighash, pay-to-anchor).

## Snapshot

| | |
|---|---|
| base | 150,307 `000000000017ec2251d81c8d2ca401c713e98e85196c7f660a4088a7ca57b1cc` (last block shared with Core) |
| txoutset_hash | `372bfcaeef1e93892acccda9e700b00bf90f45d73746d69959d33620a3df5518` |
| coins | 14,230,182 in 9,356,185 txids, 869,836,053 bytes |
| infohash | `242e9b7dcba15cc0ed8f1bc5f06b68da008f87c0` |
| webseed | https://melvin.me/datstr/snapshots/utxo-knots-150307.dat |

## Benchmark (14 Sep 2026, one core of a desktop, Node 24)

| step | result |
|---|---|
| torrent fetch | 870 MB in 9.8 s, 85 MiB/s (webseed + one peer) |
| sha256 of file | 1.8 s |
| parse + hash_serialized_3 | 26 s, 545k coins/s, 3.5 GB RSS |
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
- `lib/utxo.mjs` UTXO set: snapshot coins as byte offsets, decoded on read
- `lib/fetch.mjs` WebTorrent fetch and sha256
- `lib/blockfile.mjs`, `lib/source.mjs` the block file format and the http/rpc block sources
- `lib/nip333.mjs` the chain tip from NIP-333 header events
- `tools/export-blocks.mjs` keeps the served block file current from a node
- `lib/engine.mjs`, `lib/rpc.mjs` engine and node RPC loaders
- `bin/blaketestnode.mjs` the CLI
