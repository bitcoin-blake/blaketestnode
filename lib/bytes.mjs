// Byte helpers that work in Node and the browser alike (no Buffer).
export const hexToBytes = (h) => { const out = new Uint8Array(h.length >> 1); for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out; };
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
export const bytesToHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
export const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
export const u64le = (b, o) => u32le(b, o) + u32le(b, o + 4) * 0x100000000; // safe below 2^53
export const putU16le = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >> 8) & 0xff; };
export const putU32le = (b, o, v) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff; };
export const putU64le = (b, o, v) => { putU32le(b, o, v % 0x100000000); putU32le(b, o + 4, Math.floor(v / 0x100000000)); };
export const putI64le = (b, o, v) => { let t = BigInt.asUintN(64, BigInt(v)); for (let i = 0; i < 8; i++) { b[o + i] = Number(t & 0xffn); t >>= 8n; } };
export const equalBytes = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
// lexicographic compare of a[aOff..aOff+n) vs b[bOff..bOff+n): -1, 0, 1
export const compareBytes = (a, aOff, b, bOff, n) => { for (let i = 0; i < n; i++) { const x = a[aOff + i], y = b[bOff + i]; if (x !== y) return x < y ? -1 : 1; } return 0; };
export const reverse = (b) => Uint8Array.from(b).reverse();
