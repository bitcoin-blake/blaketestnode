// MuHash3072, byte-for-byte as Bitcoin Core computes it for `gettxoutsetinfo muhash`: every coin
// hashes to a 3072-bit number (SHA256 of its serialisation keys a ChaCha20 keystream), the set is
// the product of those numbers mod p = 2^3072 - 1103717, and the digest is SHA256 of the product.
// Adding a coin multiplies, removing divides, so the value of a set at one height carries to the
// next by the coins created and spent in between — no need to touch the coins that stayed.
import { sha256 } from './sha256.mjs';
import { bytesToHex, hexToBytes, reverse, putU32le, putI64le, concat } from './bytes.mjs';
import { writeCompactSize } from './varint.mjs';

export const P = (1n << 3072n) - 1103717n;
export const BYTES = 384;

// ---- ChaCha20 keystream (RFC 8439 block function; nonce and counter zero, as Core's ChaCha20Aligned{key}) ----
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];
const rotl = (v, c) => (v << c) | (v >>> (32 - c));
function chachaBlock(key, counter, out, off) {
  const s = new Uint32Array(16), x = new Uint32Array(16);
  s[0] = SIGMA[0]; s[1] = SIGMA[1]; s[2] = SIGMA[2]; s[3] = SIGMA[3];
  for (let i = 0; i < 8; i++) s[4 + i] = key[4 * i] | (key[4 * i + 1] << 8) | (key[4 * i + 2] << 16) | (key[4 * i + 3] << 24);
  s[12] = counter; // s[13..15] = nonce = 0
  x.set(s);
  const qr = (a, b, c, d) => {
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15);
    qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) { const v = (x[i] + s[i]) >>> 0; out[off + 4 * i] = v & 0xff; out[off + 4 * i + 1] = (v >>> 8) & 0xff; out[off + 4 * i + 2] = (v >>> 16) & 0xff; out[off + 4 * i + 3] = v >>> 24; }
}
export function chacha20Keystream(key, length) {
  const out = new Uint8Array(length);
  for (let i = 0, c = 0; i < length; i += 64, c++) chachaBlock(key, c, out, i);
  return out;
}

// ---- Num3072 <-> bytes (little-endian, as Core's limbs) ----
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export function numFromBytesLE(b) { let h = ''; for (let i = b.length - 1; i >= 0; i--) h += HEX[b[i]]; return BigInt('0x' + h); }
export function numToBytesLE(n, len = BYTES) { const h = n.toString(16).padStart(len * 2, '0'); const out = new Uint8Array(len); for (let i = 0; i < len; i++) out[len - 1 - i] = parseInt(h.substr(2 * i, 2), 16); return out; }

// the 3072-bit number for one element: SHA256(data) keys a ChaCha20 keystream of 384 bytes, read little-endian
export function toNum3072(data) { return numFromBytesLE(chacha20Keystream(sha256(data), BYTES)); }

export function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
export const inverse = (a) => modpow(a, P - 2n, P);

// numerator / denominator, combined only when a value is asked for (one inversion)
export class MuHash3072 {
  constructor(numerator = 1n, denominator = 1n) { this.num = numerator; this.den = denominator; }
  static fromValue(v) { return new MuHash3072(BigInt.asUintN(3072, v) % P, 1n); }
  insert(data) { this.num = (this.num * toNum3072(data)) % P; return this; }
  remove(data) { this.den = (this.den * toNum3072(data)) % P; return this; }
  insertNum(n) { this.num = (this.num * n) % P; return this; }
  removeNum(n) { this.den = (this.den * n) % P; return this; }
  // the set's value: a 3072-bit number mod p; the state carries on from it
  value() { if (this.den !== 1n) { this.num = (this.num * inverse(this.den)) % P; this.den = 1n; } return this.num; }
  // Core's digest of that value, as gettxoutsetinfo prints it
  digest() { return digestOf(this.value()); }
}
export const digestOf = (value) => bytesToHex(reverse(sha256(numToBytesLE(value))));
export const valueHex = (value) => bytesToHex(numToBytesLE(value));
export const valueFromHex = (hex) => { if (hex.length !== BYTES * 2) throw new Error(`muhash value: ${hex.length} hex chars, want ${BYTES * 2}`); return numFromBytesLE(hexToBytes(hex)); };

// Core's TxOutSer for a coin: COutPoint (txid raw, vout u32le), u32le height*2+coinbase, CTxOut (i64le value, script)
// key "txid:vout", coin as the kernel keeps it: { output: { value, scriptPubKey }, height, coinbase }
export function coinBytes(key, coin) {
  const i = key.indexOf(':');
  const script = hexToBytes(coin.output.scriptPubKey);
  const head = new Uint8Array(32 + 4 + 4 + 8);
  head.set(reverse(hexToBytes(key.slice(0, i))), 0);
  putU32le(head, 32, Number(key.slice(i + 1)));
  putU32le(head, 36, coin.height * 2 + (coin.coinbase ? 1 : 0));
  putI64le(head, 40, coin.output.value);
  return concat(head, writeCompactSize(script.length), script);
}
export const coinNum = (key, coin) => toNum3072(coinBytes(key, coin));
