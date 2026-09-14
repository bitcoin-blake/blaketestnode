// The chain this node follows, and the snapshot it starts from. One file, so
// the mainnet copy is a parameter change.
export const CHAIN = {
  network: 'btc:testnet4-blake2b',
  alias: 'txbt4',
  forkHeight: 150308,           // first BLAKE2b block
  networkMagic: '1c163f28',     // testnet4 P2P message start, as written in the snapshot header
  retargetInterval: 2016,
  conf: '~/knots-testnet4/bitcoin.conf',
  // block file + index (<url>.dat and <url>.json, Range requests and CORS) as a datstr gateway's
  // --files directory serves them; no default host: pass --blocks-url or BLAKETESTNODE_BLOCKS_URL
  blocksUrl: (typeof process !== 'undefined' && process.env?.BLAKETESTNODE_BLOCKS_URL) || null,
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
  trackers: ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://tracker.btorrent.xyz', 'udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce'],
  // optional HTTP webseed for the snapshot (a plain file URL with Range + CORS): BLAKETESTNODE_WEBSEED
  webseed: (typeof process !== 'undefined' && process.env?.BLAKETESTNODE_WEBSEED) || null,
  nostrEvent: '86d79268db161d71abf13ceb1692b566a81c7a1bf3f9c1e1949729f0d53f9a64', // NIP-35 kind 2003
};
export const magnet = () => `magnet:?xt=urn:btih:${SNAPSHOT.infohash}&dn=${SNAPSHOT.file}` + SNAPSHOT.trackers.map((t) => `&tr=${encodeURIComponent(t)}`).join('') + (SNAPSHOT.webseed ? `&ws=${encodeURIComponent(SNAPSHOT.webseed)}` : '');
