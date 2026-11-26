// Ethereum helpers for the worker: keccak-256, personal_sign recovery, ERC-20 balance.
const RC=[0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
const ROT=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M=(1n<<64n)-1n;const rl=(v,n)=>n?((v<<BigInt(n))|(v>>BigInt(64-n)))&M:v;
function f(s){for(let r=0;r<24;r++){const C=[];for(let x=0;x<5;x++)C[x]=s[x]^s[x+5]^s[x+10]^s[x+15]^s[x+20];for(let x=0;x<5;x++){const D=C[(x+4)%5]^rl(C[(x+1)%5],1);for(let y=0;y<25;y+=5)s[y+x]^=D;}const B=new Array(25);for(let x=0;x<5;x++)for(let y=0;y<5;y++)B[y+5*((2*x+3*y)%5)]=rl(s[x+5*y],ROT[x+5*y]);for(let x=0;x<5;x++)for(let y=0;y<25;y+=5)s[y+x]=B[y+x]^((~B[y+(x+1)%5])&M&B[y+(x+2)%5]);s[0]^=RC[r];}}
export function keccak256(bytes){const rate=136;const p=new Uint8Array(Math.ceil((bytes.length+1)/rate)*rate);p.set(bytes);p[bytes.length]^=1;p[p.length-1]^=0x80;const s=new Array(25).fill(0n);for(let o=0;o<p.length;o+=rate){for(let i=0;i<rate/8;i++){let v=0n;for(let b=7;b>=0;b--)v=(v<<8n)|BigInt(p[o+i*8+b]);s[i]^=v;}f(s);}let out='';for(let i=0;i<4;i++){let v=s[i];for(let b=0;b<8;b++){out+=Number(v&0xffn).toString(16).padStart(2,'0');v>>=8n;}}return out;}
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) { let [lm, hm, low, high] = [1n, 0n, mod(a, m), m]; while (low > 1n) { const r = high / low; [lm, hm] = [hm - lm * r, lm]; [low, high] = [high - low * r, low]; } return mod(lm, m); }
function pow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function jDouble([x, y, z]) { if (y === 0n) return [0n, 0n, 0n]; const ysq = y * y % P, s = 4n * x * ysq % P, m = 3n * x * x % P; const nx = mod(m * m - 2n * s); const ny = mod(m * (s - nx) - 8n * ysq * ysq); const nz = 2n * y * z % P; return [nx, ny, nz]; }
function jAdd(p, q) {
  const [x1, y1, z1] = p, [x2, y2, z2] = q;
  if (z1 === 0n) return q; if (z2 === 0n) return p;
  const z1s = z1 * z1 % P, z2s = z2 * z2 % P;
  const u1 = x1 * z2s % P, u2 = x2 * z1s % P, s1 = y1 * z2s % P * z2 % P, s2 = y2 * z1s % P * z1 % P;
  if (u1 === u2) return s1 === s2 ? jDouble(p) : [0n, 0n, 0n];
  const h = mod(u2 - u1), r = mod(s2 - s1), h2 = h * h % P, h3 = h2 * h % P, u1h2 = u1 * h2 % P;
  const nx = mod(r * r - h3 - 2n * u1h2), ny = mod(r * (u1h2 - nx) - s1 * h3), nz = h * z1 % P * z2 % P;
  return [nx, ny, nz];
}
function jMul2(a, A, b, B) { // a*A + b*B (Shamir)
  const AB = jAdd(A, B); let R = [0n, 0n, 0n];
  for (let i = 255; i >= 0; i--) { R = jDouble(R); const ba = (a >> BigInt(i)) & 1n, bb = (b >> BigInt(i)) & 1n; if (ba && bb) R = jAdd(R, AB); else if (ba) R = jAdd(R, A); else if (bb) R = jAdd(R, B); }
  return R;
}
function toAffine([x, y, z]) { if (z === 0n) return null; const zi = inv(z), zi2 = zi * zi % P; return [x * zi2 % P, y * zi2 % P * zi % P]; }
function recoverPub(hashHex, sigHex) {
  const s0 = sigHex.replace(/^0x/, ''); if (s0.length !== 130) throw new Error('bad signature');
  const r = BigInt('0x' + s0.slice(0, 64)), s = BigInt('0x' + s0.slice(64, 128)); let v = parseInt(s0.slice(128, 130), 16);
  if (v >= 27) v -= 27; if (v > 1 || r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('bad signature');
  const x = r, y2 = mod(x * x * x + 7n); let y = pow(y2, (P + 1n) / 4n, P);
  if (y * y % P !== y2) throw new Error('bad signature');
  if ((y & 1n) !== BigInt(v)) y = P - y;
  const e = BigInt('0x' + hashHex) % N, ri = inv(r, N);
  const u1 = mod(-e * ri, N), u2 = s * ri % N;
  const Q = toAffine(jMul2(u1, [GX, GY, 1n], u2, [x, y, 1n]));
  if (!Q) throw new Error('bad signature');
  return Q;
}

const hexBytes = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
export function personalSigner(message, signature) {
  const te = new TextEncoder();
  const m = te.encode(message);
  const h = keccak256(new Uint8Array([...te.encode('\x19Ethereum Signed Message:\n' + m.length), ...m]));
  const [x, y] = recoverPub(h, signature);
  const pub = hexBytes(x.toString(16).padStart(64, '0') + y.toString(16).padStart(64, '0'));
  return '0x' + keccak256(pub).slice(24);
}
export async function erc20Balance(rpc, token, owner) {
  const data = '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: token, data }, 'latest'] }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return BigInt(j.result && j.result !== '0x' ? j.result : '0x0');
}
