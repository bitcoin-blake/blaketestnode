// Core's serialization primitives used by dumptxoutset: VARINT (MSB base-128
// with the +1 per byte trick), CompactSize, and the txout compressor.
export function readVarint(buf, pos) {
  let n = 0;
  for (;;) {
    const b = buf[pos++];
    n = n * 128 + (b & 0x7f);
    if (b & 0x80) n += 1; else return [n, pos];
  }
}
export function readCompactSize(buf, pos) {
  const b = buf[pos];
  if (b < 253) return [b, pos + 1];
  if (b === 253) return [buf.readUInt16LE(pos + 1), pos + 3];
  if (b === 254) return [buf.readUInt32LE(pos + 1), pos + 5];
  return [Number(buf.readBigUInt64LE(pos + 1)), pos + 9];
}
export function writeCompactSize(n) {
  if (n < 253) return Buffer.from([n]);
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 253; b.writeUInt16LE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = 254; b.writeUInt32LE(n, 1); return b;
}
export function decompressAmount(x) {
  if (x === 0) return 0;
  x -= 1;
  const e = x % 10; x = Math.floor(x / 10);
  let n;
  if (e < 9) { const d = (x % 9) + 1; x = Math.floor(x / 9); n = x * 10 + d; } else n = x + 1;
  for (let i = 0; i < e; i++) n *= 10;
  return n;
}
const P = (1n << 256n) - (1n << 32n) - 977n;
const modpow = (b, e, m) => { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
function decompressPubkey(prefix, x32) {
  const x = BigInt('0x' + x32.toString('hex'));
  let y = modpow((x * x * x + 7n) % P, (P + 1n) / 4n, P);
  if ((y & 1n) !== BigInt(prefix & 1)) y = P - y;
  const out = Buffer.alloc(65); out[0] = 4; x32.copy(out, 1); Buffer.from(y.toString(16).padStart(64, '0'), 'hex').copy(out, 33);
  return out;
}
// Reads a compressed script at pos; returns [scriptBuffer, newPos].
export function readCompressedScript(buf, pos) {
  let nSize; [nSize, pos] = readVarint(buf, pos);
  switch (nSize) {
    case 0: return [Buffer.concat([Buffer.from([0x76, 0xa9, 20]), buf.subarray(pos, pos + 20), Buffer.from([0x88, 0xac])]), pos + 20];
    case 1: return [Buffer.concat([Buffer.from([0xa9, 20]), buf.subarray(pos, pos + 20), Buffer.from([0x87])]), pos + 20];
    case 2: case 3: return [Buffer.concat([Buffer.from([33, nSize]), buf.subarray(pos, pos + 32), Buffer.from([0xac])]), pos + 32];
    case 4: case 5: return [Buffer.concat([Buffer.from([65]), decompressPubkey(nSize - 2, buf.subarray(pos, pos + 32)), Buffer.from([0xac])]), pos + 32];
    default: { const len = nSize - 6; return [buf.subarray(pos, pos + len), pos + len]; }
  }
}
// A coin as dumptxoutset writes it: VARINT(height*2+coinbase), compressed amount, compressed script.
export function readCoin(buf, pos) {
  let code, amount, script;
  [code, pos] = readVarint(buf, pos);
  [amount, pos] = readVarint(buf, pos);
  [script, pos] = readCompressedScript(buf, pos);
  return [{ height: Math.floor(code / 2), coinbase: code % 2 === 1, value: decompressAmount(amount), script }, pos];
}
