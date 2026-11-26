// AXON vault app. Keys live in memory only; reloading the page locks the vault again.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const { esc, api, cfg } = AX;
  const S = { addr: null, auth: null, master: null, inboxPriv: null, folders: [], memories: [], apps: [], inbox: [], current: null, view: 'memories', log: null };
  const tok = () => S.auth;

  // ---------- ui helpers ----------
  const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2200); };
  const copy = async (t, msg) => { try { await navigator.clipboard.writeText(t); toast(msg); } catch { toast('Copy failed, select the text instead.'); } };
  function ask(title, text, { input, okText = 'OK', danger = false } = {}) {
    return new Promise((res) => {
      const d = $('#dlg'); $('#dlg-title').textContent = title; $('#dlg-text').textContent = text;
      const extra = $('#dlg-extra'); extra.innerHTML = '';
      let inp = null;
      if (input !== undefined) { inp = document.createElement('input'); inp.value = input; inp.maxLength = 60; const l = document.createElement('label'); l.className = 'field'; l.appendChild(inp); extra.appendChild(l); }
      const ok = $('#dlg-ok'); ok.textContent = okText; ok.className = 'btn small' + (danger ? ' danger' : '');
      d.onclose = () => res(d.returnValue === 'ok' ? (inp ? inp.value.trim() : true) : null);
      d.returnValue = ''; d.showModal(); if (inp) { inp.focus(); inp.select(); }
    });
  }
  const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const fmtTime = (ts) => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  // ---------- gate ----------
  const mark = AxonMark($('#gate-mark'), { fill: 0.92, pulses: 6 });
  function gate(step, err = '') {
    const a = $('#gate-actions');
    $('#gate-error').textContent = err;
    if (step === 'connect') {
      $('#gate-title').textContent = 'Open your vault';
      a.innerHTML = '<button class="btn" id="g-connect">Connect wallet</button><p class="gate-demo">Not ready to connect? <button id="g-demo">Try the demo vault</button>, no wallet needed.</p>';
      $('#g-connect').onclick = pickWallet;
      $('#g-demo').onclick = startDemo;
    } else if (step === 'pick') {
      const list = AX.listWallets();
      if (!list.length) { gate('connect', 'No wallet found in this browser. Install MetaMask, Rabby or another EVM wallet, then reload.'); return; }
      a.innerHTML = '<div class="wallets">' + list.map((w, i) => `<button data-i="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}</button>`).join('') + '</div><button class="mini" id="g-back">Back</button>';
      a.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => doConnect(list[+b.dataset.i])));
      $('#g-back').onclick = () => gate('connect');
    } else if (step === 'sign') {
      $('#gate-title').textContent = 'Sign to unlock';
      a.innerHTML = '<button class="btn" id="g-sign">Sign and open</button>';
      $('#g-sign').onclick = unlock;
    } else if (step === 'busy') {
      a.innerHTML = `<button class="btn" disabled>${esc(err || 'Opening your vault')}</button>`;
      $('#gate-error').textContent = '';
    }
    renderWho();
  }
  function pickWallet() {
    const list = AX.listWallets();
    if (list.length === 1) return doConnect(list[0]);
    gate('pick');
  }
  async function doConnect(w) {
    try { S.addr = await AX.connect(w); gate('sign'); }
    catch (e) { gate('connect', e.code === 4001 ? 'Connection was cancelled in your wallet.' : (e.message || 'Could not connect.')); }
  }
  async function disconnect() {
    clearSession();
    await AX.disconnect();
    Object.assign(S, { addr: null, auth: null, master: null, inboxPriv: null, folders: [], memories: [], apps: [], inbox: [], current: null, log: null, signal: null, demo: false });
    $('#shell').hidden = true; $('#views').hidden = true; $('#gate').hidden = false; $('#demo-bar').hidden = true;
    gate('connect');
  }
  window.addEventListener('axon:wallet-changed', () => { if (S.addr) { toast('Wallet changed. The vault was locked.'); disconnect(); } });
  function renderWho() {
    const w = $('#who');
    if (S.demo) { w.innerHTML = '<span class="demo-pill">Demo</span><button class="mini" id="disc">Exit demo</button>'; $('#disc').onclick = disconnect; return; }
    w.innerHTML = S.addr ? `<code>${AX.short(S.addr, 6, 4)}</code><button class="mini" id="disc">Disconnect</button>` : '';
    if (S.addr) $('#disc').onclick = disconnect;
  }

  // ---------- demo vault (no wallet) ----------
  const DEMO = {
    self: "I'm Nora, a product designer. Keep answers short and direct, skip the intros, and always show me the trade-offs.",
    folders: {
      Work: [['Current project', 'Leading the redesign of a payments app. The new checkout ships in December.'], ['Tools', 'Figma for design, Linear for tasks, Notion for specs.'], ['Meetings', 'No calls before 10. Async first, short written updates.']],
      Projects: [['Halo', 'A budgeting app for freelancers. Beta opens in January.'], ['Field notes', 'A small newsletter about interface details, every second Sunday.']],
      Travel: [['Seats', 'Window seat, always. Prefers night trains to short flights.']],
    },
  };
  async function startDemo() {
    gate('busy', 'Preparing the demo vault');
    try {
      S.demo = true;
      const demoSig = '0x' + AX.hex(AX.rand(65));
      const { auth, master } = await AX.vaultKeysFromSig(demoSig);
      S.auth = auth; S.master = master;
      const open = await api('/api/vault/open', { method: 'POST', token: tok(), body: { ...(await AX.newInboxKeys(master)), demo: true } });
      S.inboxPriv = await AX.openJSON(master, open.vault.inbox_priv);
      await firstRun();
      for (const name of Object.keys(DEMO.folders)) await newFolder(name);
      await load();
      const items = [];
      const day = 86400000;
      const push = async (f, h, t, ago) => items.push({ id: AX.rid(), folder_id: f.id, blob: await AX.seal(f.key, { h, t, s: 'You', d: Date.now() - ago }), created: Date.now() - ago });
      const selfF = S.folders.find((f) => f.kind === 'self');
      await push(selfF, '', DEMO.self, 6 * day);
      let k = 0;
      for (const [name, list] of Object.entries(DEMO.folders)) { const f = S.folders.find((x) => x.name === name); for (const [h, t] of list) await push(f, h, t, (++k) * day); }
      await api('/api/memories', { method: 'POST', token: tok(), body: { items } });
      // a connected app that already read the vault once, so the log is not empty
      const secret = AX.newAppSecret(), ak = await AX.appKeysFromSecret(secret);
      const work = S.folders.find((f) => f.name === 'Work');
      await api('/api/apps', { method: 'POST', token: tok(), body: { id: ak.id, name_ct: await AX.seal(master, 'Claude Desktop'), grants: await grantsFor(ak.wrap, [selfF.id, work.id]) } });
      await fetch('/api/app/read?folders=all', { headers: { authorization: 'Bearer ' + ak.auth } });
      await load();
      saveSession(demoSig, true);
      $('#gate').hidden = true; $('#shell').hidden = false; $('#views').hidden = false; $('#demo-bar').hidden = false;
      renderWho(); show('memories');
    } catch (e) { S.demo = false; S.auth = null; S.master = null; gate('connect', e.message || 'Could not open the demo.'); }
  }
  $('#demo-real').addEventListener('click', disconnect);

  const SESSION = 'axon.session';
  const saveSession = (sig, demo = false) => { try { sessionStorage.setItem(SESSION, JSON.stringify({ addr: S.addr, sig, demo })); } catch (_) {} };
  const clearSession = () => { try { sessionStorage.removeItem(SESSION); } catch (_) {} };
  async function unlock(given) {
    let sig = typeof given === 'string' ? given : null;
    if (!sig) {
      gate('busy', 'Waiting for your signature');
      try { sig = await AX.signVault(); }
      catch (e) { gate('sign', e.code === 4001 ? 'Signature was cancelled. Sign to open your vault.' : (e.message || 'Signing failed.')); return; }
    }
    gate('busy', 'Opening your vault');
    try {
      const { auth, master } = await AX.vaultKeysFromSig(sig);
      S.auth = auth; S.master = master;
      // try open; create on first visit
      let open;
      try { open = await api('/api/vault/open', { method: 'POST', token: tok(), body: {} }); }
      catch (e) {
        if (e.message !== 'Missing inbox keys.') throw e;
        if (typeof given === 'string') throw new Error('Your session ended. Open your vault again.');
        const keys = await AX.newInboxKeys(master);
        open = await api('/api/vault/open', { method: 'POST', token: tok(), body: keys });
      }
      S.inboxPriv = await AX.openJSON(master, open.vault.inbox_priv);
      if (open.created) await firstRun();
      await load();
      saveSession(sig);
      $('#gate').hidden = true; $('#shell').hidden = false; $('#views').hidden = false;
      renderWho(); show('memories');
    } catch (e) {
      S.auth = null; S.master = null;
      gate('sign', e.name === 'OperationError' ? 'This signature does not open this vault.' : (e.message || 'Could not open the vault.'));
    }
  }

  // ---------- data ----------
  async function newFolder(name, kind = 'folder') {
    const raw = AX.rand(32), key = await AX.aes(raw), id = AX.rid();
    await api('/api/folders', { method: 'POST', token: tok(), body: { id, kind, name_ct: await AX.seal(key, name), wrapped: await AX.seal(S.master, raw) } });
    return id;
  }
  async function firstRun() {
    await newFolder('Self card', 'self');
    await newFolder('Notes');
  }
  async function load() {
    const d = await api('/api/vault', { token: tok() });
    const folders = [];
    for (const f of d.folders) {
      try {
        const raw = await AX.openBytes(S.master, f.wrapped);
        const key = await AX.aes(raw);
        folders.push({ id: f.id, kind: f.kind, raw, key, name: await AX.openText(key, f.name_ct), created: f.created });
      } catch (_) { /* unreadable folder */ }
    }
    folders.sort((a, b) => (a.kind === 'self' ? -1 : b.kind === 'self' ? 1 : a.created - b.created));
    S.folders = folders;
    const fk = Object.fromEntries(folders.map((f) => [f.id, f.key]));
    const mem = [];
    for (const m of d.memories) {
      if (!fk[m.folder_id]) continue;
      try { const x = await AX.openJSON(fk[m.folder_id], m.blob); mem.push({ id: m.id, folder_id: m.folder_id, title: x.h || '', text: x.t || '', source: x.s || '', date: x.d || m.created, created: m.created }); } catch (_) {}
    }
    S.memories = mem;
    const apps = [];
    for (const a of d.apps) {
      let name = 'App'; try { name = await AX.openText(S.master, a.name_ct); } catch (_) {}
      apps.push({ id: a.id, name, created: a.created, last_used: a.last_used, folders: new Set(d.grants.filter((g) => g.app_id === a.id).map((g) => g.folder_id)) });
    }
    S.apps = apps;
    const inbox = [];
    for (const i of d.inbox) {
      try { const x = await AX.openInbox(S.inboxPriv, i.blob); inbox.push({ id: i.id, app_id: i.app_id, title: x.h || '', text: x.t || '', date: x.d || i.created }); } catch (_) {}
    }
    S.inbox = inbox;
    try { const sg = await api('/api/signal', { token: tok() }); S.signal = sg.signal; S.tokenLive = !!sg.token; } catch (_) { S.signal = null; }
    if (!S.current || !S.folders.find((f) => f.id === S.current)) S.current = S.folders[0]?.id;
    $('#vault-id').textContent = S.demo ? 'Demo vault, not tied to any wallet.' : 'Wallet ' + S.addr;
    renderAll();
  }
  const folder = (id) => S.folders.find((f) => f.id === id);
  const appName = (id) => (id === 'signal' ? 'Your Signal' : S.apps.find((a) => a.id === id)?.name || 'Revoked app');

  async function saveMemory({ folder_id, title, text, source = 'You', date = Date.now(), id = AX.rid() }) {
    const f = folder(folder_id);
    const blob = await AX.seal(f.key, { h: title, t: text, s: source, d: date });
    await api('/api/memories', { method: 'POST', token: tok(), body: { items: [{ id, folder_id, blob, created: date }] } });
    const existing = S.memories.find((m) => m.id === id);
    if (existing) Object.assign(existing, { title, text, source, date });
    else S.memories.unshift({ id, folder_id, title, text, source, date, created: date });
    syncSignal(folder_id);
  }

  // ---------- views ----------
  function show(v) {
    S.view = v;
    $$('.views button').forEach((b) => (b.dataset.v === v ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
    $$('[data-view]').forEach((s) => (s.hidden = s.dataset.view !== v));
    if (v === 'log') loadLog();
    if (v === 'import') renderImportFolders();
    if (v === 'signal') renderSignal();
    if (v === 'inbox' || v === 'apps') load().catch(() => {});
    window.scrollTo(0, 0);
  }
  $('#views').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) show(b.dataset.v); });

  function renderAll() { renderFolders(); renderMemories(); renderInbox(); renderApps(); renderSignal(); }

  function renderFolders() {
    const counts = {}; S.memories.forEach((m) => (counts[m.folder_id] = (counts[m.folder_id] || 0) + 1));
    $('#folder-list').innerHTML = S.folders.map((f) => `<li><button data-f="${f.id}" aria-current="${f.id === S.current}"><span>${esc(f.name)}</span><small>${counts[f.id] || 0}</small></button></li>`).join('');
    const bytes = S.memories.reduce((a, m) => a + m.text.length + m.title.length, 0);
    $('#vault-size').textContent = `${S.memories.length} ${S.memories.length === 1 ? 'memory' : 'memories'}, ${(bytes / 1024).toFixed(bytes > 10240 ? 0 : 1)} KB`;
  }
  $('#folder-list').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { S.current = b.dataset.f; $('#search').value = ''; renderFolders(); renderMemories(); } });

  function renderMemories() {
    const f = folder(S.current); if (!f) return;
    $('#folder-title').textContent = f.name;
    const self = f.kind === 'self';
    $('#delete-folder').hidden = self;
    $('#folder-hint').textContent = self
      ? 'Your self card is read first by connected apps and gives your Signal its voice. Write who you are, what you do and how you like answers.'
      : 'Only apps you give this folder to can read it.';
    $('#m-text').placeholder = self ? 'I design products and ship fast. Keep answers short and skip the intros.' : 'Something your AIs should know about you';
    const q = $('#search').value.trim().toLowerCase();
    const all = $('#search-all').checked;
    let list = S.memories.filter((m) => (all && q ? true : m.folder_id === f.id));
    if (q) list = list.filter((m) => (m.title + ' ' + m.text).toLowerCase().includes(q));
    list.sort((a, b) => b.date - a.date);
    const el = $('#memory-list');
    if (!list.length) {
      el.innerHTML = q ? '<li class="empty">Nothing matches that search.</li>' : `<li class="empty">${self ? '<b>Your self card is empty.</b> Write a few lines above, apps will read it first.' : '<b>This folder is empty.</b> Write a memory above or import your chat history.'}</li>`;
      return;
    }
    el.innerHTML = list.slice(0, 400).map((m) => `<li data-m="${m.id}">
      <span class="meta">${fmtDate(m.date)} · ${esc(m.source)}${all && q ? ' · ' + esc(folder(m.folder_id)?.name || '') : ''}</span>
      ${m.title ? `<h4>${esc(m.title)}</h4>` : ''}
      <p class="text">${esc(m.text)}</p>
      ${m.text.length > 420 ? '<button class="more">Show all</button>' : ''}
      <div class="acts"><button class="mini" data-act="edit">Edit</button><button class="mini danger" data-act="del">Delete</button></div>
    </li>`).join('') + (list.length > 400 ? `<li class="empty">Showing 400 of ${list.length}. Search to narrow down.</li>` : '');
  }
  $('#search').addEventListener('input', renderMemories);
  $('#search-all').addEventListener('change', renderMemories);
  $('#memory-list').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-m]'); if (!li) return;
    const m = S.memories.find((x) => x.id === li.dataset.m);
    if (e.target.classList.contains('more')) { const t = li.querySelector('.text'); t.classList.toggle('open'); e.target.textContent = t.classList.contains('open') ? 'Show less' : 'Show all'; return; }
    const act = e.target.dataset.act;
    if (act === 'del') {
      if (!(await ask('Delete this memory?', 'It is removed from your vault for good.', { okText: 'Delete', danger: true }))) return;
      await api('/api/memories/' + m.id, { method: 'DELETE', token: tok() });
      S.memories = S.memories.filter((x) => x.id !== m.id); renderFolders(); renderMemories(); toast('Memory deleted'); syncSignal(m.folder_id);
    }
    if (act === 'edit') {
      $('#m-title').value = m.title; $('#m-text').value = m.text; $('#composer').dataset.edit = m.id;
      $('#composer button[type=submit]').textContent = 'Save changes'; $('#m-text').focus(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });
  $('#m-text').addEventListener('input', () => { const n = $('#m-text').value.length; $('#m-count').textContent = n ? `${n.toLocaleString('en-US')} / 12,000` : ''; });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#m-text').value.trim(), title = $('#m-title').value.trim();
    if (!text) { $('#m-text').focus(); return; }
    const editId = $('#composer').dataset.edit;
    const btn = $('#composer button[type=submit]'); btn.disabled = true;
    try {
      if (editId) { const m = S.memories.find((x) => x.id === editId); await saveMemory({ id: editId, folder_id: m.folder_id, title, text, source: m.source, date: m.date }); toast('Changes saved'); }
      else { await saveMemory({ folder_id: S.current, title, text }); toast('Memory saved'); mark.pulse(); }
      $('#m-text').value = ''; $('#m-title').value = ''; $('#m-count').textContent = ''; delete $('#composer').dataset.edit; btn.textContent = 'Save memory';
      renderFolders(); renderMemories();
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });

  $('#new-folder').addEventListener('click', async () => {
    const name = await ask('New folder', 'Give it a name you will recognise, like Work or Travel.', { input: '', okText: 'Create folder' });
    if (!name) return;
    try { const id = await newFolder(name); await load(); S.current = id; renderFolders(); renderMemories(); toast('Folder created'); } catch (e) { toast(e.message); }
  });
  $('#rename-folder').addEventListener('click', async () => {
    const f = folder(S.current);
    const name = await ask('Rename folder', '', { input: f.name, okText: 'Rename' });
    if (!name || name === f.name) return;
    await api('/api/folders/' + f.id, { method: 'PUT', token: tok(), body: { name_ct: await AX.seal(f.key, name) } });
    f.name = name; renderFolders(); renderMemories(); toast('Folder renamed'); syncSignal(f.id);
  });
  $('#delete-folder').addEventListener('click', async () => {
    const f = folder(S.current);
    const n = S.memories.filter((m) => m.folder_id === f.id).length;
    if (!(await ask(`Delete ${f.name}?`, `This deletes the folder and its ${n} ${n === 1 ? 'memory' : 'memories'}. Apps lose access to it.`, { okText: 'Delete folder', danger: true }))) return;
    await api('/api/folders/' + f.id, { method: 'DELETE', token: tok() });
    const wasInSignal = S.signal && S.signal.folders.includes(f.id);
    S.current = null; await load(); toast('Folder deleted');
    if (wasInSignal) { S.signal.folders = S.signal.folders.filter((x) => x !== f.id); if (S.signal.folders.length) syncSignal(null, true); else { await api('/api/signal', { method: 'DELETE', token: tok() }); S.signal = null; renderSignal(); } }
  });


  // ---------- signal ----------
  const sigBase = () => location.origin + '/s/';
  function bundleFor(ids) {
    const set = new Set(ids);
    return S.memories.filter((m) => set.has(m.folder_id)).sort((a, b) => b.date - a.date).slice(0, 800).map((m) => {
      const f = folder(m.folder_id);
      return { f: f.name, k: f.kind, h: m.title, t: m.text.slice(0, 4000), d: m.date };
    });
  }
  async function publishSignal({ handle, name, bio, folders }) {
    const r = await api('/api/signal', { method: 'PUT', token: tok(), body: { handle, name, bio, folders, bundle: bundleFor(folders), live: true } });
    const sg = await api('/api/signal', { token: tok() });
    S.signal = sg.signal; S.tokenLive = !!sg.token;
    return r;
  }
  let syncT = 0;
  function syncSignal(folderId, force = false) {
    if (!S.signal || !S.signal.live) return;
    if (!force && folderId && !S.signal.folders.includes(folderId)) return;
    clearTimeout(syncT);
    syncT = setTimeout(() => publishSignal(S.signal).then(renderSignal).catch(() => {}), 1200);
  }
  function renderSignal() {
    const s = S.signal;
    $('#sig-demo').hidden = !S.demo; $('#sig-form').hidden = !!S.demo;
    $('#sig-prefix').textContent = sigBase().replace(/^https?:\/\//, '');
    const self = S.folders.find((f) => f.kind === 'self');
    const sel = new Set(s ? s.folders : self ? [self.id] : []);
    $('#sig-folders').innerHTML = S.folders.map((f) => `<label><input type="checkbox" value="${f.id}" ${sel.has(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('');
    if (document.activeElement?.closest?.('#sig-form') == null) {
      $('#sig-handle').value = s ? s.handle : ''; $('#sig-name').value = s ? s.name : ''; $('#sig-bio').value = s ? s.bio : '';
    }
    $('#sig-live').hidden = !s; $('#sig-off').hidden = !s; $('#sig-open').hidden = !s;
    $('#sig-save').textContent = s ? 'Save changes' : 'Publish my Signal';
    if (s) {
      const url = sigBase() + s.handle;
      $('#sig-url').textContent = url; $('#sig-open').href = url;
      $('#sig-stats').textContent = `${s.items} ${s.items === 1 ? 'memory' : 'memories'} published. ${s.asks} ${s.asks === 1 ? 'question' : 'questions'} answered. It updates by itself when you edit these folders.`;
      $('#sig-holder').hidden = !!s.holder;
      $('#sig-holder-out').textContent = s.holder ? '$AXON holder badge active' : (S.tokenLive ? '' : 'Holder badges open at launch.');
      $('#sig-holder').disabled = !S.tokenLive;
    }
  }
  $('#sig-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const folders = [...$('#sig-folders').querySelectorAll('input:checked')].map((i) => i.value);
    if (!folders.length) { toast('Pick at least one folder.'); return; }
    const btn = $('#sig-save'); btn.disabled = true;
    try {
      const first = !S.signal;
      await publishSignal({ handle: $('#sig-handle').value.trim().toLowerCase(), name: $('#sig-name').value.trim(), bio: $('#sig-bio').value.trim(), folders });
      document.activeElement?.blur?.();
      renderSignal(); toast(first ? 'Your Signal is live' : 'Signal updated');
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
  $('#sig-copy').addEventListener('click', () => copy(sigBase() + S.signal.handle, 'Link copied'));
  $('#sig-off').addEventListener('click', async () => {
    if (!(await ask('Take your Signal down?', 'The page goes offline and its published copy is deleted. Your vault stays as it is.', { okText: 'Take it down', danger: true }))) return;
    await api('/api/signal', { method: 'DELETE', token: tok() });
    S.signal = null; renderSignal(); toast('Signal taken down');
  });
  $('#sig-holder').addEventListener('click', async () => {
    const out = $('#sig-holder-out');
    try {
      const msg = `AXON Signal holder\n\nSignal: @${S.signal.handle}\nWallet: ${S.addr.toLowerCase()}`;
      if (!AX.wallet.provider) { const w = AX.listWallets()[0]; if (!w) throw new Error('No wallet found in this browser.'); await AX.connect(w); if (AX.wallet.address.toLowerCase() !== S.addr.toLowerCase()) throw new Error('Switch your wallet to ' + AX.short(S.addr, 6, 4) + ' first.'); }
      out.textContent = 'Sign in your wallet.';
      const signature = await AX.wallet.provider.request({ method: 'personal_sign', params: ['0x' + AX.hex(AX.te.encode(msg)), S.addr] });
      const r = await api('/api/signal/holder', { method: 'POST', token: tok(), body: { address: S.addr, signature } });
      S.signal.holder = r.holder ? 1 : 0; renderSignal();
      out.textContent = r.holder ? '$AXON holder badge active' : 'No $AXON found in this wallet.';
    } catch (err) { out.textContent = err.code === 4001 ? 'Signature cancelled.' : err.message; }
  });

  // ---------- inbox ----------
  function renderInbox() {
    const n = S.inbox.length, badge = $('#inbox-n');
    badge.hidden = !n; badge.textContent = n;
    const el = $('#inbox-list');
    if (!n) { el.innerHTML = '<li class="empty"><b>No suggestions.</b> When a connected app suggests a memory, it waits here.</li>'; return; }
    const def = (S.folders.find((f) => f.kind !== 'self') || S.folders[0])?.id;
    const opts = S.folders.map((f) => `<option value="${f.id}" ${f.id === def ? 'selected' : ''}>${esc(f.name)}</option>`).join('');
    el.innerHTML = S.inbox.map((i) => `<li data-i="${i.id}">
      <span class="meta">${fmtDate(i.date)} · from ${esc(appName(i.app_id))}</span>
      ${i.title ? `<h4>${esc(i.title)}</h4>` : ''}<p class="text open">${esc(i.text)}</p>
      <div class="row"><select class="mini sel">${opts}</select><button class="btn small" data-act="keep">Keep</button><button class="mini danger" data-act="reject">Reject</button></div>
    </li>`).join('');
  }
  $('#inbox-list').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-i]'); if (!li) return;
    const it = S.inbox.find((x) => x.id === li.dataset.i), act = e.target.dataset.act;
    if (!act) return;
    try {
      if (act === 'keep') await saveMemory({ folder_id: li.querySelector('select').value, title: it.title, text: it.text, source: appName(it.app_id) });
      await api('/api/inbox/' + it.id, { method: 'DELETE', token: tok() });
      S.inbox = S.inbox.filter((x) => x.id !== it.id); renderAll(); toast(act === 'keep' ? 'Kept in your vault' : 'Suggestion rejected');
    } catch (err) { toast(err.message); }
  });

  // ---------- apps ----------
  let snippetTab = 'desktop', lastKey = '';
  const snippet = (key) => {
    const o = location.origin;
    if (snippetTab === 'code') return `claude mcp add axon -e AXON_KEY=${key} -e AXON_URL=${o} -- node /path/to/axon-connector.mjs`;
    const inner = `"axon": {\n      "command": "node",\n      "args": ["${snippetTab === 'desktop' ? 'C:\\\\path\\\\to\\\\axon-connector.mjs' : '/path/to/axon-connector.mjs'}"],\n      "env": {\n        "AXON_KEY": "${key}",\n        "AXON_URL": "${o}"\n      }\n    }`;
    return (snippetTab === 'cursor' ? '// ~/.cursor/mcp.json\n' : '') + `{\n  "mcpServers": {\n    ${inner}\n  }\n}`;
  };
  const checks = (sel = new Set()) => S.folders.map((f) => `<label><input type="checkbox" value="${f.id}" ${sel.has(f.id) ? 'checked' : ''}>${esc(f.name)}</label>`).join('');
  $('#new-app').addEventListener('click', () => {
    $('#app-form').hidden = false; $('#keybox').hidden = true;
    const self = S.folders.find((f) => f.kind === 'self');
    $('#app-folders').innerHTML = checks(new Set(self ? [self.id] : []));
    $('#app-name').value = ''; $('#app-name').focus();
  });
  $('#app-cancel').addEventListener('click', () => ($('#app-form').hidden = true));
  async function grantsFor(wrap, ids) {
    const out = [];
    for (const id of ids) out.push({ folder_id: id, wrapped: await AX.seal(wrap, folder(id).raw) });
    return out;
  }
  $('#app-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#app-name').value.trim();
    const ids = [...$('#app-folders').querySelectorAll('input:checked')].map((i) => i.value);
    if (!name) return;
    if (!ids.length) { toast('Tick at least one folder.'); return; }
    const secret = AX.newAppSecret();
    const k = await AX.appKeysFromSecret(secret);
    try {
      await api('/api/apps', { method: 'POST', token: tok(), body: { id: k.id, name_ct: await AX.seal(S.master, name), grants: await grantsFor(k.wrap, ids) } });
    } catch (err) { toast(err.message); return; }
    lastKey = secret;
    S.apps.push({ id: k.id, name, created: Date.now(), last_used: null, folders: new Set(ids) });
    $('#app-form').hidden = true; $('#keybox').hidden = false;
    $('#new-key').textContent = secret; $('#key-snippet').textContent = snippet(secret);
    renderApps();
  });
  $('#key-tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-t]'); if (!t) return; snippetTab = t.dataset.t; $$('#key-tabs .tab').forEach((b) => b.setAttribute('aria-selected', b === t)); $('#key-snippet').textContent = snippet(lastKey); });
  $('#copy-key').addEventListener('click', () => copy(lastKey, 'App key copied'));
  $('#copy-config').addEventListener('click', () => copy(snippet(lastKey), 'Config copied'));
  $('#key-done').addEventListener('click', () => { $('#keybox').hidden = true; lastKey = ''; $('#new-key').textContent = ''; $('#key-snippet').textContent = ''; });

  function renderApps() {
    const el = $('#app-list');
    if (!S.apps.length) { el.innerHTML = '<li class="empty"><b>No app connected yet.</b> Connect Claude, Cursor or any MCP app to let it read the folders you choose.</li>'; return; }
    el.innerHTML = S.apps.map((a) => {
      const names = S.folders.filter((f) => a.folders.has(f.id)).map((f) => esc(f.name));
      return `<li data-a="${a.id}"><h4>${esc(a.name)}</h4>
        <span class="meta">Reads ${names.length ? names.join(', ') : 'nothing'}. ${a.last_used ? 'Last read ' + AX.ago(a.last_used) + '.' : 'Never used yet.'}</span>
        <div class="acts"><button class="mini" data-act="edit">Edit folders</button><button class="mini danger" data-act="revoke">Revoke</button></div>
        <div class="edit" hidden></div></li>`;
    }).join('');
  }
  $('#app-list').addEventListener('click', async (e) => {
    const li = e.target.closest('[data-a]'); if (!li) return;
    const a = S.apps.find((x) => x.id === li.dataset.a), act = e.target.dataset.act;
    if (act === 'revoke') {
      if (!(await ask(`Revoke ${a.name}?`, 'Its key stops working on the next request and the folder keys it held are deleted from the server.', { okText: 'Revoke', danger: true }))) return;
      await api('/api/apps/' + a.id, { method: 'DELETE', token: tok() });
      S.apps = S.apps.filter((x) => x.id !== a.id); renderApps(); toast(`${a.name} revoked`);
    }
    if (act === 'edit') {
      const box = li.querySelector('.edit'); box.hidden = !box.hidden;
      box.innerHTML = `<div class="checks">${checks(a.folders)}</div><p class="pane-hint edit-hint">Adding a folder asks for the app key once, because only that key can lock a folder for this app.</p><div class="row"><button class="btn small" data-act="save">Save folders</button></div>`;
    }
    if (act === 'save') {
      const ids = [...li.querySelectorAll('.edit input:checked')].map((i) => i.value);
      const added = ids.filter((id) => !a.folders.has(id));
      try {
        if (added.length) {
          const secret = await ask('Paste the app key', `To give ${a.name} new folders, paste its app key. It never leaves this browser.`, { input: '', okText: 'Save folders' });
          if (!secret) return;
          const k = await AX.appKeysFromSecret(secret).catch(() => null);
          if (!k || k.id !== a.id) { toast('That key does not belong to this app.'); return; }
          await api(`/api/apps/${a.id}/grants`, { method: 'PUT', token: tok(), body: { grants: await grantsFor(k.wrap, ids) } });
        } else {
          await api(`/api/apps/${a.id}/grants`, { method: 'PUT', token: tok(), body: { keep: ids } });
        }
      } catch (err) { toast(err.message); return; }
      a.folders = new Set(ids); renderApps(); toast('Folders saved');
    }
  });

  // ---------- log ----------
  async function loadLog() {
    const el = $('#log-list');
    el.innerHTML = '<li class="empty">Loading reads.</li>';
    try { S.log = await api('/api/log', { token: tok() }); } catch (e) { el.innerHTML = `<li class="empty">${esc(e.message)}</li>`; return; }
    const seals = Object.fromEntries(S.log.seals.map((s) => [s.hour, s]));
    if (!S.log.reads.length) { el.innerHTML = '<li class="empty"><b>No reads yet.</b> Connect an app and ask it something about you.</li>'; return; }
    el.innerHTML = S.log.reads.map((r) => {
      const s = seals[r.hour];
      const fl = r.folders.split(',').map((id) => esc(folder(id)?.name || 'deleted folder')).join(', ');
      const seal = !s ? 'Sealing after this hour' : s.tx ? `<a href="${cfg.EXPLORER}/tx/${s.tx}" target="_blank" rel="noopener">Sealed on-chain</a>` : 'Sealed, writing on-chain';
      return `<li data-r="${r.id}"><span class="when">${fmtTime(r.ts)}</span><span class="what"><b>${esc(appName(r.app_id))}</b> <span>read ${r.items} ${r.items === 1 ? 'memory' : 'memories'} from ${fl}</span></span>
        <span class="seal">${seal}${s ? ' · <button class="mini" data-act="verify">Verify</button>' : ''}</span><span class="verify-out"></span></li>`;
    }).join('');
  }
  $('#log-refresh').addEventListener('click', loadLog);
  $('#log-list').addEventListener('click', async (e) => {
    if (e.target.dataset.act !== 'verify') return;
    const li = e.target.closest('[data-r]'), out = li.querySelector('.verify-out');
    out.className = 'verify-out'; out.textContent = 'Checking the proof.';
    try {
      const p = await api('/api/proof/' + li.dataset.r, { token: tok() });
      const leaf = await AX.leafOf(p.read);
      if (leaf !== p.leaf) throw new Error('The read does not match its fingerprint.');
      const root = await AX.rootFromProof(leaf, p.index, p.proof);
      if (root !== p.root) throw new Error('The proof does not lead to the hourly seal.');
      const contract = p.contract || cfg.SEAL_CONTRACT;
      if (!p.tx || !contract) { out.className = 'verify-out ok'; out.textContent = `Proof valid: this read is one of ${p.reads} in the seal ${AX.short('0x' + root, 8, 6)}. It is being written on-chain.`; return; }
      const chain = await AX.onchainRoot(contract, p.hour);
      if (chain !== root) throw new Error('The root on Robinhood Chain does not match.');
      out.className = 'verify-out ok'; out.textContent = `Verified on ${cfg.CHAIN_NAME}: this read is one of ${p.reads} sealed in ${AX.short('0x' + root, 8, 6)}.`;
    } catch (err) { out.className = 'verify-out bad'; out.textContent = err.message; }
  });

  // ---------- import ----------
  let parsed = null;
  function renderImportFolders() {
    $('#import-folder').innerHTML = '<option value="__new">New folder</option>' + S.folders.filter((f) => f.kind !== 'self').map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  }
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) readImport(f); });
  $('#import-file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readImport(f); e.target.value = ''; });
  async function readImport(file) {
    $('#drop-text').textContent = `Reading ${file.name}`;
    $('#import-preview').hidden = true;
    try {
      parsed = await AxonImport.parse(file);
      if (!parsed.items.length) throw new Error('No conversations with text were found in this export.');
      const room = 5000 - S.memories.length;
      $('#import-summary').textContent = `Found ${parsed.items.length.toLocaleString('en-US')} ${parsed.kind} items.` + (parsed.items.length > room ? ` Your vault has room for ${Math.max(0, room).toLocaleString('en-US')} more, the newest are kept.` : '');
      renderImportFolders();
      const opt = $('#import-folder').querySelector('option[value="__new"]'); opt.textContent = `New folder: ${parsed.kind} history`;
      $('#import-preview').hidden = false; $('#import-progress').hidden = true;
      $('#drop-text').textContent = file.name;
    } catch (e) { $('#drop-text').textContent = 'Drop the .zip here or click to choose it'; toast(e.message); }
  }
  $('#import-cancel').addEventListener('click', () => { parsed = null; $('#import-preview').hidden = true; $('#drop-text').textContent = 'Drop the .zip here or click to choose it'; });
  $('#import-go').addEventListener('click', async () => {
    if (!parsed) return;
    const go = $('#import-go'); go.disabled = true;
    try {
      let fid = $('#import-folder').value;
      if (fid === '__new') { fid = await newFolder(`${parsed.kind} history`); await load(); }
      const f = folder(fid);
      const room = Math.max(0, 5000 - S.memories.length);
      const items = parsed.items.slice(-room);
      const bar = $('#import-progress'); bar.hidden = false;
      for (let i = 0; i < items.length; i += 50) {
        const chunk = items.slice(i, i + 50);
        const body = [];
        for (const it of chunk) body.push({ id: AX.rid(), folder_id: fid, blob: await AX.seal(f.key, { h: it.title, t: it.text, s: it.source, d: it.date }), created: it.date });
        await api('/api/memories', { method: 'POST', token: tok(), body: { items: body } });
        bar.firstElementChild.style.width = Math.round(((i + chunk.length) / items.length) * 100) + '%';
      }
      await load(); S.current = fid; renderAll(); syncSignal(fid);
      toast(`${items.length.toLocaleString('en-US')} memories imported`);
      parsed = null; $('#import-preview').hidden = true; $('#drop-text').textContent = 'Drop the .zip here or click to choose it';
      show('memories');
    } catch (e) { toast(e.message); }
    go.disabled = false;
  });

  // ---------- settings ----------
  $('#export').addEventListener('click', () => {
    const data = { exported: new Date().toISOString(), wallet: S.addr, folders: S.folders.map((f) => ({ name: f.name, kind: f.kind, memories: S.memories.filter((m) => m.folder_id === f.id).map((m) => ({ title: m.title, text: m.text, source: m.source, date: new Date(m.date).toISOString() })) })) };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    a.download = `axon-export-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $('#delete-vault').addEventListener('click', async () => {
    const typed = await ask('Delete the vault?', 'Type DELETE to remove everything from the server. This cannot be undone.', { input: '', okText: 'Delete the vault', danger: true });
    if (typed !== 'DELETE') { if (typed !== null) toast('Type DELETE to confirm.'); return; }
    await api('/api/vault', { method: 'DELETE', token: tok() });
    toast('Vault deleted'); disconnect();
  });

  setInterval(() => { if (S.auth && !document.hidden) api('/api/vault', { token: tok() }).then((d) => { if (d.inbox.length !== S.inbox.length) load(); }).catch(() => {}); }, 30000);
  async function restore() {
    let s = null; try { s = JSON.parse(sessionStorage.getItem(SESSION) || 'null'); } catch (_) {}
    if (!s || !s.sig) return false;
    S.addr = s.addr; S.demo = !!s.demo;
    if (S.demo) $('#demo-bar').hidden = false;
    await unlock(s.sig);
    if ($('#shell').hidden) { clearSession(); S.demo = false; $('#demo-bar').hidden = true; gate('connect'); }
    return true;
  }
  gate('connect');
  restore().then((ok) => { if (!ok && new URLSearchParams(location.search).get('demo') === '1') startDemo(); });
})();
