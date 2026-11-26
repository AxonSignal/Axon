// Reads ChatGPT and Claude exports in the browser. Nothing is uploaded unencrypted.
(() => {
  const td = new TextDecoder();
  const MAX_TEXT = 12000, MAX_MSG = 2000;

  async function readSlice(file, start, end) { return new Uint8Array(await file.slice(start, end).arrayBuffer()); }

  async function listZip(file) {
    const tailLen = Math.min(file.size, 70000);
    const tail = await readSlice(file, file.size - tailLen, file.size);
    const dv = new DataView(tail.buffer);
    let e = tail.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('This file is not a valid .zip export.');
    let count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
    if (cdOff === 0xffffffff || count === 0xffff) { // zip64
      const loc = e - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z64off = Number(dv.getBigUint64(loc + 8, true));
        const z = new DataView((await readSlice(file, z64off, z64off + 56)).buffer);
        count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
      }
    }
    const cd = await readSlice(file, cdOff, cdOff + cdSize);
    const c = new DataView(cd.buffer);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (c.getUint32(p, true) !== 0x02014b50) break;
      const method = c.getUint16(p + 10, true);
      let csize = c.getUint32(p + 20, true), usize = c.getUint32(p + 24, true);
      const nlen = c.getUint16(p + 28, true), xlen = c.getUint16(p + 30, true), clen = c.getUint16(p + 32, true);
      let lho = c.getUint32(p + 42, true);
      const name = td.decode(cd.subarray(p + 46, p + 46 + nlen));
      let x = p + 46 + nlen; const xend = x + xlen;
      while (x + 4 <= xend) { // zip64 extra
        const id = c.getUint16(x, true), sz = c.getUint16(x + 2, true); let q = x + 4;
        if (id === 1) {
          if (usize === 0xffffffff) { usize = Number(c.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(c.getBigUint64(q, true)); q += 8; }
          if (lho === 0xffffffff) { lho = Number(c.getBigUint64(q, true)); }
        }
        x += 4 + sz;
      }
      entries.push({ name, method, csize, usize, lho });
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  async function readEntry(file, en) {
    const h = new DataView((await readSlice(file, en.lho, en.lho + 30)).buffer);
    const start = en.lho + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const data = file.slice(start, start + en.csize);
    if (en.method === 0) return td.decode(await data.arrayBuffer());
    if (en.method !== 8) throw new Error('Unsupported compression in ' + en.name);
    if (!('DecompressionStream' in window)) throw new Error('This browser cannot unpack zip files. Use a recent Chrome, Edge, Safari or Firefox.');
    const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }

  const clip = (s, n) => (s.length > n ? s.slice(0, n) + ' …' : s);

  function fromChatGPT(convs) {
    const out = [];
    for (const cv of convs) {
      const map = cv.mapping || {};
      let chain = [];
      let node = cv.current_node && map[cv.current_node];
      const seen = new Set();
      while (node && !seen.has(node.id)) { seen.add(node.id); chain.push(node); node = node.parent && map[node.parent]; }
      chain = chain.reverse();
      if (!chain.length) chain = Object.values(map).sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
      const lines = [];
      for (const n of chain) {
        const m = n.message; if (!m || !m.content) continue;
        const role = m.author?.role; if (role !== 'user' && role !== 'assistant') continue;
        const parts = (m.content.parts || []).filter((x) => typeof x === 'string' && x.trim());
        const text = parts.join('\n').trim() || (typeof m.content.text === 'string' ? m.content.text.trim() : '');
        if (!text) continue;
        lines.push((role === 'user' ? 'You: ' : 'AI: ') + clip(text, MAX_MSG));
      }
      if (!lines.length) continue;
      out.push({ title: (cv.title || 'Untitled chat').slice(0, 200), text: clip(lines.join('\n\n'), MAX_TEXT), source: 'ChatGPT', date: Math.round((cv.create_time || cv.update_time || Date.now() / 1000) * 1000) });
    }
    return out;
  }

  function fromClaude(convs) {
    const out = [];
    for (const cv of convs) {
      const lines = [];
      for (const m of cv.chat_messages || []) {
        let text = typeof m.text === 'string' ? m.text : '';
        if (!text.trim() && Array.isArray(m.content)) text = m.content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text).join('\n');
        text = (text || '').trim(); if (!text) continue;
        lines.push((m.sender === 'human' ? 'You: ' : 'AI: ') + clip(text, MAX_MSG));
      }
      if (!lines.length) continue;
      out.push({ title: (cv.name || 'Untitled chat').slice(0, 200), text: clip(lines.join('\n\n'), MAX_TEXT), source: 'Claude', date: Date.parse(cv.created_at) || Date.now() });
    }
    return out;
  }

  function fromClaudeProjects(projects) {
    const out = [];
    for (const p of projects || []) {
      const date = Date.parse(p.created_at) || Date.now();
      if (p.description || p.prompt_template) out.push({ title: `${p.name || 'Project'}`, text: clip([p.description, p.prompt_template].filter(Boolean).join('\n\n'), MAX_TEXT), source: 'Claude project', date });
      for (const d of p.docs || []) if (d && d.content) out.push({ title: `${p.name || 'Project'} / ${d.filename || 'document'}`.slice(0, 200), text: clip(String(d.content), MAX_TEXT), source: 'Claude project', date: Date.parse(d.created_at) || date });
    }
    return out;
  }

  function fromClaudeMemories(mem) {
    const out = [];
    const items = Array.isArray(mem) ? mem : [mem];
    for (const m of items) {
      if (!m) continue;
      const text = typeof m === 'string' ? m : (m.conversations_memory || m.memory || m.content || m.text || '');
      if (text && String(text).trim()) out.push({ title: 'Claude memory', text: clip(String(text), MAX_TEXT), source: 'Claude memory', date: Date.now() });
      if (m.project_memories && typeof m.project_memories === 'object') for (const [k, v] of Object.entries(m.project_memories)) if (v) out.push({ title: `Claude memory / ${k}`.slice(0, 200), text: clip(String(v), MAX_TEXT), source: 'Claude memory', date: Date.now() });
    }
    return out;
  }

  function detect(convs) {
    if (!Array.isArray(convs) || !convs.length) return null;
    if (convs[0].mapping) return 'ChatGPT';
    if (convs[0].chat_messages) return 'Claude';
    return null;
  }

  async function parse(file) {
    let items = [], kind = null;
    if (/\.json$/i.test(file.name)) {
      const data = JSON.parse(await file.text());
      kind = detect(data);
      if (!kind) throw new Error('This JSON file is not a ChatGPT or Claude conversations export.');
      items = kind === 'ChatGPT' ? fromChatGPT(data) : fromClaude(data);
      return { kind, items };
    }
    const entries = await listZip(file);
    const find = (n) => entries.find((e) => e.name === n || e.name.endsWith('/' + n));
    const conv = find('conversations.json');
    if (!conv) throw new Error('No conversations.json found. Use the export .zip from ChatGPT or Claude.');
    const data = JSON.parse(await readEntry(file, conv));
    kind = detect(data);
    if (!kind) throw new Error('The export format was not recognised.');
    items = kind === 'ChatGPT' ? fromChatGPT(data) : fromClaude(data);
    if (kind === 'Claude') {
      const pj = find('projects.json'); if (pj) { try { items = items.concat(fromClaudeProjects(JSON.parse(await readEntry(file, pj)))); } catch (_) {} }
      const mj = find('memories.json'); if (mj) { try { items = items.concat(fromClaudeMemories(JSON.parse(await readEntry(file, mj)))); } catch (_) {} }
    }
    items.sort((a, b) => a.date - b.date);
    return { kind, items };
  }

  window.AxonImport = { parse };
})();
