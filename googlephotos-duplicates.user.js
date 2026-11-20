// ==UserScript==
// @name         GP Duplicate Finder (for GPTK)
// @namespace    gp-duplicate-finder
// @version      1.0.0
// @description  Find duplicate photos and videos in Google Photos, compare them side by side and keep one. Needs Google Photos Toolkit (GPTK).
// @match        https://photos.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const STORE = 'gpdf:v1';
  const PAGE = 20;

  /* ------------------------------------------------------------------ helpers */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  };
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (ms, offMs) => { if (!ms) return '—'; const d = new Date(ms + (offMs || 0)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtBytes = (b) => b == null ? '—' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const pool = async (list, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } })); };
  const thumb = (u, s) => u ? u.replace(/=[^/]*$/, '') + `=w${s}-h${s}` : '';
  const lower = (s) => (s || '').toLowerCase();
  const stemOf = (n) => lower(n).replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').replace(/[_ -](copy|edited)$/, '');
  const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; } };
  const save = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) { /* storage full or blocked */ } };

  /* fingerprint cache in IndexedDB: dedupKey -> [hi, lo] */
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise(res => { try { const r = indexedDB.open('gpdf', 1); r.onupgradeneeded = () => r.result.createObjectStore('fp'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } }));
    return {
      async getAll() { const db = await open(); const out = new Map(); if (!db) return out; return new Promise(res => { try { const rq = db.transaction('fp').objectStore('fp').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); }; rq.onerror = () => res(out); } catch (e) { res(out); } }); },
      async put(entries) { const db = await open(); if (!db || !entries.length) return; return new Promise(res => { try { const t = db.transaction('fp', 'readwrite'); const st = t.objectStore('fp'); for (const [k, v] of entries) st.put(v, k); t.oncomplete = t.onerror = () => res(); } catch (e) { res(); } }); },
    };
  })();

  function gmBlob(url) {
    return new Promise((res, rej) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout: 20000,
          onload: r => (r.status >= 200 && r.status < 300 && r.response ? res(r.response) : rej(new Error('HTTP ' + r.status))),
          onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')) });
      } else fetch(url, { credentials: 'include' }).then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))).then(res, rej);
    });
  }
  const cvA = document.createElement('canvas'); cvA.width = 9; cvA.height = 8;
  const ctxA = cvA.getContext('2d', { willReadFrequently: true });
  async function fingerprint(url) {
    const bmp = await createImageBitmap(await gmBlob(thumb(url, 64)));
    ctxA.clearRect(0, 0, 9, 8); ctxA.imageSmoothingQuality = 'high'; ctxA.drawImage(bmp, 0, 0, 9, 8); bmp.close && bmp.close();
    const d = ctxA.getImageData(0, 0, 9, 8).data; const g = new Float32Array(72);
    for (let i = 0; i < 72; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    let hi = 0, lo = 0, bit = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++, bit++) { const b = g[y * 9 + x] < g[y * 9 + x + 1] ? 1 : 0; if (bit < 32) hi = (hi | (b << bit)) >>> 0; else lo = (lo | (b << (bit - 32))) >>> 0; }
    return [hi, lo];
  }

  /* ------------------------------------------------------------------ styles */
  const css = `
  #gpdf-btn{position:fixed;right:20px;bottom:20px;z-index:2147482000;background:#1a73e8;color:#fff;border:0;border-radius:24px;padding:10px 16px;font:600 14px/1 system-ui,sans-serif;box-shadow:0 2px 8px #0004;cursor:pointer}
  #gpdf{position:fixed;inset:0;z-index:2147483000;background:#f4f5f7;color:#1c2128;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
  #gpdf *{box-sizing:border-box}
  #gpdf .top,#gpdf .bar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 20px;background:#fff;border-bottom:1px solid #dde1e6}
  #gpdf h1{font-size:18px;margin:0 10px 0 0}
  #gpdf .btn{border:1px solid #c9ced6;background:#fff;border-radius:6px;padding:7px 12px;font:inherit;font-weight:600;cursor:pointer;color:inherit}
  #gpdf .btn:disabled{opacity:.45;cursor:not-allowed}
  #gpdf .btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
  #gpdf .btn.danger{background:#c5221f;border-color:#c5221f;color:#fff}
  #gpdf select,#gpdf input[type=text]{font:inherit;padding:5px 8px;border:1px solid #c9ced6;border-radius:6px;background:#fff;color:inherit}
  #gpdf label{display:inline-flex;gap:6px;align-items:center}
  #gpdf .muted{color:#5f6874;font-size:13px}
  #gpdf .tab{border:0;background:none;padding:5px 10px;border-radius:5px;font:inherit;cursor:pointer;color:#5f6874}
  #gpdf .tab[aria-selected=true]{background:#e8eaed;color:#1c2128;font-weight:600}
  #gpdf .main{flex:1;overflow:auto;padding:16px 20px 60px}
  #gpdf .msg{padding:10px 14px;border-radius:6px;background:#fff;border:1px solid #dde1e6;margin-bottom:12px}
  #gpdf .prog{height:6px;background:#e8eaed;border-radius:3px;overflow:hidden;margin-top:8px}#gpdf .prog i{display:block;height:100%;background:#1a73e8;width:0}
  #gpdf .group{background:#fff;border:1px solid #dde1e6;border-radius:8px;margin-bottom:14px;padding:12px 14px}
  #gpdf .group.dup{border-left:4px solid #c5221f}#gpdf .group.notdup{border-left:4px solid #188038}#gpdf .group.done{opacity:.6}
  #gpdf .ghead{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px}
  #gpdf .chip{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
  #gpdf .c-same{color:#c5221f}#gpdf .c-moment{color:#b06000}#gpdf .c-looks{color:#1a73e8}#gpdf .c-name{color:#5f6874}
  #gpdf .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
  #gpdf .tile{border:2px solid #e3e6ea;border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
  #gpdf .tile.keep{border-color:#188038}#gpdf .tile.drop img{opacity:.45}
  #gpdf .tile img{width:100%;aspect-ratio:1;object-fit:contain;background:#e8eaed;display:block;cursor:zoom-in}
  #gpdf .tile .info{padding:6px 8px;font-size:12px;flex:1}
  #gpdf .tile .nm{font-weight:600;word-break:break-all}
  #gpdf .tile .best{color:#188038;font-weight:700}
  #gpdf .tile .kb{border:0;border-top:1px solid #e3e6ea;background:#fafbfc;padding:7px 8px;font:inherit;font-weight:600;cursor:pointer;text-align:left;color:inherit}
  #gpdf .tile.keep .kb{color:#188038}
  #gpdf .pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:10px 0}
  #gpdf .lb{position:fixed;inset:0;background:#000d;display:grid;place-items:center;z-index:2147483001;cursor:zoom-out}
  #gpdf .lb img{max-width:92vw;max-height:88vh}
  @media (prefers-color-scheme: dark){
    #gpdf{background:#1b1c1f;color:#e3e3e3}#gpdf .top,#gpdf .bar,#gpdf .group,#gpdf .msg,#gpdf .btn,#gpdf select{background:#26272b;border-color:#3c4043;color:#e3e3e3}
    #gpdf .tile{border-color:#3c4043}#gpdf .tile .kb{background:#202124;border-color:#3c4043}#gpdf .tab[aria-selected=true]{background:#3c4043;color:#fff}
    #gpdf .tile img{background:#303134}#gpdf .btn.primary{background:#8ab4f8;border-color:#8ab4f8;color:#202124}}`;

  /* ------------------------------------------------------------------ state */
  const S = { items: [], groups: [], albums: [], filter: 'open', page: 0, opts: { source: 'library', type: 'both', same: true, moment: true, looks: true, thr: 6 },
    keepAlbums: true, oldestDate: false, log: [] };
  let root, bar, main, scanning = false;
  const api = () => W.gptkApi;

  function open() {
    if (!api()) { alert('Google Photos Toolkit (GPTK) is not loaded yet. Install/enable it and reload this page.'); return; }
    if (root) { root.style.display = 'flex'; return; }
    const style = h('style'); style.textContent = css;
    root = h('div', { id: 'gpdf' }, style);
    bar = h('div', { class: 'bar' }); main = h('div', { class: 'main' });
    root.append(renderTop(), bar, main);
    document.body.append(root);
    renderAll();
    loadAlbumList();
  }
  function renderTop() {
    const o = S.opts;
    const src = h('select', { onchange: e => { o.source = e.target.value; } }, h('option', { value: 'library' }, 'Whole library'));
    S.srcSelect = src;
    const type = h('select', { onchange: e => { o.type = e.target.value; } }, h('option', { value: 'both' }, 'Photos & videos'), h('option', { value: 'photo' }, 'Photos'), h('option', { value: 'video' }, 'Videos'));
    const chk = (k, label) => h('label', {}, h('input', { type: 'checkbox', checked: o[k], onchange: e => { o[k] = e.target.checked; } }), label);
    const thr = h('select', { onchange: e => { o.thr = +e.target.value; } }, h('option', { value: 3 }, 'strict'), h('option', { value: 6, selected: true }, 'normal'), h('option', { value: 10 }, 'loose'));
    S.status = h('span', { class: 'muted' });
    return h('div', { class: 'top' }, h('h1', {}, 'Duplicate Finder'), src, type,
      chk('same', 'Same name + size'), chk('moment', 'Same moment'), chk('looks', 'Look-alike'), h('label', {}, 'strictness', thr),
      h('button', { class: 'btn primary', onclick: scan }, 'Scan'), S.status, h('span', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => { root.style.display = 'none'; } }, 'Close'));
  }
  async function loadAlbumList() {
    try {
      let pid = null; const out = [];
      do { const p = await api().getAlbums(pid); if (!p) break; pid = p.nextPageId || null; out.push(...(p.items || []).filter(a => !a.isShared)); } while (pid);
      S.albums = out;
      for (const a of out.sort((x, y) => lower(x.title).localeCompare(lower(y.title)))) S.srcSelect.append(h('option', { value: a.mediaKey }, `Album: ${a.title} (${a.itemCount ?? '?'})`));
    } catch (e) { /* album list is optional */ }
  }

  /* ------------------------------------------------------------------ scan */
  const setStatus = (t, frac) => {
    clear(main).append(h('div', { class: 'msg' }, t, frac != null ? h('div', { class: 'prog' }, h('i', { style: `width:${Math.round(frac * 100)}%` })) : null));
  };
  async function scan() {
    if (scanning) return; scanning = true;
    const o = { ...S.opts }, A = api();
    try {
      // 1. items
      let list = [];
      if (o.source === 'library') {
        let pid = null, ts = null;
        do {
          const p = await A.getItemsByTakenDate(ts, null, pid); if (!p) break;
          pid = p.nextPageId || null; ts = Number.isFinite(p.lastItemTimestamp) ? p.lastItemTimestamp - 1 : null;
          list.push(...(p.items || [])); setStatus(`Reading your library… ${list.length.toLocaleString()} items`);
        } while (pid);
      } else {
        let pid = null;
        do { const p = await A.getAlbumPage(o.source, pid); if (!p) break; pid = p.nextPageId || null; list.push(...(p.items || [])); setStatus(`Reading the album… ${list.length}`); } while (pid);
        // album items carry album-scoped keys: find their library entries by dedupKey
        const want = new Set(list.map(i => i.dedupKey)); const lib = new Map(); let pid2 = null, ts = null;
        do { const p = await A.getItemsByTakenDate(ts, null, pid2); if (!p) break; pid2 = p.nextPageId || null; ts = Number.isFinite(p.lastItemTimestamp) ? p.lastItemTimestamp - 1 : null;
          for (const it of p.items || []) if (want.has(it.dedupKey)) lib.set(it.dedupKey, it); setStatus(`Matching album photos to your library… ${lib.size}/${want.size}`); } while (pid2 && lib.size < want.size);
        list = [...lib.values()];
      }
      const seen = new Set(); list = list.filter(i => !seen.has(i.mediaKey) && seen.add(i.mediaKey));
      list = list.filter(i => o.type === 'both' || (o.type === 'video') === !!i.duration);
      if (!list.length) { setStatus('No photos found for that choice.'); return; }
      // 2. names + sizes
      const info = new Map(); let done = 0;
      await pool(chunks(list.map(i => i.mediaKey), 1000), 3, async c => {
        let r = null; for (let t = 0; t < 3 && !r; t++) { try { r = await A.getBatchMediaInfo(c); } catch (e) { await new Promise(z => setTimeout(z, 1500)); } }
        for (const x of r || []) info.set(x.mediaKey, x);
        done += c.length; setStatus(`Reading file names and sizes… ${done.toLocaleString()}/${list.length.toLocaleString()}`, done / list.length);
      });
      S.items = list.map((it, i) => { const m = info.get(it.mediaKey) || {}; return { i, k: it.mediaKey, d: it.dedupKey, thumb: it.thumb, w: it.resWidth, h: it.resHeight,
        t: it.timestamp, tz: it.timezoneOffset ?? m.timezoneOffset ?? 0, up: it.creationTimestamp, video: !!it.duration, fav: !!it.isFavorite,
        name: m.fileName || '', size: m.size ?? null, orig: m.isOriginalQuality, dh: null }; });
      // 3. look-alike fingerprints (cached)
      if (o.looks) {
        const cache = await idb.getAll(); const need = [], fresh = [];
        for (const it of S.items) { const c = cache.get(it.d); if (c) it.dh = c; else if (it.thumb) need.push(it); }
        let n = 0, failed = 0;
        await pool(need, 8, async it => {
          try { it.dh = await fingerprint(it.thumb); fresh.push([it.d, it.dh]); } catch (e) { failed++; }
          if (++n % 25 === 0 || n === need.length) setStatus(`Fingerprinting thumbnails… ${n.toLocaleString()}/${need.length.toLocaleString()} (${(S.items.length - need.length).toLocaleString()} remembered from last time)`, n / need.length);
          if (fresh.length >= 500) await idb.put(fresh.splice(0));
        });
        await idb.put(fresh);
        if (failed) console.warn(`[duplicate finder] ${failed} thumbnails could not be read`);
      }
      // 4. albums each item is in (to carry them over to the kept photo)
      setStatus('Reading albums…');
      S.inAlbums = new Map(); S.albumTitle = {};
      await pool(S.albums, 3, async a => {
        S.albumTitle[a.mediaKey] = a.title; let pid = null;
        do { const p = await A.getAlbumPage(a.mediaKey, pid); if (!p) break; pid = p.nextPageId || null;
          for (const it of p.items || []) (S.inAlbums.get(it.dedupKey) || S.inAlbums.set(it.dedupKey, new Set()).get(it.dedupKey)).add(a.mediaKey); } while (pid);
      });
      setStatus('Grouping…');
      await new Promise(z => setTimeout(z, 0));
      group(o);
      S.filter = 'open'; S.page = 0;
      S.status.textContent = `${S.items.length.toLocaleString()} items scanned · ${S.groups.length} groups`;
      scanning = false;
      renderAll();
    } catch (e) { setStatus('Scan failed: ' + (e.message || e)); console.error(e); }
    finally { scanning = false; }
  }

  function group(o) {
    const F = S.items, n = F.length, par = new Int32Array(n).map((_, i) => i);
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const why = new Map();
    const link = (a, b, r) => { const ra = find(a), rb = find(b); if (ra !== rb) par[ra] = rb; why.set(a, (why.get(a) || new Set()).add(r)); why.set(b, (why.get(b) || new Set()).add(r)); };
    const aspect = it => (it.w && it.h ? it.w / it.h : 0);
    const sameAspect = (a, b) => { const x = aspect(a), y = aspect(b); return !x || !y || Math.abs(x - y) / Math.max(x, y) < 0.05 || Math.abs(x - 1 / y) / Math.max(x, 1 / y) < 0.05; };
    if (o.same) { const m = new Map(); F.forEach((f, i) => { if (!f.name || f.size == null) return; const key = lower(f.name) + '|' + f.size; if (m.has(key)) link(m.get(key), i, 'same'); else m.set(key, i); }); }
    if (o.moment) {
      const m = new Map(); F.forEach((f, i) => { if (!f.t) return; const key = Math.floor(f.t / 1000) + '|' + f.video; (m.get(key) || m.set(key, []).get(key)).push(i); });
      for (const a of m.values()) if (a.length > 1 && a.length <= 30) for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) if (sameAspect(F[a[x]], F[a[y]])) link(a[x], a[y], 'moment');
    }
    if (o.looks) {
      const idx = []; F.forEach((f, i) => { if (f.dh) { const b = pop(f.dh[0]) + pop(f.dh[1]); if (b >= 6 && b <= 58) idx.push(i); } });
      const H = new Uint32Array(idx.map(i => F[i].dh[0])), L = new Uint32Array(idx.map(i => F[i].dh[1]));
      for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++)
        if (pop(H[x] ^ H[y]) + pop(L[x] ^ L[y]) <= o.thr && sameAspect(F[idx[x]], F[idx[y]])) link(idx[x], idx[y], 'looks');
    }
    const gm = new Map();
    for (let i = 0; i < n; i++) { if (!why.has(i)) continue; const r = find(i); (gm.get(r) || gm.set(r, []).get(r)).push(i); }
    const saved = load().decisions || {};
    S.groups = [...gm.values()].filter(g => g.length > 1).map(ids => {
      ids.sort((a, b) => rank(F[a], F[b]));
      const reasons = new Set(); ids.forEach(i => why.get(i).forEach(r => reasons.add(r)));
      if (new Set(ids.map(i => stemOf(F[i].name))).size === 1) reasons.add('name');
      const sig = ids.map(i => F[i].d).sort().join(',');
      const g = { ids, reasons: [...reasons], sig, keep: new Set([ids[0]]), status: 'open' };
      const sv = saved[sig]; if (sv) { g.status = sv.s; if (sv.k) { const k = ids.filter(i => sv.k.includes(F[i].d)); if (k.length) g.keep = new Set(k); } }
      return g;
    }).sort((a, b) => (b.reasons.includes('same') - a.reasons.includes('same')) || b.ids.length - a.ids.length);
  }
  function rank(a, b) {
    const px = x => (x.w || 0) * (x.h || 0);
    return (px(b) - px(a)) || ((b.size || 0) - (a.size || 0)) || ((b.orig ? 1 : 0) - (a.orig ? 1 : 0)) || ((a.t || 9e15) - (b.t || 9e15)) || ((a.up || 9e15) - (b.up || 9e15)) ||
      ((/\(\d+\)/.test(a.name) ? 1 : 0) - (/\(\d+\)/.test(b.name) ? 1 : 0));
  }
  function persist() {
    const st = load(); st.decisions = st.decisions || {};
    for (const g of S.groups) { if (g.status === 'open') delete st.decisions[g.sig]; else st.decisions[g.sig] = { s: g.status, k: [...g.keep].map(i => S.items[i].d) }; }
    save(st);
  }

  /* ------------------------------------------------------------------ render */
  const REASON = { same: ['c-same', 'Same name + size'], moment: ['c-moment', 'Same moment'], looks: ['c-looks', 'Look-alike'], name: ['c-name', 'Same name'] };
  function toTrash() { const out = []; for (const g of S.groups) if (g.status === 'dup') for (const i of g.ids) if (!g.keep.has(i)) out.push({ it: S.items[i], g }); return out; }
  function renderAll() { renderBar(); renderList(); }
  function renderBar() {
    if (!bar) return;
    const c = s => S.groups.filter(g => s === 'all' || g.status === s).length;
    const tab = (k, l) => h('button', { class: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; S.page = 0; renderAll(); } }, `${l} ${c(k)}`);
    const tt = toTrash(); const bytes = tt.reduce((s, x) => s + (x.it.size || 0), 0);
    clear(bar).append(...[tab('open', 'To review'), tab('dup', 'Duplicates'), tab('notdup', 'Not duplicates'), tab('done', 'Removed'), tab('all', 'All'),
      h('span', { style: 'flex:1' }),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: S.keepAlbums, onchange: e => { S.keepAlbums = e.target.checked; } }), 'Add kept photo to the albums of removed copies'),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: S.oldestDate, onchange: e => { S.oldestDate = e.target.checked; } }), 'Give kept photo the oldest date taken'),
      S.log.length ? h('button', { class: 'btn', onclick: downloadLog }, 'Download log') : null,
      h('button', { class: 'btn danger', disabled: !tt.length, onclick: apply }, `Move ${tt.length} to trash (${fmtBytes(bytes)})`)].filter(Boolean));
  }
  function renderList() {
    if (!main || scanning) return;
    clear(main);
    if (!S.groups.length) { main.append(h('div', { class: 'msg' }, S.items.length ? 'No duplicates found with these checks.' : 'Choose what to scan and press Scan. Look-alike checking fetches a small thumbnail of every photo the first time; later scans reuse them.')); return; }
    const list = S.groups.filter(g => S.filter === 'all' || g.status === S.filter);
    if (!list.length) { main.append(h('div', { class: 'msg' }, S.filter === 'open' ? 'All groups reviewed. See the Duplicates tab, then press "Move to trash".' : 'Nothing here.')); return; }
    const pages = Math.ceil(list.length / PAGE); S.page = Math.min(S.page, pages - 1);
    const pager = () => h('div', { class: 'pager' }, h('button', { class: 'btn', disabled: S.page === 0, onclick: () => { S.page--; renderList(); main.scrollTop = 0; } }, '← Prev'),
      h('span', { class: 'muted' }, `Page ${S.page + 1} of ${pages} · ${list.length} groups`), h('button', { class: 'btn', disabled: S.page >= pages - 1, onclick: () => { S.page++; renderList(); main.scrollTop = 0; } }, 'Next →'));
    main.append(pager());
    for (const g of list.slice(S.page * PAGE, (S.page + 1) * PAGE)) main.append(renderGroup(g));
    main.append(pager());
  }
  function renderGroup(g) {
    const F = g.ids.map(i => S.items[i]);
    const maxPx = Math.max(...F.map(f => (f.w || 0) * (f.h || 0))), maxSz = Math.max(...F.map(f => f.size || 0)), minT = Math.min(...F.map(f => f.t || 9e15));
    const differ = (vals) => new Set(vals).size > 1;
    const head = h('div', { class: 'ghead' }, ...g.reasons.map(r => h('span', { class: 'chip ' + REASON[r][0] }, REASON[r][1])),
      h('span', { class: 'muted' }, `${F.length} items`), h('span', { style: 'flex:1' }));
    if (g.status === 'done') head.append(h('span', { class: 'muted' }, 'Extra copies moved to trash'));
    else {
      head.append(h('button', { class: 'btn', onclick: () => { g.status = g.status === 'notdup' ? 'open' : 'notdup'; persist(); renderAll(); } }, g.status === 'notdup' ? 'Undo "not duplicates"' : 'Not duplicates'));
      head.append(h('button', { class: g.status === 'dup' ? 'btn' : 'btn primary', onclick: () => { if (!g.keep.size) { alert('Choose at least one to keep.'); return; } g.status = g.status === 'dup' ? 'open' : 'dup'; persist(); renderAll(); } }, g.status === 'dup' ? 'Undo' : 'Duplicates: keep selected'));
    }
    const tiles = h('div', { class: 'tiles' });
    F.forEach((f, n) => {
      const id = g.ids[n], keep = g.keep.has(id);
      const albums = [...(S.inAlbums?.get(f.d) || [])].map(a => S.albumTitle[a]).filter(Boolean);
      const best = (cond) => cond ? h('span', { class: 'best' }, ' ▲') : null;
      tiles.append(h('div', { class: 'tile ' + (g.status === 'notdup' ? '' : keep ? 'keep' : g.status === 'dup' || g.status === 'done' ? 'drop' : '') },
        h('img', { src: thumb(f.thumb, 360), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onclick: () => lightbox(f) }),
        h('div', { class: 'info' },
          h('div', { class: 'nm' }, f.name || '(no name)'),
          h('div', {}, `${f.w && f.h ? `${f.w}×${f.h}` : '—'}`, best(differ(F.map(x => (x.w || 0) * (x.h || 0))) && (f.w || 0) * (f.h || 0) === maxPx), ` · ${fmtBytes(f.size)}`, best(differ(F.map(x => x.size)) && f.size === maxSz)),
          h('div', { class: 'muted' }, 'Taken ', fmtDate(f.t, f.tz), best(differ(F.map(x => x.t)) && f.t === minT)),
          h('div', { class: 'muted' }, 'Uploaded ', fmtDate(f.up, f.tz)),
          f.video ? h('div', { class: 'muted' }, 'Video') : null,
          albums.length ? h('div', { class: 'muted' }, 'Albums: ' + albums.join(', ')) : null,
          h('a', { href: `https://photos.google.com/photo/${f.k}`, target: '_blank', rel: 'noopener', class: 'muted' }, 'Open in Google Photos')),
        g.status === 'done' ? null : h('button', { class: 'kb', onclick: () => { if (g.keep.has(id)) g.keep.delete(id); else g.keep.add(id); if (g.status === 'notdup') g.status = 'open'; persist(); const fresh = renderGroup(g); el.replaceWith(fresh); renderBar(); } },
          keep ? 'Keep ✓' : (g.status === 'dup' ? 'Will be trashed' : 'Keep this one'), id === g.ids[0] ? h('span', { class: 'muted' }, '  (suggested)') : null)));
    });
    const el = h('div', { class: 'group ' + g.status }, head, tiles);
    return el;
  }
  function lightbox(f) {
    const lb = h('div', { class: 'lb', onclick: () => lb.remove() }, h('img', { src: thumb(f.thumb, 1600), alt: f.name, referrerpolicy: 'no-referrer' }));
    root.append(lb);
  }

  /* ------------------------------------------------------------------ apply */
  async function apply() {
    const tt = toTrash(); if (!tt.length) return;
    const groups = [...new Set(tt.map(x => x.g))];
    if (!confirm(`Move ${tt.length} duplicate(s) from ${groups.length} group(s) to Google Photos trash?` +
      (S.keepAlbums ? '\nKept photos will first be added to the albums the removed copies were in.' : '') +
      (S.oldestDate ? '\nKept photos will get the oldest date taken in their group.' : '') + '\nYou can restore them from the trash for 60 days.')) return;
    const A = api(); let ok = 0, fail = 0;
    for (const g of groups) {
      const keep = [...g.keep].map(i => S.items[i]), drop = g.ids.filter(i => !g.keep.has(i)).map(i => S.items[i]);
      try {
        if (S.keepAlbums) {
          const need = new Set(); drop.forEach(d => (S.inAlbums?.get(d.d) || []).forEach(a => need.add(a)));
          for (const a of need) { const missing = keep.filter(k => !(S.inAlbums?.get(k.d) || new Set()).has(a)).map(k => k.k); if (missing.length) await A.addItemsToAlbum(missing, a); }
        }
        if (S.oldestDate) {
          const all = [...keep, ...drop].filter(x => x.t); const old = all.reduce((p, c) => (c.t < p.t ? c : p), all[0]);
          const upd = keep.filter(k => old && k.t > old.t).map(k => ({ dedupKey: k.d, timestampSec: Math.floor(old.t / 1000), timezoneSec: Math.round((old.tz || 0) / 1000) }));
          if (upd.length) await A.setItemsTimestamp(upd);
        }
        await A.moveItemsToTrash(drop.map(d => d.d));
        g.status = 'done'; ok += drop.length;
        S.log.push({ at: new Date().toISOString(), kept: keep.map(k => k.name + ' [' + k.k + ']').join(' | '), removed: drop.map(d => d.name + ' [' + d.k + ']').join(' | '), reasons: g.reasons.join(' ') });
      } catch (e) { fail += drop.length; console.error('[duplicate finder]', e); }
    }
    persist(); renderAll();
    alert(`Moved ${ok} to trash.` + (fail ? ` ${fail} failed and are still marked as duplicates.` : ''));
  }
  function downloadLog() {
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['when', 'kept', 'moved_to_trash', 'matched_by'].join(',')].concat(S.log.map(r => [r.at, r.kept, r.removed, r.reasons].map(q).join(',')));
    const a = h('a', { href: URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv' })), download: 'duplicate_finder_log.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  /* ------------------------------------------------------------------ launcher */
  function addButton() {
    if (document.getElementById('gpdf-btn')) return;
    const style = h('style'); style.textContent = '#gpdf-btn{position:fixed;right:20px;bottom:20px;z-index:2147482000;background:#1a73e8;color:#fff;border:0;border-radius:24px;padding:10px 16px;font:600 14px/1 system-ui,sans-serif;box-shadow:0 2px 8px #0004;cursor:pointer}';
    document.head.append(style);
    document.body.append(h('button', { id: 'gpdf-btn', onclick: open, title: 'Find duplicate photos (needs Google Photos Toolkit)' }, 'Find duplicates'));
  }
  const wait = setInterval(() => { if (document.body) { clearInterval(wait); addButton(); } }, 500);
})();