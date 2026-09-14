// The chain this node follows, and the snapshot it starts from. One file, so
// the mainnet copy is a parameter change.
export const CHAIN = {
  network: 'btc:testnet4-blake2b',
  alias: 'txbt4',
  forkHeight: 150308,           // first BLAKE2b block
  networkMagic: '1c163f28',     // testnet4 P2P message start, as written in the snapshot header
  retargetInterval: 2016,
  conf: '~/knots-testnet4/bitcoin.conf',
  // block file + index served by a datstr gateway (--files), Range requests and CORS
  blocksUrl: 'https://melvin.me/datstr/snapshots/txbt4-blocks',
  // NIP-333 header events for this chain: the independent word on where the tip is
  nip333: { d: 'tbtc4b2', pubkey: 'cccccc0a8338a4aba51691f309f2f892c6c58f655a1ec3fc30522c894c166d9c', relays: ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.nostr.band'] },
};
export const SNAPSHOT = {
  baseHeight: 150307,
  baseHash: '000000000017ec2251d81c8d2ca401c713e98e85196c7f660a4088a7ca57b1cc',
  txoutsetHash: '372bfcaeef1e93892acccda9e700b00bf90f45d73746d69959d33620a3df5518', // hash_serialized_3
  coins: 14230182,
  bytes: 869836053,
  sha256: '86118db3a692b7c64bd4d9aef51a401f09722b9e92acb2826e7e76ac964529cd',
  file: 'utxo-knots-150307.dat',
  infohash: '242e9b7dcba15cc0ed8f1bc5f06b68da008f87c0',
  magnet: 'magnet:?xt=urn:btih:242e9b7dcba15cc0ed8f1bc5f06b68da008f87c0&dn=utxo-knots-150307.dat&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=wss%3A%2F%2Ftracker.webtorrent.dev&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce&ws=https%3A%2F%2Fmelvin.me%2Fdatstr%2Fsnapshots%2Futxo-knots-150307.dat',
  webseed: 'https://melvin.me/datstr/snapshots/utxo-knots-150307.dat',
  manifest: 'https://melvin.me/datstr/snapshots/utxo-knots-150307.json',
  nostrEvent: '86d79268db161d71abf13ceb1692b566a81c7a1bf3f9c1e1949729f0d53f9a64', // NIP-35 kind 2003
};
