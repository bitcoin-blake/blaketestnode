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
3. **sync**: fetch headers and blocks from a local Knots node over RPC, validate the header
   chain (BLAKE2b v2 headers, testnet4 min-difficulty rule, MTP, timewarp), then run the
   structural and contextual block rules against the UTXO set and apply each block.
   At the end the coin count is cross-checked against the node's `gettxoutsetinfo`.

```
node --max-old-space-size=8192 bin/blaketestnode.mjs bench            # fetch, verify, sync
node bin/blaketestnode.mjs verify --data ./data                        # snapshot only
node bin/blaketestnode.mjs sync --no-scripts                           # skip signature checks
```

Options: `--data <dir>` (default `~/.blaketestnode/txbt4`), `--conf <bitcoin.conf>`,
`--to <height>`, `--no-scripts`. The engine is loaded from `$SCHEMA` or
`~/bitcoin-desktop/schema`; it needs bitcoin-desktop/schema v0.0.26 or later (the unified
sighash).

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
| headers 150,308 to 151,070 | 763 validated, 0 failed, 148 ms |
| blocks, scripts off | 763 blocks, 5,045 txs, 2.5 s (300 blocks/s) |
| blocks, scripts on | 51 s, 0 failures on engine v0.0.26 (16 script failures on v0.0.25) |
| UTXO count vs node | 14,233,495 both, match |

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
- `lib/engine.mjs`, `lib/rpc.mjs` engine and node RPC loaders
- `bin/blaketestnode.mjs` the CLI
