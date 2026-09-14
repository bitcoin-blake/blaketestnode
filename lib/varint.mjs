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

// ---- the inverse direction, for writing snapshots ----
export function writeVarint(n) {
  const out = [];
  for (;;) { out.push((n % 128) | (out.length ? 0x80 : 0)); if (n <= 0x7f) break; n = Math.floor(n / 128) - 1; }
  return Buffer.from(out.reverse());
}
export function compressAmount(n) {
  if (n === 0) return 0;
  let e = 0;
  while (n % 10 === 0 && e < 9) { n /= 10; e++; }
  if (e < 9) { const d = n % 10; n = (n - d) / 10; return 1 + (n * 9 + d - 1) * 10 + e; }
  return 1 + (n - 1) * 10 + 9;
}
const onCurve = (pub65) => { // uncompressed key with a valid point: Core only compresses those
  const x = BigInt('0x' + pub65.subarray(1, 33).toString('hex')), y = BigInt('0x' + pub65.subarray(33, 65).toString('hex'));
  return x < P && y < P && (y * y - (x * x * x + 7n)) % P === 0n;
};
export function compressScript(s) {
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 20 && s[23] === 0x88 && s[24] === 0xac) return Buffer.concat([writeVarint(0), s.subarray(3, 23)]);
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 20 && s[22] === 0x87) return Buffer.concat([writeVarint(1), s.subarray(2, 22)]);
  if (s.length === 35 && s[0] === 33 && (s[1] === 2 || s[1] === 3) && s[34] === 0xac) return Buffer.concat([writeVarint(s[1]), s.subarray(2, 34)]);
  if (s.length === 67 && s[0] === 65 && s[1] === 4 && s[66] === 0xac && onCurve(s.subarray(1, 66))) return Buffer.concat([writeVarint(4 | (s[65] & 1)), s.subarray(2, 34)]);
  return Buffer.concat([writeVarint(s.length + 6), s]);
}
export function writeCoin({ height, coinbase, value, script }) {
  return Buffer.concat([writeVarint(height * 2 + (coinbase ? 1 : 0)), writeVarint(compressAmount(value)), compressScript(script)]);
}
