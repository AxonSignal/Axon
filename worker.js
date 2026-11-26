// AXON worker: stores ciphertext only. Keys never reach this server.
// The only readable data is what an owner publishes on purpose to their Signal.
import { signalRoutes, signalPage } from './signal.js';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', ...CORS } });
const E = (msg, s = 400) => J({ error: msg }, s);

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const sha = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
const shaText = (s) => sha(new TextEncoder().encode(s));
const rid = () => hex(crypto.getRandomValues(new Uint8Array(16)));
const isHex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-f]+$/.test(s);
const isStr = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

const LIMITS = { blob: 65536, memories: 5000, folders: 64, apps: 32, inbox: 200, batch: 100 };

async function bearerId(req) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([0-9a-f]{64})$/);
  return m ? sha(unhex(m[1])) : null;
}

async function logRead(env, vault_id, app_id, folderIds, items) {
  const ts = Date.now();
  const id = rid();
  const folders = folderIds.slice().sort().join(',');
  const leaf = await shaText(`${id}|${vault_id}|${app_id}|${folders}|${items}|${ts}`);
  await env.DB.prepare('INSERT INTO reads (id, vault_id, app_id, folders, items, ts, hour, leaf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(id, vault_id, app_id, folders, items, ts, Math.floor(ts / 3600000), leaf).run();
  return id;
}

async function wipeVault(db, vid) {
  const apps = (await db.prepare('SELECT id FROM apps WHERE vault_id = ?').bind(vid).all()).results;
  const stmts = apps.map((a) => db.prepare('DELETE FROM grants WHERE app_id = ?').bind(a.id));
  for (const t of ['apps', 'folders', 'memories', 'inbox', 'reads', 'signals']) stmts.push(db.prepare(`DELETE FROM ${t} WHERE vault_id = ?`).bind(vid));
  stmts.push(db.prepare('DELETE FROM vaults WHERE id = ?').bind(vid));
  stmts.push(db.prepare('DELETE FROM demo_vaults WHERE id = ?').bind(vid));
  await db.batch(stmts);
}
async function wipeOldDemos(env) {
  const old = (await env.DB.prepare('SELECT id FROM demo_vaults WHERE created < ? LIMIT 50').bind(Date.now() - 6 * 3600e3).all()).results;
  for (const r of old) await wipeVault(env.DB, r.id);
}

// ---------- Merkle (sha256, duplicate last on odd levels) ----------
async function parent(a, b) {
  const buf = new Uint8Array(64);
  buf.set(unhex(a), 0);
  buf.set(unhex(b), 32);
  return sha(buf);
}
async function merkleRoot(leaves) {
  let lvl = leaves.slice();
  if (!lvl.length) return null;
  while (lvl.length > 1) {
    const next = [];
    for (let i = 0; i < lvl.length; i += 2) next.push(await parent(lvl[i], lvl[i + 1] ?? lvl[i]));
    lvl = next;
  }
  return lvl[0];
}
async function merkleProof(leaves, index) {
  const proof = [];
  let lvl = leaves.slice();
  let i = index;
  while (lvl.length > 1) {
    const sib = i % 2 ? lvl[i - 1] : (lvl[i + 1] ?? lvl[i]);
    proof.push(sib);
    const next = [];
    for (let k = 0; k < lvl.length; k += 2) next.push(await parent(lvl[k], lvl[k + 1] ?? lvl[k]));
    lvl = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

// ---------- sealing ----------
async function sealHours(env) {
  const now = Math.floor(Date.now() / 3600000);
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT hour FROM reads WHERE hour < ? AND hour NOT IN (SELECT hour FROM seals) ORDER BY hour LIMIT 48'
  ).bind(now).all();
  for (const { hour } of results) {
    const rows = (await env.DB.prepare('SELECT leaf FROM reads WHERE hour = ? ORDER BY seq').bind(hour).all()).results;
    const leaves = rows.map((r) => r.leaf);
    const root = await merkleRoot(leaves);
    if (!root) continue;
    const stmts = [env.DB.prepare('INSERT OR IGNORE INTO seals (hour, root, reads, tx, created) VALUES (?, ?, ?, NULL, ?)').bind(hour, root, leaves.length, Date.now())];
    leaves.forEach((leaf, idx) => stmts.push(env.DB.prepare('INSERT OR IGNORE INTO seal_leaves (hour, idx, leaf) VALUES (?, ?, ?)').bind(hour, idx, leaf)));
    for (let k = 0; k < stmts.length; k += 90) await env.DB.batch(stmts.slice(k, k + 90));
  }
}

// ---------- owner routes ----------
async function owner(req, env, ctx, path, url) {
  const vid = await bearerId(req);
  if (!vid) return E('Sign in with your wallet first.', 401);
  const db = env.DB;
  const body = (req.method === 'POST' || req.method === 'PUT') && !path.startsWith('/api/signal') ? await req.json().catch(() => ({})) : {};

  if (path === '/api/vault/open' && req.method === 'POST') {
    let v = await db.prepare('SELECT * FROM vaults WHERE id = ?').bind(vid).first();
    if (!v) {
      if (!isStr(body.inbox_pub, 2000) || !isStr(body.inbox_priv, 4000)) return E('Missing inbox keys.');
      await db.prepare('INSERT INTO vaults (id, inbox_pub, inbox_priv, created) VALUES (?, ?, ?, ?)').bind(vid, body.inbox_pub, body.inbox_priv, Date.now()).run();
      if (body.demo === true) await db.prepare('INSERT OR IGNORE INTO demo_vaults (id, created) VALUES (?, ?)').bind(vid, Date.now()).run();
      v = await db.prepare('SELECT * FROM vaults WHERE id = ?').bind(vid).first();
      return J({ created: true, vault: v, demo: body.demo === true });
    }
    return J({ created: false, vault: v, demo: !!(await db.prepare('SELECT id FROM demo_vaults WHERE id = ?').bind(vid).first()) });
  }

  const v = await db.prepare('SELECT id FROM vaults WHERE id = ?').bind(vid).first();
  if (!v) return E('No vault for this signature.', 404);

  if (path.startsWith('/api/signal')) {
    const r = await signalRoutes({ req, env, ctx, path, db, J, E, vid, isStr, rid, shaText, logRead: (...a) => logRead(env, ...a) });
    if (r) return r;
  }

  if (path === '/api/vault' && req.method === 'GET') {
    const [vault, folders, memories, apps, grants, inbox] = await Promise.all([
      db.prepare('SELECT * FROM vaults WHERE id = ?').bind(vid).first(),
      db.prepare('SELECT id, kind, name_ct, wrapped, created FROM folders WHERE vault_id = ? ORDER BY created').bind(vid).all(),
      db.prepare('SELECT id, folder_id, blob, created FROM memories WHERE vault_id = ? ORDER BY created DESC').bind(vid).all(),
      db.prepare('SELECT id, name_ct, created, last_used FROM apps WHERE vault_id = ? ORDER BY created').bind(vid).all(),
      db.prepare('SELECT g.app_id, g.folder_id FROM grants g JOIN apps a ON a.id = g.app_id WHERE a.vault_id = ?').bind(vid).all(),
      db.prepare('SELECT id, app_id, blob, created FROM inbox WHERE vault_id = ? ORDER BY created DESC').bind(vid).all(),
    ]);
    return J({ vault, folders: folders.results, memories: memories.results, apps: apps.results, grants: grants.results, inbox: inbox.results });
  }

  if (path === '/api/vault' && req.method === 'DELETE') {
    await wipeVault(db, vid);
    return J({ deleted: true });
  }

  if (path === '/api/folders' && req.method === 'POST') {
    const { id, kind = 'folder', name_ct, wrapped } = body;
    if (!isHex(id, 32) || !isStr(name_ct, 2000) || !isStr(wrapped, 400) || !['folder', 'self'].includes(kind)) return E('Bad folder.');
    const n = await db.prepare('SELECT COUNT(*) n FROM folders WHERE vault_id = ?').bind(vid).first();
    if (n.n >= LIMITS.folders) return E('Folder limit reached.');
    if (kind === 'self') {
      const s = await db.prepare("SELECT id FROM folders WHERE vault_id = ? AND kind = 'self'").bind(vid).first();
      if (s) return E('Self card already exists.');
    }
    await db.prepare('INSERT INTO folders (id, vault_id, kind, name_ct, wrapped, created) VALUES (?, ?, ?, ?, ?, ?)').bind(id, vid, kind, name_ct, wrapped, Date.now()).run();
    return J({ ok: true });
  }

  let m;
  if ((m = path.match(/^\/api\/folders\/([0-9a-f]{32})$/))) {
    const f = await db.prepare('SELECT id, kind FROM folders WHERE id = ? AND vault_id = ?').bind(m[1], vid).first();
    if (!f) return E('Folder not found.', 404);
    if (req.method === 'PUT') {
      if (!isStr(body.name_ct, 2000)) return E('Bad name.');
      await db.prepare('UPDATE folders SET name_ct = ? WHERE id = ?').bind(body.name_ct, f.id).run();
      return J({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (f.kind === 'self') return E('The self card folder cannot be deleted.');
      await db.batch([
        db.prepare('DELETE FROM memories WHERE folder_id = ?').bind(f.id),
        db.prepare('DELETE FROM grants WHERE folder_id = ?').bind(f.id),
        db.prepare('DELETE FROM folders WHERE id = ?').bind(f.id),
      ]);
      return J({ ok: true });
    }
  }

  if (path === '/api/memories' && req.method === 'POST') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > LIMITS.batch) return E('Send 1 to 100 memories at a time.');
    const folders = new Set((await db.prepare('SELECT id FROM folders WHERE vault_id = ?').bind(vid).all()).results.map((r) => r.id));
    const n = await db.prepare('SELECT COUNT(*) n FROM memories WHERE vault_id = ?').bind(vid).first();
    if (n.n + items.length > LIMITS.memories) return E('Memory limit reached (5,000).');
    const now = Date.now();
    const stmts = [];
    for (const it of items) {
      if (!isHex(it.id, 32) || !folders.has(it.folder_id) || !isStr(it.blob, LIMITS.blob)) return E('Bad memory.');
      const created = Number.isFinite(it.created) && it.created > 0 && it.created <= now ? Math.floor(it.created) : now;
      stmts.push(db.prepare('INSERT OR REPLACE INTO memories (id, vault_id, folder_id, blob, size, created) VALUES (?, ?, ?, ?, ?, ?)').bind(it.id, vid, it.folder_id, it.blob, it.blob.length, created));
    }
    await db.batch(stmts);
    return J({ ok: true, saved: items.length });
  }

  if ((m = path.match(/^\/api\/memories\/([0-9a-f]{32})$/)) && req.method === 'DELETE') {
    await db.prepare('DELETE FROM memories WHERE id = ? AND vault_id = ?').bind(m[1], vid).run();
    return J({ ok: true });
  }

  if (path === '/api/apps' && req.method === 'POST') {
    const { id, name_ct, grants = [] } = body;
    if (!isHex(id, 64) || !isStr(name_ct, 2000) || !Array.isArray(grants)) return E('Bad app.');
    const n = await db.prepare('SELECT COUNT(*) n FROM apps WHERE vault_id = ?').bind(vid).first();
    if (n.n >= LIMITS.apps) return E('App limit reached.');
    const folders = new Set((await db.prepare('SELECT id FROM folders WHERE vault_id = ?').bind(vid).all()).results.map((r) => r.id));
    const stmts = [db.prepare('INSERT INTO apps (id, vault_id, name_ct, created) VALUES (?, ?, ?, ?)').bind(id, vid, name_ct, Date.now())];
    for (const g of grants) {
      if (!folders.has(g.folder_id) || !isStr(g.wrapped, 400)) return E('Bad grant.');
      stmts.push(db.prepare('INSERT INTO grants (app_id, folder_id, wrapped) VALUES (?, ?, ?)').bind(id, g.folder_id, g.wrapped));
    }
    await db.batch(stmts);
    return J({ ok: true });
  }

  if ((m = path.match(/^\/api\/apps\/([0-9a-f]{64})(\/grants)?$/))) {
    const a = await db.prepare('SELECT id FROM apps WHERE id = ? AND vault_id = ?').bind(m[1], vid).first();
    if (!a) return E('App not found.', 404);
    if (m[2] && req.method === 'PUT') {
      if (Array.isArray(body.keep)) {
        const keep = body.keep.filter((x) => isHex(x, 32));
        const q = keep.length ? `DELETE FROM grants WHERE app_id = ? AND folder_id NOT IN (${keep.map(() => '?').join(',')})` : 'DELETE FROM grants WHERE app_id = ?';
        await db.prepare(q).bind(a.id, ...keep).run();
        return J({ ok: true });
      }
      const grants = Array.isArray(body.grants) ? body.grants : [];
      const folders = new Set((await db.prepare('SELECT id FROM folders WHERE vault_id = ?').bind(vid).all()).results.map((r) => r.id));
      const stmts = [db.prepare('DELETE FROM grants WHERE app_id = ?').bind(a.id)];
      for (const g of grants) {
        if (!folders.has(g.folder_id) || !isStr(g.wrapped, 400)) return E('Bad grant.');
        stmts.push(db.prepare('INSERT INTO grants (app_id, folder_id, wrapped) VALUES (?, ?, ?)').bind(a.id, g.folder_id, g.wrapped));
      }
      await db.batch(stmts);
      return J({ ok: true });
    }
    if (!m[2] && req.method === 'DELETE') {
      await db.batch([db.prepare('DELETE FROM grants WHERE app_id = ?').bind(a.id), db.prepare('DELETE FROM apps WHERE id = ?').bind(a.id)]);
      return J({ revoked: true });
    }
  }

  if ((m = path.match(/^\/api\/inbox\/([0-9a-f]{32})$/)) && req.method === 'DELETE') {
    await db.prepare('DELETE FROM inbox WHERE id = ? AND vault_id = ?').bind(m[1], vid).run();
    return J({ ok: true });
  }

  if (path === '/api/log' && req.method === 'GET') {
    const reads = (await db.prepare('SELECT id, app_id, folders, items, ts, hour, leaf FROM reads WHERE vault_id = ? ORDER BY seq DESC LIMIT 300').bind(vid).all()).results;
    const hours = [...new Set(reads.map((r) => r.hour))];
    let seals = [];
    if (hours.length) {
      seals = (await db.prepare(`SELECT hour, root, reads, tx FROM seals WHERE hour IN (${hours.map(() => '?').join(',')})`).bind(...hours).all()).results;
    }
    return J({ reads, seals, contract: env.SEAL_CONTRACT || '' });
  }

  if ((m = path.match(/^\/api\/proof\/([0-9a-f]{32})$/)) && req.method === 'GET') {
    const r = await db.prepare('SELECT * FROM reads WHERE id = ? AND vault_id = ?').bind(m[1], vid).first();
    if (!r) return E('Read not found.', 404);
    const s = await db.prepare('SELECT * FROM seals WHERE hour = ?').bind(r.hour).first();
    if (!s) return E('This hour is not sealed yet. Seals close a few minutes after each hour.', 409);
    const leaves = (await db.prepare('SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx').bind(r.hour).all()).results.map((x) => x.leaf);
    const index = leaves.indexOf(r.leaf);
    if (index < 0) return E('Read missing from its seal.', 500);
    return J({
      read: { id: r.id, vault_id: r.vault_id, app_id: r.app_id, folders: r.folders, items: r.items, ts: r.ts },
      leaf: r.leaf, index, proof: await merkleProof(leaves, index), root: s.root, hour: s.hour, reads: s.reads, tx: s.tx, contract: env.SEAL_CONTRACT || '',
    });
  }

  return E('Not found.', 404);
}

// ---------- connected app routes ----------
async function app(req, env, path, url) {
  const aid = await bearerId(req);
  if (!aid) return E('Missing app key.', 401);
  const db = env.DB;
  const a = await db.prepare('SELECT * FROM apps WHERE id = ?').bind(aid).first();
  if (!a) return E('This app key was revoked or never existed.', 401);
  const grants = (await db.prepare('SELECT g.folder_id, g.wrapped, f.kind, f.name_ct FROM grants g JOIN folders f ON f.id = g.folder_id WHERE g.app_id = ?').bind(aid).all()).results;

  if (path === '/api/app/me' && req.method === 'GET') {
    const v = await db.prepare('SELECT inbox_pub FROM vaults WHERE id = ?').bind(a.vault_id).first();
    const counts = (await db.prepare('SELECT folder_id, COUNT(*) n FROM memories WHERE vault_id = ? GROUP BY folder_id').bind(a.vault_id).all()).results;
    const cm = Object.fromEntries(counts.map((c) => [c.folder_id, c.n]));
    return J({ folders: grants.map((g) => ({ id: g.folder_id, kind: g.kind, name_ct: g.name_ct, wrapped: g.wrapped, count: cm[g.folder_id] || 0 })), inbox_pub: v.inbox_pub });
  }

  if (path === '/api/app/read' && req.method === 'GET') {
    const want = (url.searchParams.get('folders') || 'all').split(',');
    const allowed = grants.filter((g) => want.includes('all') || want.includes(g.folder_id));
    if (!allowed.length) return E('This app has no access to that folder.', 403);
    const ids = allowed.map((g) => g.folder_id);
    const memories = (await db.prepare(`SELECT id, folder_id, blob, created FROM memories WHERE folder_id IN (${ids.map(() => '?').join(',')}) ORDER BY created DESC LIMIT 2000`).bind(...ids).all()).results;
    const id = await logRead(env, a.vault_id, aid, ids, memories.length);
    await db.prepare('UPDATE apps SET last_used = ? WHERE id = ?').bind(Date.now(), aid).run();
    return J({ folders: allowed.map((g) => ({ id: g.folder_id, kind: g.kind, name_ct: g.name_ct, wrapped: g.wrapped })), memories, read_id: id });
  }

  if (path === '/api/app/suggest' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (!isStr(body.blob, 20000)) return E('Bad suggestion.');
    const n = await db.prepare('SELECT COUNT(*) n FROM inbox WHERE vault_id = ?').bind(a.vault_id).first();
    if (n.n >= LIMITS.inbox) return E('The owner inbox is full.');
    await db.prepare('INSERT INTO inbox (id, vault_id, app_id, blob, created) VALUES (?, ?, ?, ?, ?)').bind(rid(), a.vault_id, aid, body.blob, Date.now()).run();
    return J({ ok: true });
  }
  return E('Not found.', 404);
}

// ---------- public + bot ----------
async function pub(req, env, path) {
  const db = env.DB;
  if (path === '/api/seals') {
    const seals = (await db.prepare('SELECT hour, root, reads, tx FROM seals ORDER BY hour DESC LIMIT 24').all()).results;
    return J({ seals, contract: env.SEAL_CONTRACT || '' });
  }
  if (path === '/api/live') {
    const hour = Math.floor(Date.now() / 3600000);
    const [recent, pend, tot, sealed] = await Promise.all([
      db.prepare("SELECT ts, hour, items, CASE WHEN app_id = 'signal' THEN 'signal' ELSE 'app' END AS kind, leaf FROM reads ORDER BY seq DESC LIMIT 30").all(),
      db.prepare('SELECT COUNT(*) n FROM reads WHERE hour = ?').bind(hour).first(),
      db.prepare('SELECT COUNT(*) n FROM reads').first(),
      db.prepare('SELECT COUNT(*) n, COALESCE(SUM(reads), 0) r FROM seals WHERE tx IS NOT NULL').first(),
    ]);
    return J({ now: Date.now(), hour, pending: pend.n, total: tot.n, seals: sealed.n, sealed: sealed.r, recent: recent.results, contract: env.SEAL_CONTRACT || '' });
  }
  const sealM = path.match(/^\/api\/seal\/(\d{1,10})$/);
  if (sealM) {
    const s = await db.prepare('SELECT hour, root, reads, tx FROM seals WHERE hour = ?').bind(Number(sealM[1])).first();
    if (!s) return E('No seal for this hour.', 404);
    const leaves = (await db.prepare('SELECT leaf FROM seal_leaves WHERE hour = ? ORDER BY idx').bind(s.hour).all()).results.map((r) => r.leaf);
    return J({ ...s, leaves, contract: env.SEAL_CONTRACT || '' });
  }
  if (path === '/api/stats') {
    const [v, mm, r, s, sg] = await Promise.all([
      db.prepare('SELECT COUNT(*) n FROM vaults WHERE id NOT IN (SELECT id FROM demo_vaults)').first(),
      db.prepare('SELECT COUNT(*) n FROM memories').first(),
      db.prepare('SELECT COUNT(*) n FROM reads').first(),
      db.prepare('SELECT COUNT(*) n, COALESCE(SUM(reads), 0) sealed FROM seals').first(),
      db.prepare("SELECT COUNT(*) n FROM signals WHERE live = 1 AND vault_id NOT IN ('demo-nora', 'official-axon')").first(),
    ]);
    return J({ vaults: v.n, memories: mm.n, reads: r.n, seals: s.n, sealed: s.sealed, signals: sg.n });
  }
  return null;
}

async function bot(req, env, path) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!env.BOT_TOKEN || tok !== env.BOT_TOKEN) return E('Forbidden.', 403);
  if (path === '/api/bot/seal' && req.method === 'POST') { await sealHours(env); return J({ ok: true }); }
  if (path === '/api/bot/pending' && req.method === 'GET') {
    return J({ seals: (await env.DB.prepare('SELECT hour, root, reads FROM seals WHERE tx IS NULL ORDER BY hour LIMIT 20').all()).results });
  }
  if (path === '/api/bot/confirm' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!Number.isInteger(b.hour) || !/^0x[0-9a-fA-F]{64}$/.test(b.tx || '')) return E('Bad confirm.');
    await env.DB.prepare('UPDATE seals SET tx = ? WHERE hour = ?').bind(b.tx.toLowerCase(), b.hour).run();
    return J({ ok: true });
  }
  return E('Not found.', 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const sm = path.match(/^\/s\/([A-Za-z0-9_]{3,20})$/);
    if (sm) return signalPage(req, env, sm[1].toLowerCase());
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (path.startsWith('/api/bot/')) return await bot(req, env, path);
      if (path.startsWith('/api/app/')) return await app(req, env, path, url);
      if (path.startsWith('/api/s/')) {
        const r = await signalRoutes({ req, env, ctx, path, db: env.DB, J, E, vid: null, isStr, rid, shaText, logRead: (...a) => logRead(env, ...a) });
        return r || E('Not found.', 404);
      }
      const p = await pub(req, env, path);
      if (p) return p;
      return await owner(req, env, ctx, path, url);
    } catch (e) {
      return E('Server error: ' + (e && e.message ? e.message : 'unknown'), 500);
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(sealHours(env));
    ctx.waitUntil(env.DB.prepare('DELETE FROM quotas WHERE exp < ?').bind(Date.now()).run());
    ctx.waitUntil(wipeOldDemos(env));
  },
};
