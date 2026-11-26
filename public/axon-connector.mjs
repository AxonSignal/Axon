#!/usr/bin/env node
// AXON connector: a tiny MCP server (stdio). It decrypts your granted folders on this machine.
// Needs Node 18+. Set AXON_KEY to the app key you created in your vault.
import { webcrypto } from 'node:crypto';
import readline from 'node:readline';

const subtle = (globalThis.crypto || webcrypto).subtle;
const KEY = process.env.AXON_KEY || '';
const URL_BASE = (process.env.AXON_URL || 'https://axonsignal.fun').replace(/\/+$/, '');
const te = new TextEncoder(), td = new TextDecoder();
const log = (...a) => process.stderr.write('[axon] ' + a.join(' ') + '\n');

const hex = (b) => Buffer.from(b).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h, 'hex'));
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const unb64url = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
const b64 = (u) => Buffer.from(u).toString('base64');

async function hkdf(ikm, info, len = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: te.encode('axon-v1'), info: te.encode(info) }, k, len * 8));
}
const aes = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
async function open(key, s) {
  const [iv, ct] = s.split('.');
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct)));
}
async function sealWith(key, obj) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  return b64(iv) + '.' + b64(ct);
}

let keys = null;
async function appKeys() {
  if (keys) return keys;
  if (!/^axon_[A-Za-z0-9_-]{40,}$/.test(KEY)) throw new Error('AXON_KEY is missing or malformed. Create an app key in your vault and paste it in the connector config.');
  const raw = unb64url(KEY.slice(5));
  const auth = hex(await hkdf(raw, 'axon-app-auth'));
  const wrap = await aes(await hkdf(raw, 'axon-app-wrap'));
  keys = { auth, wrap };
  return keys;
}
async function call(path, opts = {}) {
  const { auth } = await appKeys();
  const r = await fetch(URL_BASE + path, { ...opts, headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `AXON request failed (${r.status})`);
  return j;
}

async function readFolders(want = 'all') {
  const { wrap } = await appKeys();
  const res = await call('/api/app/read?folders=' + encodeURIComponent(want));
  const fk = {};
  const folders = [];
  for (const f of res.folders) {
    const raw = await open(wrap, f.wrapped);
    fk[f.id] = await aes(raw);
    folders.push({ id: f.id, kind: f.kind, name: td.decode(await open(fk[f.id], f.name_ct)) });
  }
  const memories = [];
  for (const m of res.memories) {
    try {
      const d = JSON.parse(td.decode(await open(fk[m.folder_id], m.blob)));
      memories.push({ folder: folders.find((f) => f.id === m.folder_id)?.name, title: d.h || '', text: d.t || '', source: d.s || '', date: new Date(d.d || m.created).toISOString().slice(0, 10) });
    } catch (_) { /* skip unreadable */ }
  }
  return { folders, memories };
}
async function listFolders() {
  const { wrap } = await appKeys();
  const res = await call('/api/app/me');
  const out = [];
  for (const f of res.folders) {
    const k = await aes(await open(wrap, f.wrapped));
    out.push({ id: f.id, kind: f.kind, name: td.decode(await open(k, f.name_ct)), memories: f.count });
  }
  return { folders: out, inbox_pub: res.inbox_pub };
}
const fmt = (ms) => ms.map((m) => `• [${m.date}] ${m.folder}${m.title ? ' / ' + m.title : ''}\n${m.text}`).join('\n\n') || 'No memories here yet.';

const TOOLS = [
  { name: 'axon_self', description: "Read the user's self card: who they are and how they like answers. Call this first in a new conversation.", inputSchema: { type: 'object', properties: {} } },
  { name: 'axon_folders', description: 'List the memory folders this app is allowed to read.', inputSchema: { type: 'object', properties: {} } },
  { name: 'axon_read_folder', description: 'Read every memory in one allowed folder.', inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'Folder name or id' } }, required: ['folder'] } },
  { name: 'axon_search', description: "Search the user's allowed memories by words.", inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'axon_suggest', description: "Suggest a new memory. It waits in the user's inbox until they keep or reject it.", inputSchema: { type: 'object', properties: { text: { type: 'string' }, title: { type: 'string' } }, required: ['text'] } },
];

async function runTool(name, args = {}) {
  if (name === 'axon_self') {
    const me = await listFolders();
    const self = me.folders.find((f) => f.kind === 'self');
    if (!self) return 'This app was not given the self card.';
    const { memories } = await readFolders(self.id);
    return fmt(memories);
  }
  if (name === 'axon_folders') {
    const me = await listFolders();
    return me.folders.map((f) => `${f.name} (${f.memories} ${f.memories === 1 ? "memory" : "memories"})${f.kind === 'self' ? ' [self card]' : ''}`).join('\n') || 'No folders granted.';
  }
  if (name === 'axon_read_folder') {
    const me = await listFolders();
    const q = String(args.folder || '').toLowerCase();
    const f = me.folders.find((x) => x.id === q || x.name.toLowerCase() === q) || me.folders.find((x) => x.name.toLowerCase().includes(q));
    if (!f) return 'No allowed folder matches that name.';
    return fmt((await readFolders(f.id)).memories);
  }
  if (name === 'axon_search') {
    const words = String(args.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const { memories } = await readFolders('all');
    const scored = memories.map((m) => {
      const hay = (m.title + ' ' + m.text).toLowerCase();
      return { m, s: words.reduce((a, w) => a + (hay.split(w).length - 1), 0) };
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 12).map((x) => x.m);
    return scored.length ? fmt(scored) : 'Nothing matches.';
  }
  if (name === 'axon_suggest') {
    const me = await listFolders();
    const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
    const pub = await subtle.importKey('jwk', JSON.parse(me.inbox_pub), ECDH, false, []);
    const eph = await subtle.generateKey(ECDH, true, ['deriveBits']);
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
    const k = await aes(await hkdf(shared, 'axon-inbox'));
    const epk = await subtle.exportKey('jwk', eph.publicKey);
    const c = await sealWith(k, { t: String(args.text).slice(0, 8000), h: String(args.title || '').slice(0, 200), d: Date.now() });
    await call('/api/app/suggest', { method: 'POST', body: JSON.stringify({ blob: JSON.stringify({ epk, c }) }) });
    return 'Sent to the inbox. The user decides if it is kept.';
  }
  throw new Error('Unknown tool: ' + name);
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'axon', version: '1.0.0' }, instructions: "AXON holds the user's memory. Call axon_self at the start, then read or search only what helps." } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await runTool(params?.name, params?.arguments || {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'AXON: ' + e.message }], isError: true } });
      }
    }
    if (method === 'resources/list') return send({ jsonrpc: '2.0', id, result: { resources: [] } });
    if (method === 'prompts/list') return send({ jsonrpc: '2.0', id, result: { prompts: [] } });
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
});
log('ready on', URL_BASE);
