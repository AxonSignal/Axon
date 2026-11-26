// AXON core: encoding, crypto, wallet, api. Everything sensitive happens here, in the browser.
(() => {
  const cfg = window.AXON_CONFIG;
  const te = new TextEncoder(), td = new TextDecoder();
  const subtle = crypto.subtle;

  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const unhex = (h) => new Uint8Array((h.replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const rid = () => hex(rand(16));
  const sha = async (bytes) => hex(await subtle.digest('SHA-256', bytes));

  async function hkdf(ikm, info, len = 32) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('axon-v1'), info: te.encode(info) }, k, len * 8));
  }
  const aes = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  async function seal(key, data) {
    const iv = rand(12);
    const pt = data instanceof Uint8Array ? data : te.encode(typeof data === 'string' ? data : JSON.stringify(data));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
    return b64(iv) + '.' + b64(ct);
  }
  async function openBytes(key, s) {
    const [iv, ct] = s.split('.');
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
  }
  const openText = async (key, s) => td.decode(await openBytes(key, s));
  const openJSON = async (key, s) => JSON.parse(await openText(key, s));

  // Inbox: apps encrypt suggestions to the vault's ECDH public key.
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  async function newInboxKeys(master) {
    const kp = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const pub = await subtle.exportKey('jwk', kp.publicKey);
    const priv = await subtle.exportKey('jwk', kp.privateKey);
    return { inbox_pub: JSON.stringify(pub), inbox_priv: await seal(master, priv) };
  }
  async function openInbox(privJwk, blob) {
    const { epk, c } = JSON.parse(blob);
    const priv = await subtle.importKey('jwk', privJwk, ECDH, false, ['deriveBits']);
    const pub = await subtle.importKey('jwk', epk, ECDH, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
    return openJSON(await aes(await hkdf(shared, 'axon-inbox')), c);
  }

  // Vault keys come from one wallet signature. The server only ever sees `auth`.
  const SIGN_MSG = (addr) => `AXON vault\n\nSign to open your encrypted memory vault.\nThis is free and sends no transaction.\n\nWallet: ${addr.toLowerCase()}`;
  async function vaultKeysFromSig(sig) {
    const ikm = unhex(sig);
    const auth = hex(await hkdf(ikm, 'axon-vault-auth'));
    const master = await aes(await hkdf(ikm, 'axon-vault-master'));
    return { auth, master };
  }
  async function appKeysFromSecret(secret) {
    const raw = unb64url(secret.replace(/^axon_/, ''));
    const auth = hex(await hkdf(raw, 'axon-app-auth'));
    const id = await sha(unhex(auth));
    const wrap = await aes(await hkdf(raw, 'axon-app-wrap'));
    return { auth, id, wrap };
  }
  const newAppSecret = () => 'axon_' + b64url(rand(32));

  // ---------- wallet (never connects on its own) ----------
  const providers = [];
  window.addEventListener('eip6963:announceProvider', (e) => {
    if (!providers.find((p) => p.info.uuid === e.detail.info.uuid)) providers.push(e.detail);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const wallet = { provider: null, address: null, name: null };
  function listWallets() {
    const list = providers.map((p) => ({ name: p.info.name, icon: p.info.icon, provider: p.provider }));
    if (!list.length && window.ethereum) list.push({ name: 'Browser wallet', icon: '', provider: window.ethereum });
    return list;
  }
  async function connect(w) {
    const accs = await w.provider.request({ method: 'eth_requestAccounts' });
    if (!accs || !accs[0]) throw new Error('No account selected.');
    wallet.provider = w.provider; wallet.address = accs[0]; wallet.name = w.name;
    if (w.provider.on) w.provider.on('accountsChanged', (a) => { if (!a[0] || a[0].toLowerCase() !== (wallet.address || '').toLowerCase()) window.dispatchEvent(new Event('axon:wallet-changed')); });
    return wallet.address;
  }
  async function disconnect() {
    const p = wallet.provider;
    wallet.provider = null; wallet.address = null; wallet.name = null;
    try { await p?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch (_) {}
  }
  async function signVault() {
    const msg = SIGN_MSG(wallet.address);
    const data = '0x' + hex(te.encode(msg));
    return wallet.provider.request({ method: 'personal_sign', params: [data, wallet.address] });
  }

  // ---------- api ----------
  async function api(path, { method = 'GET', body, token } = {}) {
    const r = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status}).`); e.status = r.status; throw e; }
    return j;
  }

  // ---------- seals ----------
  async function parent(a, b) { const u = new Uint8Array(64); u.set(unhex(a)); u.set(unhex(b), 32); return sha(u); }
  async function rootFromProof(leaf, index, proof) {
    let h = leaf, i = index;
    for (const sib of proof) { h = i % 2 ? await parent(sib, h) : await parent(h, sib); i = Math.floor(i / 2); }
    return h;
  }
  async function leafOf(read) {
    return sha(te.encode(`${read.id}|${read.vault_id}|${read.app_id}|${read.folders}|${read.items}|${read.ts}`));
  }
  async function onchainRoot(contract, hour) {
    const data = '0x1e3f0320' + BigInt(hour).toString(16).padStart(64, '0'); // roots(uint64)
    const r = await fetch(cfg.RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'RPC error');
    return (j.result || '0x').replace(/^0x/, '');
  }

  const short = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? s.slice(0, a) + '…' + s.slice(-b) : s || '');
  const ago = (ts) => {
    const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago'; const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; return Math.round(h / 24) + ' days ago';
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.AX = { cfg, hex, unhex, b64, unb64, b64url, rand, rid, sha, hkdf, aes, seal, openBytes, openText, openJSON, newInboxKeys, openInbox,
    vaultKeysFromSig, appKeysFromSecret, newAppSecret, listWallets, connect, disconnect, signVault, wallet, api,
    rootFromProof, leafOf, onchainRoot, short, ago, esc, te, td };
})();
