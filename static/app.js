'use strict';
// NAI 검수 뷰어 — 화면 로직. 서버 API는 review_viewer.py.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const enc = encodeURIComponent;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function req(url, body) {
  const r = await fetch(url, body === undefined ? undefined
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const MODES = [
  { id: '1', label: '1장', c: 1, r: 1 },
  { id: '2', label: '2장 (2×1)', c: 2, r: 1 },
  { id: '3', label: '3장 (3×1)', c: 3, r: 1 },
  { id: '4', label: '4장 (2×2)', c: 2, r: 2 },
  { id: '6', label: '6장 (3×2)', c: 3, r: 2 },
  { id: '8', label: '8장 (4×2)', c: 4, r: 2 },
  { id: '10', label: '10장 (5×2)', c: 5, r: 2 },
  { id: '12', label: '12장 (4×3)', c: 4, r: 3 },
  { id: '15', label: '15장 (5×3)', c: 5, r: 3 },
  { id: '18', label: '18장 (6×3)', c: 6, r: 3 },
  { id: '24', label: '24장 (6×4)', c: 6, r: 4 },
  { id: '32', label: '32장 (8×4)', c: 8, r: 4 },
  { id: '48', label: '48장 (8×6)', c: 8, r: 6 },
  { id: 'set', label: '세트별 (같은 씬 묶음)' },
];

const SETTINGS_DEFAULT = {
  autoAdvance: 'single', confirmDelete: true, bg: 'dark', seenDelay: 450, thumbHigh: false,
  seenDot: true, wheelPaging: true, clickClears: true,
};

const S = {
  cfg: null, tags: [], tagById: new Map(), tagByKey: new Map(),
  root: '', listPath: null, files: [], dirs: [], setIndex: new Map(), byKey: new Map(), pos: new Map(),
  reviews: new Map(), seen: new Map(), edited: new Map(),
  sub: '', includeSub: true,
  mode: '10', prevMode: null, filter: 'all', sort: 'name', search: '', promptHits: null, promptQuery: '',
  list: [], pages: [], page: 0, focus: 0,
  sel: new Set(), anchor: null,
  showNames: true, showInfo: false, showTree: true,
  undo: [], preload: [], metaCache: new Map(), warmKey: '',
  zoom: { s: 1, x: 0, y: 0 },
  set: { ...SETTINGS_DEFAULT },
  modalEnter: null,
};

const modeOf = (id) => MODES.find((m) => m.id === id) || MODES[0];
const isSingle = () => modeOf(S.mode).id === '1';
const absOf = (f) => S.root + '\\' + f.rel.replaceAll('/', '\\');
const sameTime = (a, b) => a == null || Math.abs(a - b) < 0.01;
const revOf = (f) => { const r = S.reviews.get(f.key); return r && sameTime(r.mtime, f.mtime) ? r : null; };
const staleOf = (f) => { const r = S.reviews.get(f.key); return r && !sameTime(r.mtime, f.mtime) ? r : null; };
const tagsOf = (f) => revOf(f)?.tags || [];
const kindsOf = (f) => new Set(tagsOf(f).map((t) => S.tagById.get(t)?.kind).filter(Boolean));
const isSeen = (f) => S.seen.has(f.key) && sameTime(S.seen.get(f.key), f.mtime);
const curFile = () => S.files[(S.pages[S.page] || [])[S.focus]];
const setHasKeeper = (set) => (S.setIndex.get(set) || []).some((i) => kindsOf(S.files[i]).has('keeper'));
const isSetReject = (f) => !kindsOf(f).size && setHasKeeper(f.set);
const isRegen = (f) => kindsOf(f).has('negative');

/** 체크·삭제 대상: 선택이 있으면 선택 전부, 없으면 현재 칸. */
function targets() {
  if (S.sel.size) return [...S.sel].map((k) => S.byKey.get(k)).filter(Boolean);
  const f = curFile();
  return f ? [f] : [];
}

// ───────────────────────── 로드 ─────────────────────────

async function init() {
  loadSettings();
  S.cfg = await req('/api/config');
  S.tags = S.cfg.tags;
  for (const t of S.tags) { S.tagById.set(t.id, t); S.tagByKey.set(t.key.toLowerCase(), t); }

  $('#selMode').innerHTML = MODES.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  const filters = [
    ['all', '전체'], ['unseen', '안 본 것'], ['seen', '본 것'], ['unmarked', '체크 없음'], ['marked', '체크한 것 전부'],
    ['regen', '불합격 (재생성)'], ['setreject', '세트 탈락'], ['keeper', '★ 세트 대표'], ['more', '+ 추가 생산'],
    ['note', '메모 있음'], ['stale', '파일 바뀜 (이전 체크)'], ['multi', '여러 장 세트만'], ['edited', '🩹 검열 덧칠한 것'],
    ...S.tags.filter((t) => t.kind === 'negative').map((t) => [`tag:${t.id}`, `사유: ${t.label}`]),
  ];
  $('#selFilter').innerHTML = filters.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  buildPalette();
  bindUI();
  applySettings();

  const qs = new URLSearchParams(location.search);
  if (qs.get('list')) {
    try { await openRoot('', false, qs.get('list')); return; } catch (e) { toast(e.message, true); }
  }
  const q = qs.get('root') || lsGet('rv:lastRoot');
  if (q) {
    try { await openRoot(q); return; } catch (e) { toast(e.message, true); }
  }
  showRootModal();
}

const posKey = () => (S.listPath ? 'rv:pos:list:' + S.listPath : 'rv:pos:' + S.root);

function buildPalette() {
  const btn = (t) => `<button class="tagbtn" data-tag="${t.id}" style="color:${t.color}" title="${esc(t.label)}&#10;${esc(t.llm_hint || '')}"><kbd>${esc(t.key.toUpperCase())}</kbd><span class="full">${esc(t.label)}</span><span class="short">${esc(t.short || t.label)}</span><span class="cnt"></span></button>`;
  const pos = S.tags.filter((t) => t.kind !== 'negative').map(btn).join('');
  const neg = S.tags.filter((t) => t.kind === 'negative').map(btn).join('');
  $('#palette').innerHTML = `<span class="lead" id="palLead"></span>${pos}<span class="sep"></span>${neg}<span class="sep"></span>`
    + `<button class="tagbtn" data-act="note"><kbd>M</kbd>메모</button>`
    + `<button class="tagbtn" data-act="clear"><kbd>0</kbd>해제</button>`
    + `<button class="tagbtn" data-act="censor" style="color:#7ee0c3" title="블러·모자이크·먹칠을 덧칠해 저장(재생성 없이 검열 보강)"><kbd>E</kbd>검열 덧칠</button>`
    + `<button class="tagbtn" data-act="delete" style="color:#ff9a93"><kbd>Del</kbd>삭제</button>`;
}

function reindex() {
  S.setIndex = new Map(); S.byKey = new Map();
  S.files.forEach((f, i) => {
    f.i = i; f.key = f.rel.toLowerCase();
    S.byKey.set(f.key, f);
    if (!S.setIndex.has(f.set)) S.setIndex.set(f.set, []);
    S.setIndex.get(f.set).push(i);
  });
}

/** 폴더를 연다. listPath가 있으면 목록 모드(그 목록의 이미지만 — nai_autogen.py eyes --open). */
async function openRoot(root, keepPos = false, listPath = undefined) {
  if (listPath === undefined) listPath = keepPos ? S.listPath : null;
  const keep = keepPos ? curFile()?.key : null;
  const d = await req(listPath ? '/api/scan?list=' + enc(listPath) : '/api/scan?root=' + enc(root));
  const rv = await req('/api/reviews?root=' + enc(d.root));
  if (d.root !== S.root || listPath !== S.listPath) { S.undo = []; S.metaCache.clear(); S.sel.clear(); S.promptHits = null; S.promptQuery = ''; $('#search').value = ''; S.search = ''; }
  S.root = d.root; S.files = d.files; S.dirs = d.dirs; S.listPath = listPath;
  reindex();
  for (const k of [...S.sel]) if (!S.byKey.has(k)) S.sel.delete(k);
  S.reviews = new Map(Object.entries(rv.reviews));
  S.seen = new Map(Object.entries(rv.seen));
  S.edited = new Map(Object.entries(rv.edited || {}));
  const listName = listPath ? listPath.split('\\').slice(-3).join('\\') : '';
  $('#rootLabel').textContent = listPath ? `📋 목록 ${S.files.length}장 · ${listName}` : S.root;
  $('#rootLabel').title = (listPath ? `목록 모드: ${listPath}\n` : '') + `${S.root}\n클릭하면 경로 복사`;
  document.title = listPath ? `검수 — 목록 ${S.files.length}장` : `검수 — ${S.root.split('\\').pop()}`;
  history.replaceState(null, '', listPath ? '?list=' + enc(listPath) : '?root=' + enc(S.root));
  if (!listPath) lsSet('rv:lastRoot', S.root);

  let target = keep;
  if (!keepPos) {
    const pos = JSON.parse(lsGet(posKey()) || 'null');
    if (pos) {
      Object.assign(S, { mode: pos.mode || S.mode, filter: pos.filter || 'all', sort: pos.sort || 'name',
        sub: S.dirs.some((x) => x.rel === pos.sub) ? pos.sub : '', includeSub: pos.includeSub ?? true });
      target = pos.key;
    } else {
      Object.assign(S, { sub: '', filter: 'all' });
    }
  }
  syncControls();
  rebuild(target);
  renderTree();
}

// ───────────────────────── 목록 · 페이지 ─────────────────────────

function inScope(f) {
  if (S.sub === '') return S.includeSub || f.dir === '';
  return f.dir === S.sub || (S.includeSub && f.dir.startsWith(S.sub + '/'));
}

function passFilter(f) {
  const r = revOf(f);
  const tags = r?.tags || [];
  switch (S.filter) {
    case 'all': return true;
    case 'unseen': return !isSeen(f);
    case 'seen': return isSeen(f);
    case 'unmarked': return !tags.length && !r?.note;
    case 'marked': return tags.length > 0 || !!r?.note;
    case 'regen': return isRegen(f);
    case 'setreject': return isSetReject(f);
    case 'keeper': return kindsOf(f).has('keeper');
    case 'more': return kindsOf(f).has('positive');
    case 'note': return !!r?.note;
    case 'stale': return !!staleOf(f);
    case 'multi': return (S.setIndex.get(f.set) || []).length > 1;
    case 'edited': return S.edited.has(f.key);
    default: return S.filter.startsWith('tag:') ? tags.includes(S.filter.slice(4)) : true;
  }
}

function rebuild(targetKey) {
  const q = S.search.trim().toLowerCase();
  const list = S.files.filter((f) => inScope(f) && (!q || f.key.includes(q))
    && (!S.promptHits || S.promptHits.has(f.key)) && passFilter(f)).map((f) => f.i);
  if (S.sort === 'mtime_asc') list.sort((a, b) => S.files[a].mtime - S.files[b].mtime);
  if (S.sort === 'mtime_desc') list.sort((a, b) => S.files[b].mtime - S.files[a].mtime);
  if (S.sort === 'size_desc') list.sort((a, b) => S.files[b].size - S.files[a].size);
  S.list = list;
  S.pos = new Map(list.map((i, p) => [S.files[i].key, p]));

  const m = modeOf(S.mode);
  if (m.id === 'set') {
    const groups = new Map();
    for (const i of list) {
      const k = S.files[i].set;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    S.pages = [...groups.values()];
  } else {
    const n = m.c * m.r;
    S.pages = [];
    for (let i = 0; i < list.length; i += n) S.pages.push(list.slice(i, i + n));
  }

  S.page = 0; S.focus = 0;
  if (targetKey) {
    for (let p = 0; p < S.pages.length; p++) {
      const at = S.pages[p].findIndex((i) => S.files[i].key === targetKey);
      if (at >= 0) { S.page = p; S.focus = at; break; }
    }
  }
  render();
}

// ───────────────────────── 그리기 ─────────────────────────

function layoutFor(n) {
  const m = modeOf(S.mode);
  if (m.id !== 'set') return { c: m.c, r: m.r };
  const st = $('#stage').getBoundingClientRect();
  const a = S.cfg.default_aspect;
  let best = { c: 1, r: 1, s: 0 };
  for (let c = 1; c <= Math.max(1, n); c++) {
    const r = Math.ceil(n / c);
    const s = Math.min(st.width / c, (st.height / r) * a);   // 그림 너비 기준 크기
    if (s > best.s) best = { c, r, s };
  }
  return best;
}

function thumbSize(c, r) {
  const st = $('#stage').getBoundingClientRect();
  const a = S.cfg.default_aspect;
  const need = Math.min(st.height / r, (st.width / c) / a) * (window.devicePixelRatio || 1) * (S.set.thumbHigh ? 1.5 : 1);
  return S.cfg.thumb_sizes.find((s) => s >= need * 0.9) || 0;   // 0 = 원본
}

function imgUrl(f, size) {
  return size ? `/api/thumb?p=${enc(absOf(f))}&s=${size}&v=${f.mtime}` : `/api/img?p=${enc(absOf(f))}&v=${f.mtime}`;
}

function render() {
  const grid = $('#grid');
  const page = S.pages[S.page] || [];
  $('#empty').hidden = page.length > 0;
  if (!page.length) {
    $('#empty').textContent = !S.root ? '📁로 검수할 폴더를 여세요.'
      : S.files.length ? '조건에 맞는 이미지가 없습니다.\n필터·검색·폴더 범위를 확인하세요.' : '이 폴더에 이미지가 없습니다.';
  }
  const { c, r } = layoutFor(page.length);
  const single = c * r === 1;
  const size = single ? 0 : thumbSize(c, r);
  grid.style.gridTemplateColumns = `repeat(${c}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${r}, minmax(0, 1fr))`;

  while (grid.children.length < page.length) grid.appendChild(makeCell());
  while (grid.children.length > page.length) grid.lastChild.remove();
  const setMode = modeOf(S.mode).id === 'set';
  page.forEach((idx, k) => {
    const f = S.files[idx];
    const cell = grid.children[k];
    cell.dataset.k = k;
    cell.classList.toggle('single', single);
    const img = cell.querySelector('img');
    const src = imgUrl(f, size);
    if (img.getAttribute('src') !== src) { img.removeAttribute('src'); img.src = src; }
    img.style.transform = '';
    cell.querySelector('.zoomlv').hidden = true;
    cell.querySelector('.fname').textContent = (setMode && page.length > 1 ? `${k + 1}/${page.length} · ` : '') + f.rel;
    cell.title = f.rel;
  });
  S.focus = Math.min(S.focus, Math.max(0, page.length - 1));
  S.zoom = { s: 1, x: 0, y: 0 };
  paintMarks();
  updateStatus();
  preloadAround(size);
  warmAhead(size);
  markSeenSoon();
  savePos();
  if (S.showInfo) updateInfo();
}

function makeCell() {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.innerHTML = '<img alt="" draggable="false" decoding="async"><div class="badges"></div><div class="srj" hidden>세트 탈락</div>'
    + '<div class="seenmark" hidden title="아직 안 봄"></div><div class="selmark">✓</div><div class="zoomlv" hidden></div><div class="fname"></div>';
  cell.addEventListener('mouseenter', (e) => onCellEnter(cell, e));
  cell.addEventListener('mousedown', (e) => onCellDown(cell, e));
  cell.addEventListener('dblclick', (e) => { if (e.ctrlKey || e.shiftKey) return; setFocus(+cell.dataset.k); toggleSingle(); });
  cell.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const f = S.files[S.pages[S.page][+cell.dataset.k]];
    if (S.sel.size && !S.sel.has(f.key)) clearSel();
    setFocus(+cell.dataset.k);
    showCtx(e.clientX, e.clientY);
  });
  return cell;
}

function paintMarks() {
  const page = S.pages[S.page] || [];
  const grid = $('#grid');
  document.body.classList.toggle('selecting', S.sel.size > 0);
  page.forEach((idx, k) => {
    const f = S.files[idx];
    const cell = grid.children[k];
    if (!cell) return;
    const r = revOf(f);
    const stale = staleOf(f);
    const kinds = kindsOf(f);
    const srj = isSetReject(f);
    cell.classList.toggle('focus', k === S.focus);
    cell.classList.toggle('sel', S.sel.has(f.key));
    cell.classList.toggle('neg', kinds.has('negative'));
    cell.classList.toggle('keep', !kinds.has('negative') && kinds.has('keeper'));
    cell.classList.toggle('pos', !kinds.has('negative') && !kinds.has('keeper') && kinds.has('positive'));
    cell.classList.toggle('setrej', srj);
    cell.querySelector('.srj').hidden = !srj;
    cell.querySelector('.seenmark').hidden = isSeen(f);
    cell.querySelector('.badges').innerHTML = (r?.tags || []).map((t) => {
      const d = S.tagById.get(t);
      return d ? `<span class="chip" style="color:${d.color}">${esc(d.short || d.label)}</span>` : '';
    }).join('')
      + (r?.note ? `<span class="chip" style="color:#cfd3d8" title="${esc(r.note)}">📝 ${esc(r.note.slice(0, 24))}</span>` : '')
      + (stale ? `<span class="chip stale" title="체크 뒤 파일이 바뀌어 이전 체크는 무시됩니다: ${esc(stale.tags.map((t) => S.tagById.get(t)?.label).join(', '))}">파일 바뀜</span>` : '')
      + (S.edited.has(f.key) ? '<span class="chip" style="color:#7ee0c3" title="뷰어에서 검열을 덧칠해 저장한 파일 — E로 다시 열면 원본 복원 가능">🩹 덧칠</span>' : '');
  });
  paintPalette();
  paintSelbar();
}

function paintPalette() {
  const ts = targets();
  for (const b of $$('#palette .tagbtn[data-tag]')) {
    const id = b.dataset.tag;
    const n = ts.filter((f) => tagsOf(f).includes(id)).length;
    const on = n > 0 && n === ts.length;
    b.classList.toggle('on', on);
    b.classList.toggle('part', n > 0 && !on);
    b.style.background = on ? S.tagById.get(id).color + '55' : '';
  }
  $('#palLead').textContent = S.sel.size ? `선택 ${S.sel.size}장에 적용:` : '현재 칸:';
}

function paintSelbar() {
  const bar = $('#selbar');
  bar.hidden = !S.sel.size;
  if (S.sel.size) {
    const onPage = (S.pages[S.page] || []).filter((i) => S.sel.has(S.files[i].key)).length;
    bar.innerHTML = `<b>${S.sel.size}장 선택</b> (이 페이지 ${onPage}) · 체크 키 = 전부에 적용 · Del 삭제 · P 합격 · Esc 해제`;
  }
}

function setFocus(k) {
  if (k === S.focus) return;
  S.focus = k;
  paintMarks();
  updateStatus();
  savePos();
  if (S.showInfo) updateInfo();
}

function updateStatus() {
  const total = S.list.length;
  let regen = 0, srj = 0, more = 0, keep = 0, seen = 0;
  const byTag = new Map();
  for (const i of S.list) {
    const f = S.files[i];
    const k = kindsOf(f);
    if (k.has('negative')) regen++;
    else if (k.has('keeper')) keep++;
    else if (isSetReject(f)) srj++;
    if (k.has('positive')) more++;
    if (isSeen(f)) seen++;
    for (const t of tagsOf(f)) byTag.set(t, (byTag.get(t) || 0) + 1);
  }
  for (const b of $$('#palette .tagbtn[data-tag]')) {
    const n = byTag.get(b.dataset.tag);
    b.querySelector('.cnt').textContent = n ? n : '';
  }
  $('#prog .seen').style.width = total ? `${(seen / total) * 100}%` : '0';
  $('#prog .rej').style.width = total ? `${(regen / total) * 100}%` : '0';
  const f = curFile();
  const pageInfo = `<span class="pg" id="pgJump" title="페이지 이동 (G)">${modeOf(S.mode).id === 'set' ? '세트' : '페이지'} <b>${S.page + 1}</b>/${S.pages.length}</span>`;
  $('#status').innerHTML = `${pageInfo} · 표시 ${total}장${S.promptHits ? ` (프롬프트 "${esc(S.promptQuery)}")` : ''} · 본 것 ${seen}/${total}`
    + ` · <span class="r">불합격 ${regen}</span> · 세트 탈락 ${srj} · <span class="k">★ ${keep}</span> · <span class="p">+추가 ${more}</span>`
    + (S.sel.size ? ` · <span class="s">선택 ${S.sel.size}</span>` : '')
    + (f ? ` · <b>${esc(f.rel)}</b>` : '');
  const pg = $('#pgJump');
  if (pg) pg.onclick = jumpPageModal;
}

function preloadAround(size) {
  const pages = (S.pages[S.page] || []).length > 12 ? [1] : [1, 2, -1];
  S.preload = [];
  for (const d of pages) {
    for (const idx of S.pages[S.page + d] || []) {
      const im = new Image();
      im.decoding = 'async';
      im.src = imgUrl(S.files[idx], size);
      S.preload.push(im);
    }
  }
}

function warmAhead(size) {
  if (!size) return;
  const key = `${S.page}|${S.mode}|${size}|${S.list.length}`;
  if (key === S.warmKey) return;
  S.warmKey = key;
  const paths = [];
  for (let p = S.page + 3; p < Math.min(S.pages.length, S.page + 9) && paths.length < 300; p++) {
    for (const i of S.pages[p]) paths.push(absOf(S.files[i]));
  }
  if (paths.length) req('/api/warm', { paths, size }).catch(() => { /* 미리 만들기는 실패해도 그때 만든다 */ });
}

let seenTimer = 0;
function markSeenSoon() {
  clearTimeout(seenTimer);
  const page = S.page;
  seenTimer = setTimeout(() => {
    if (page !== S.page) return;
    const fresh = (S.pages[page] || []).map((i) => S.files[i]).filter((f) => !isSeen(f));
    if (fresh.length) setSeen(fresh, true, false);
  }, S.set.seenDelay);
}

function setSeen(files, value, undoable) {
  if (!files.length) return;
  if (undoable) pushUndo({ type: 'seen', keys: files.map((f) => f.key), value });
  for (const f of files) { if (value) S.seen.set(f.key, f.mtime); else S.seen.delete(f.key); }
  req('/api/seen', { root: S.root, rels: files.map((f) => f.rel), seen: value })
    .catch((e) => toast('본 것 기록 실패: ' + e.message, true));
  paintMarks(); updateStatus(); scheduleTree();
}

// ───────────────────────── 이동 ─────────────────────────

function goPage(p, focus = 0) {
  if (!S.pages.length) return;
  const np = Math.max(0, Math.min(S.pages.length - 1, p));
  if (np === S.page && focus === S.focus) return;
  S.page = np;
  S.focus = focus < 0 ? (S.pages[np].length - 1) : Math.min(focus, S.pages[np].length - 1);
  render();
}

function moveFocus(d) {
  const n = (S.pages[S.page] || []).length;
  const k = S.focus + d;
  if (k >= n) return goPage(S.page + 1, 0);
  if (k < 0) return S.page > 0 && goPage(S.page - 1, -1);
  setFocus(k);
}

function nextUnseenPage() {
  for (let p = S.page + 1; p < S.pages.length; p++) {
    if (S.pages[p].some((i) => !isSeen(S.files[i]))) return goPage(p);
  }
  toast('뒤쪽에 안 본 이미지가 없습니다.');
}

function setMode(id) {
  const key = curFile()?.key;
  S.mode = id;
  $('#selMode').value = id;
  rebuild(key);
}

function toggleSingle() {
  if (isSingle() && S.prevMode) { const m = S.prevMode; S.prevMode = null; setMode(m); return; }
  if (isSingle()) return;
  S.prevMode = S.mode;
  setMode('1');
}

function stepMode(d) {
  const ids = MODES.map((m) => m.id).filter((id) => id !== 'set');
  const at = ids.indexOf(S.mode);
  const next = ids[Math.max(0, Math.min(ids.length - 1, (at < 0 ? ids.indexOf('10') : at) + d))];
  S.prevMode = null;
  setMode(next);
}

function autoAdvance() {
  if (S.set.autoAdvance === 'always' || (S.set.autoAdvance === 'single' && isSingle())) {
    setTimeout(() => moveFocus(1), 110);
  }
}

// ───────────────────────── 선택 ─────────────────────────

function clearSel() {
  if (!S.sel.size) return;
  S.sel.clear();
  paintMarks(); updateStatus();
}

function toggleSel(f, on) {
  if (!f) return;
  const want = on ?? !S.sel.has(f.key);
  if (want) S.sel.add(f.key); else S.sel.delete(f.key);
  S.anchor = f.key;
}

function selectRange(fromKey, toKey) {
  const a = S.pos.get(fromKey), b = S.pos.get(toKey);
  if (a == null || b == null) return;
  for (let p = Math.min(a, b); p <= Math.max(a, b); p++) S.sel.add(S.files[S.list[p]].key);
}

function selectPage() {
  for (const i of S.pages[S.page] || []) S.sel.add(S.files[i].key);
  paintMarks(); updateStatus();
}

function selectAllList() {
  for (const i of S.list) S.sel.add(S.files[i].key);
  paintMarks(); updateStatus();
  toast(`목록 전체 ${S.sel.size}장 선택`);
}

let paint = null;   // 누른 채로 칸을 훑어 선택
function onCellDown(cell, e) {
  if (e.button !== 0) return;
  const k = +cell.dataset.k;
  const f = S.files[S.pages[S.page][k]];
  if (e.shiftKey) {
    e.preventDefault();
    selectRange(S.anchor && S.byKey.has(S.anchor) ? S.anchor : curFile()?.key, f.key);
    S.anchor = f.key;
  } else if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    toggleSel(f);
  } else {
    S.anchor = f.key;
    if (!cell.classList.contains('single')) paint = { startKey: f.key, moved: false };
  }
  setFocus(k);
  paintMarks(); updateStatus();
}

function onCellEnter(cell, e) {
  if (drag || modalOpen()) return;
  const k = +cell.dataset.k;
  if (paint && (e.buttons & 1)) {
    if (!paint.moved) {
      paint.moved = true;
      toggleSel(S.byKey.get(paint.startKey), true);
    }
    toggleSel(S.files[S.pages[S.page][k]], true);
    S.focus = k;
    paintMarks(); updateStatus();
    return;
  }
  setFocus(k);
}

function onMouseUp(e) {
  if (!paint) return;
  const p = paint;
  paint = null;
  if (!p.moved && S.set.clickClears && !e.ctrlKey && !e.shiftKey && S.sel.size) clearSel();
}

// ───────────────────────── 체크 ─────────────────────────

function pushUndo(u) {
  S.undo.push(u);
  if (S.undo.length > 300) S.undo.shift();
}

/** changes: [{f, tags, note}] — 화면·서버에 함께 반영. */
function writeReviews(changes, undoable = true) {
  if (!changes.length) return;
  if (undoable) {
    pushUndo({ type: 'rev', items: changes.map(({ f }) => {
      const r = revOf(f);
      return { key: f.key, prev: r ? { tags: [...r.tags], note: r.note } : null };
    }) });
  }
  for (const { f, tags, note } of changes) {
    if (!tags.length && !note) S.reviews.delete(f.key); else S.reviews.set(f.key, { tags, note, mtime: f.mtime });
  }
  req('/api/review', { root: S.root, items: changes.map(({ f, tags, note }) => ({ rel: f.rel, tags, note })) })
    .catch((e) => toast('저장 실패: ' + e.message, true));
  paintMarks(); updateStatus(); scheduleTree();
  if (S.showInfo) updateInfo(true);
}

function toggleTag(tagId) {
  const ts = targets();
  if (!ts.length) return;
  const t = S.tagById.get(tagId);
  const allOn = ts.every((f) => tagsOf(f).includes(tagId));
  writeReviews(ts.map((f) => {
    const r = revOf(f) || { tags: [], note: '' };
    const tags = allOn ? r.tags.filter((x) => x !== tagId) : (r.tags.includes(tagId) ? r.tags : [...r.tags, tagId]);
    return { f, tags, note: r.note || '' };
  }));
  if (ts.length > 1) toast(`${ts.length}장: ${t.label} ${allOn ? '해제' : '체크'}`);
  if (!allOn && t.needs_note && ts.some((f) => !revOf(f)?.note)) editNote(ts);
  else if (!allOn && !S.sel.size) autoAdvance();
}

function clearMarks() {
  const ts = targets().filter((f) => S.reviews.has(f.key));
  if (!ts.length) return;
  writeReviews(ts.map((f) => ({ f, tags: [], note: '' })));
  if (ts.length > 1) toast(`${ts.length}장 체크 해제`);
}

function undo() {
  const u = S.undo.pop();
  if (!u) return toast('되돌릴 것이 없습니다.');
  if (u.type === 'rev') {
    const changes = u.items.map((x) => ({ f: S.byKey.get(x.key), tags: x.prev?.tags || [], note: x.prev?.note || '' }))
      .filter((c) => c.f);
    writeReviews(changes, false);
    toast(`되돌림: 체크 ${changes.length}장`);
  } else if (u.type === 'seen') {
    const files = u.keys.map((k) => S.byKey.get(k)).filter(Boolean);
    setSeen(files, !u.value, false);
    toast(`되돌림: ${u.value ? '합격(본 것) 처리' : '안 본 것 처리'} ${files.length}장`);
  }
}

function recentNotes() {
  const cnt = new Map();
  for (const r of S.reviews.values()) if (r.note) cnt.set(r.note, (cnt.get(r.note) || 0) + 1);
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);
}

function editNote(ts = targets()) {
  if (!ts.length) return;
  const notes = [...new Set(ts.map((f) => revOf(f)?.note || ''))];
  const init = notes.length === 1 ? notes[0] : '';
  const title = ts.length === 1 ? esc(ts[0].name) : `${ts.length}장에 같은 메모`;
  const chips = recentNotes();
  openModal(`<h2>메모 — ${title}</h2>
    <textarea id="noteText" placeholder="불합격 사유나 수정 방향 (LLM이 그대로 읽습니다)${notes.length > 1 ? ' — 지금은 장마다 메모가 달라 비워 둠' : ''}">${esc(init)}</textarea>
    ${chips.length ? `<div class="notechips">${chips.map((n) => `<button data-note="${esc(n)}" title="${esc(n)}">${esc(n.slice(0, 30))}</button>`).join('')}</div>` : ''}
    <div class="foot"><span class="hint">Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소</span>
    <button id="noteCancel">취소</button><button id="noteSave" class="primary">저장</button></div>`);
  const ta = $('#noteText');
  ta.focus(); ta.select();
  const save = () => {
    const note = ta.value.trim();
    writeReviews(ts.map((f) => ({ f, tags: revOf(f)?.tags || [], note })));
    closeModal();
  };
  $('#noteSave').onclick = save;
  $('#noteCancel').onclick = closeModal;
  $$('#modal [data-note]').forEach((b) => { b.onclick = () => { ta.value = b.dataset.note; ta.focus(); }; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); }
  });
}

// ───────────────────────── 일괄 합격 · 삭제 ─────────────────────────

function bulkPassModal() {
  if (!S.root) return;
  const unseenIn = (idxs) => idxs.map((i) => S.files[i]).filter((f) => !isSeen(f));
  const all = unseenIn(S.list);
  const upto = unseenIn(S.pages.slice(0, S.page + 1).flat());
  const sel = targets().length && S.sel.size ? targets().filter((f) => !isSeen(f)) : null;
  const scope = [S.sub ? `폴더 ${S.sub}` : '전체 폴더', S.filter !== 'all' ? `필터 "${$('#selFilter').selectedOptions[0].text}"` : '',
    S.search ? `검색 "${S.search}"` : '', S.promptHits ? `프롬프트 "${S.promptQuery}"` : ''].filter(Boolean).join(' · ');
  const opt = (v, label, n, checked) => `<label><input type="radio" name="bp" value="${v}" ${checked ? 'checked' : ''} ${n ? '' : 'disabled'}><span>${label} — <b>${n}장</b></span></label>`;
  openModal(`<h2>안 본 것 일괄 합격</h2>
    <div style="color:var(--dim)">체크 없이 '본 것'으로 기록하면 합격으로 칩니다. 이미 체크한 이미지는 체크가 그대로 유지됩니다.</div>
    <div class="opts" style="margin-top:10px">
      ${sel ? opt('sel', `선택한 이미지 중 안 본 것`, sel.length, true) : ''}
      ${opt('upto', `처음부터 지금 페이지(${S.page + 1})까지 안 본 것`, upto.length, !sel)}
      ${opt('all', `지금 목록 전체에서 안 본 것 (${esc(scope)})`, all.length, false)}
    </div>
    <div class="foot"><span class="hint">Enter 실행 · Ctrl+Z로 되돌리기</span><button id="bpCancel">취소</button><button id="bpGo" class="primary">합격 처리</button></div>`);
  const go = () => {
    const v = $('#modal input[name=bp]:checked')?.value;
    const files = v === 'sel' ? sel : v === 'upto' ? upto : v === 'all' ? all : [];
    closeModal();
    if (!files?.length) return toast('처리할 이미지가 없습니다.');
    setSeen(files, true, true);
    toast(`${files.length}장 합격(본 것) 처리 — Ctrl+Z로 되돌리기`);
  };
  $('#bpGo').onclick = go;
  $('#bpCancel').onclick = closeModal;
  S.modalEnter = go;
}

function deleteTargets() {
  const ts = targets();
  if (!ts.length) return;
  const nais = ts.some((f) => absOf(f).toLowerCase().includes('\\pictures\\nais3\\'));
  const go = () => { closeModal(); doDelete(ts); };
  if (!S.set.confirmDelete) return go();
  openModal(`<h2>휴지통으로 보내기 — ${ts.length}장</h2>
    <div class="names">${ts.slice(0, 12).map((f) => esc(f.rel)).join('<br>')}${ts.length > 12 ? `<br>… 외 ${ts.length - 12}장` : ''}</div>
    ${nais ? '<div class="warn">⚠ NAIS3가 관리하는 폴더의 파일이 있습니다. 여기서 지우면 NAIS3 화면에는 깨진 항목으로 남을 수 있습니다.</div>' : ''}
    <div style="color:var(--dim);margin-top:8px">Windows 휴지통에서 복원할 수 있습니다. 삭제 전 체크·메모는 내보내기의 '삭제한 파일'에 남습니다.</div>
    <div class="foot"><label class="hint"><input type="checkbox" id="delNoAsk"> 다시 묻지 않기</label>
    <button id="delCancel">취소</button><button id="delGo" class="danger">휴지통으로 (Enter)</button></div>`);
  $('#delGo').onclick = () => { if ($('#delNoAsk').checked) { S.set.confirmDelete = false; saveSettings(); } go(); };
  $('#delCancel').onclick = closeModal;
  S.modalEnter = () => $('#delGo').click();
}

async function doDelete(ts) {
  // 지운 뒤 갈 자리: 현재 칸 다음의 살아남는 이미지
  const gone = new Set(ts.map((f) => f.key));
  const cur = curFile();
  let nextKey = null;
  if (cur) {
    const p = S.pos.get(cur.key);
    for (let q = p; q < S.list.length && !nextKey; q++) if (!gone.has(S.files[S.list[q]].key)) nextKey = S.files[S.list[q]].key;
    for (let q = p; q >= 0 && !nextKey; q--) if (!gone.has(S.files[S.list[q]].key)) nextKey = S.files[S.list[q]].key;
  }
  let res;
  try {
    res = await req('/api/delete', { root: S.root, rels: ts.map((f) => f.rel) });
  } catch (e) { return toast('삭제 실패: ' + e.message, true); }
  const del = new Set(res.deleted.map((r) => r.toLowerCase()));
  S.files = S.files.filter((f) => !del.has(f.key));
  reindex();
  for (const k of del) { S.sel.delete(k); S.reviews.delete(k); S.seen.delete(k); S.metaCache.delete(k); }
  recountDirs();
  rebuild(nextKey);
  renderTree();
  toast(`${del.size}장을 휴지통으로 보냈습니다.`);
  if (res.failed.length) toast(`${res.failed.length}장은 지우지 못했습니다(사용 중이거나 취소됨): ${res.failed.slice(0, 3).join(', ')}`, true);
}

function recountDirs() {
  for (const d of S.dirs) {
    d.direct = 0; d.count = 0;
  }
  const byRel = new Map(S.dirs.map((d) => [d.rel, d]));
  for (const f of S.files) {
    const parts = f.dir ? f.dir.split('/') : [];
    byRel.get(f.dir) && byRel.get(f.dir).direct++;
    for (let i = 0; i <= parts.length; i++) {
      const d = byRel.get(parts.slice(0, i).join('/'));
      if (d) d.count++;
    }
  }
}

// ───────────────────────── 우클릭 메뉴 ─────────────────────────

function showCtx(x, y) {
  const ts = targets();
  if (!ts.length) return;
  const ctx = $('#ctx');
  const state = (id) => {
    const n = ts.filter((f) => tagsOf(f).includes(id)).length;
    return n === 0 ? '' : n === ts.length ? 'on' : 'part';
  };
  ctx.innerHTML = (ts.length > 1 ? `<div class="head">선택 ${ts.length}장에 적용</div>` : '')
    + S.tags.map((t, n) =>
      `${n && t.kind === 'negative' && S.tags[n - 1].kind !== 'negative' ? '<hr>' : ''}<div class="it ${state(t.id)}" data-tag="${t.id}" style="color:${t.color}"><span class="box"></span><span style="color:var(--text)">${esc(t.label)}</span><kbd>${esc(t.key.toUpperCase())}</kbd></div>`).join('')
    + `<hr><div class="it" data-act="note"><span>📝 메모…</span><kbd>M</kbd></div>`
    + `<div class="it" data-act="clear"><span>체크 해제</span><kbd>0</kbd></div>`
    + `<div class="it" data-act="pass"><span>✔ 합격(본 것) 처리…</span><kbd>P</kbd></div>`
    + `<div class="it" data-act="sel"><span>${S.sel.has(curFile()?.key) ? '선택 해제' : '선택에 추가'}</span><kbd>X</kbd></div>`
    + `<hr><div class="it" data-act="copy"><span>경로 복사</span><kbd>C</kbd></div>`
    + `<div class="it" data-act="copyimg"><span>이미지 복사</span><kbd>Ctrl+C</kbd></div>`
    + `<div class="it" data-act="reveal"><span>탐색기에서 보기</span><kbd>O</kbd></div>`
    + `<div class="it" data-act="open"><span>원본 새 창</span></div>`
    + `<hr><div class="it" data-act="censor" style="color:#7ee0c3"><span>🩹 검열 덧칠 (블러·모자이크·먹칠)</span><kbd>E</kbd></div>`
    + `<hr><div class="it danger" data-act="delete"><span>🗑 휴지통으로${ts.length > 1 ? ` (${ts.length}장)` : ''}</span><kbd>Del</kbd></div>`;
  ctx.hidden = false;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(x, innerWidth - w - 4) + 'px';
  ctx.style.top = Math.min(y, innerHeight - h - 4) + 'px';
}

function hideCtx() { $('#ctx').hidden = true; }

function runAct(act) {
  const f = curFile();
  if (act === 'clear') return clearMarks();
  if (act === 'note') return editNote();
  if (act === 'delete') return deleteTargets();
  if (act === 'pass') return bulkPassModal();
  if (!f) return;
  if (act === 'censor') return openCensor(f);
  if (act === 'sel') { toggleSel(f); paintMarks(); updateStatus(); }
  if (act === 'copy') copyText(S.sel.size > 1 ? targets().map(absOf).join('\n') : absOf(f), S.sel.size > 1 ? `경로 ${S.sel.size}개 복사됨` : '경로 복사됨');
  if (act === 'copyimg') copyImage(f);
  if (act === 'reveal') req('/api/reveal', { path: absOf(f) }).catch((e) => toast(e.message, true));
  if (act === 'open') window.open(imgUrl(f, 0), '_blank');
  if (act === 'unseen') setSeen([f], false, true);
}

async function copyImage(f = curFile()) {
  if (!f) return;
  try {
    const blob = await (await fetch(imgUrl(f, 0))).blob();
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      png = await new Promise((r) => c.toBlob(r, 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('이미지 복사됨');
  } catch (e) { toast('이미지 복사 실패: ' + e.message, true); }
}

// ───────────────────────── 정보 패널 ─────────────────────────

let infoTimer = 0;
function updateInfo(now = false) {
  clearTimeout(infoTimer);
  infoTimer = setTimeout(renderInfo, now ? 0 : 90);
}

async function renderInfo() {
  const box = $('#info');
  const f = curFile();
  if (!f) { box.innerHTML = '<div style="color:var(--dim)">선택된 이미지 없음</div>'; return; }
  const r = revOf(f) || { tags: [], note: '' };
  const stale = staleOf(f);
  const setMembers = S.setIndex.get(f.set) || [];
  box.innerHTML = `
    <div class="name">${esc(f.name)}</div>
    <div class="kv" style="margin-top:6px">
      <span>경로</span><span>${esc(f.rel)}</span>
      <span>세트</span><span>${esc(f.set)} (${setMembers.length}장)</span>
      <span>상태</span><span>${isSeen(f) ? '<span class="pill" style="color:var(--pos)">본 것</span>' : '<span class="pill" style="color:var(--warn)">안 본 것</span>'}
        ${stale ? '<span class="pill" style="color:var(--dim)">파일 바뀜 · 이전 체크 무시</span>' : ''}</span>
      <span>용량</span><span>${(f.size / 1024).toFixed(0)} KB</span>
      <span>수정</span><span>${new Date(f.mtime * 1000).toLocaleString('ko-KR')}</span>
      <span>크기</span><span id="infoDim">…</span>
    </div>
    <div class="acts">
      <button data-act="copy">경로 복사</button><button data-act="copyimg">이미지 복사</button><button data-act="reveal">탐색기</button>
      <button data-act="open">원본 새 창</button>${isSeen(f) ? '<button data-act="unseen">안 본 것으로</button>' : ''}
      <button data-act="censor">🩹 검열 덧칠${S.edited.has(f.key) ? ` (${S.edited.get(f.key)}회)` : ''}</button>
      <button data-act="delete" class="danger">🗑 삭제</button>
    </div>
    ${S.sel.size ? `<div style="margin-top:8px;color:var(--sel)">선택 ${S.sel.size}장 — 아래 체크는 선택 전부에 적용됩니다.</div>` : ''}
    <h3>체크</h3>
    <div class="tagbtns">${S.tags.map((t) => `<button class="tagbtn ${r.tags.includes(t.id) ? 'on' : ''}" data-tag="${t.id}" style="color:${t.color};${r.tags.includes(t.id) ? `background:${t.color}55` : ''}" title="${esc(t.label)}"><kbd>${esc(t.key.toUpperCase())}</kbd>${esc(t.short || t.label)}</button>`).join('')}</div>
    <h3>메모</h3>
    <textarea id="infoNote" placeholder="메모 (포커스를 벗어나면 저장 · 선택이 있어도 이 칸에만)">${esc(r.note)}</textarea>
    <div id="infoMeta"><h3>NAI 메타데이터</h3><div style="color:var(--dim)">읽는 중…</div></div>`;
  const ta = $('#infoNote');
  ta.addEventListener('change', () => writeReviews([{ f, tags: revOf(f)?.tags || [], note: ta.value.trim() }]));

  const key = f.key + '|' + f.mtime;
  let meta = S.metaCache.get(key);
  if (!meta) {
    try { meta = await req('/api/meta?p=' + enc(absOf(f))); } catch (e) { meta = { error: e.message }; }
    S.metaCache.set(key, meta);
    if (S.metaCache.size > 400) S.metaCache.delete(S.metaCache.keys().next().value);
  }
  if (curFile() !== f || !$('#infoMeta')) return;
  if (meta.error) { $('#infoMeta').innerHTML = `<h3>메타데이터</h3><div style="color:var(--neg)">${esc(meta.error)}</div>`; return; }
  $('#infoDim').textContent = `${meta.file.width}×${meta.file.height} · ${meta.file.format} · ${meta.file.mode}`;
  const n = meta.nai;
  const block = (title, text) => text ? `<h3>${title}</h3><div class="copyable"><pre>${esc(text)}</pre><button data-copy="${esc(text)}">복사</button></div>` : '';
  const SRC = { 'png-text': 'PNG 텍스트', exif: 'EXIF', stealth: 'PNG 알파(stealth)', parameters: 'parameters' };
  let html = '';
  if (n) {
    html += `<h3>생성 정보 <span class="pill">${SRC[meta.meta_source] || ''}</span></h3><div class="kv">
      ${[['seed', n.seed], ['steps', n.steps], ['scale', n.scale], ['rescale', n.cfg_rescale], ['sampler', n.sampler],
         ['schedule', n.noise_schedule], ['해상도', n.size], ['모델', n.source || n.software], ['생성 시간', n.generation_time]]
        .filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `<span>${k}</span><span>${esc(v)}</span>`).join('')}
      </div>
      <div class="acts">${n.seed != null ? `<button data-copy="${esc(n.seed)}">seed 복사</button>` : ''}</div>`;
    html += block('프롬프트', n.prompt);
    (n.char_captions || []).forEach((c, i) => { html += block(`캐릭터 ${i + 1}`, c); });
    html += block('네거티브 (UC)', n.uc);
    (n.char_uc || []).forEach((c, i) => { if (c) html += block(`캐릭터 ${i + 1} 네거티브`, c); });
  } else {
    html += '<h3>NAI 메타데이터</h3><div style="color:var(--dim)">생성 정보 없음 (텍스트 청크·EXIF·알파 stealth 모두 비어 있음)</div>';
  }
  const raw = { ...meta.text, ...meta.exif };
  if (Object.keys(raw).length) {
    html += `<details><summary>EXIF · 텍스트 청크 전체 (${Object.keys(raw).length})</summary><div class="kv" style="margin-top:6px">${
      Object.entries(raw).map(([k, v]) => `<span>${esc(k)}</span><span style="max-height:120px;overflow:auto">${esc(String(v).slice(0, 3000))}</span>`).join('')}</div></details>`;
  }
  $('#infoMeta').innerHTML = html;
}

// ───────────────────────── 폴더 트리 ─────────────────────────

let treeTimer = 0;
function scheduleTree() { clearTimeout(treeTimer); treeTimer = setTimeout(renderTree, 400); }

function renderTree() {
  const regen = new Map(), unseen = new Map();
  for (const f of S.files) {
    const r = isRegen(f), u = !isSeen(f);
    if (!r && !u) continue;
    const parts = f.dir ? f.dir.split('/') : [];
    for (let i = 0; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (r) regen.set(d, (regen.get(d) || 0) + 1);
      if (u) unseen.set(d, (unseen.get(d) || 0) + 1);
    }
  }
  const scroll = $('#tree').scrollTop;
  $('#tree').innerHTML = `<div class="opt"><label><input type="checkbox" id="chkSub" ${S.includeSub ? 'checked' : ''}> 하위 폴더 포함</label></div>`
    + S.dirs.map((d) => {
      const uv = unseen.get(d.rel) || 0, rj = regen.get(d.rel) || 0;
      return `<div class="row ${d.rel === S.sub ? 'active' : ''}" data-rel="${esc(d.rel)}" style="padding-left:${8 + d.depth * 14}px" title="${esc(d.rel || S.root)}&#10;이미지 ${d.count}장 · 안 본 것 ${uv} · 불합격 ${rj}">
      <span class="nm">${d.rel ? '📁 ' + esc(d.name) : '🏠 ' + esc(d.name)}</span>
      ${uv ? `<span class="uv">●${uv}</span>` : (d.count ? '<span class="done">✔</span>' : '')}
      ${rj ? `<span class="rj">✕${rj}</span>` : ''}
      <span class="ct">${d.count}</span></div>`;
    }).join('');
  $('#tree').scrollTop = scroll;
  $('#chkSub').onchange = (e) => { S.includeSub = e.target.checked; rebuild(curFile()?.key); };
}

// ───────────────────────── 모달 ─────────────────────────

function openModal(html) { S.modalEnter = null; $('#modal .box').innerHTML = html; $('#modal').hidden = false; hideCtx(); showPeek(false); }
function closeModal() { $('#modal').hidden = true; $('#modal .box').innerHTML = ''; S.modalEnter = null; }
const modalOpen = () => !$('#modal').hidden;

async function showRootModal() {
  let recent = [];
  try { recent = (await req('/api/recent')).recent; } catch { /* 최근 목록 없음 */ }
  openModal(`<h2>검수할 폴더 열기</h2>
    <div class="row"><input id="rootIn" placeholder="폴더 경로 붙여넣기 (예: C:\\Users\\...\\이미지)" value="${esc(S.root)}"><button id="rootPick">찾아보기…</button><button id="rootGo" class="primary">열기</button></div>
    ${recent.length ? `<h3>최근 폴더</h3><div class="recent">${recent.map((p) => `<div data-p="${esc(p)}">${esc(p)}</div>`).join('')}</div>` : ''}
    <div class="foot"><button id="rootClose">닫기</button></div>`);
  const inp = $('#rootIn');
  inp.focus(); inp.select();
  const go = async (p) => {
    p = p.trim().replace(/^"|"$/g, '');
    if (!p) return;
    try { closeModal(); await openRoot(p); } catch (e) { toast(e.message, true); showRootModal(); }
  };
  $('#rootGo').onclick = () => go(inp.value);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(inp.value); });
  $('#rootPick').onclick = async () => {
    const { path } = await req('/api/pickdir', { initial: inp.value || S.root });
    if (path) go(path);
  };
  $('#rootClose').onclick = closeModal;
  $$('#modal .recent div').forEach((d) => { d.onclick = () => go(d.dataset.p); });
}

function jumpPageModal() {
  if (!S.pages.length) return;
  openModal(`<h2>페이지 이동</h2>
    <div class="row"><input id="pgIn" type="number" min="1" max="${S.pages.length}" value="${S.page + 1}"><span style="color:var(--dim)">/ ${S.pages.length}</span><button id="pgGo" class="primary">이동</button></div>`);
  const inp = $('#pgIn');
  inp.focus(); inp.select();
  const go = () => { const n = parseInt(inp.value, 10); closeModal(); if (n) goPage(n - 1); };
  $('#pgGo').onclick = go;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}

async function doExport() {
  if (!S.root) return;
  const folder = S.sub ? S.root + '\\' + S.sub.replaceAll('/', '\\') : S.root;
  toast('내보내는 중…');
  try {
    const res = await req('/api/export', { folder, list: S.listPath });
    const s = res.summary;
    openModal(`<h2>검수 결과 내보냄</h2>
      <div>범위: ${esc(folder)}</div>
      <div style="margin:6px 0">전체 ${s.total} · 본 것 ${s.seen} · <b style="color:var(--neg)">불합격 ${s.reject}</b> · 세트 탈락 ${s.set_reject} · ★ ${s.keeper} · +추가 ${s.more} · 삭제 ${s.deleted} · 안 본 것 ${s.unseen_unmarked}</div>
      ${s.unseen_unmarked ? `<div class="warn">안 본 이미지 ${s.unseen_unmarked}장은 판정 없음으로 나갔습니다. 합격으로 넘기려면 ✔ 일괄 합격을 쓰세요.</div>` : ''}
      <div class="kv"><span>MD</span><span>${esc(res.paths.md)}</span><span>JSON</span><span>${esc(res.paths.json)}</span></div>
      <h3>미리보기</h3><pre>${esc(res.md)}</pre>
      <div class="foot"><button id="exCopyMd">MD 내용 복사</button><button id="exCopyRegen">불합격 파일명 복사 (${res.regen.length})</button><button id="exCopyPath">JSON 경로 복사</button><button id="exReveal">폴더 열기</button><button id="exClose" class="primary">닫기</button></div>`);
    $('#exCopyMd').onclick = () => copyText(res.md, 'MD 복사됨');
    $('#exCopyRegen').onclick = () => copyText(res.regen.join('\n'), `불합격 ${res.regen.length}개 복사됨`);
    $('#exCopyPath').onclick = () => copyText(res.paths.json, '경로 복사됨');
    $('#exReveal').onclick = () => req('/api/reveal', { path: res.paths.json });
    $('#exClose').onclick = closeModal;
  } catch (e) { toast('내보내기 실패: ' + e.message, true); }
}

function settingsModal() {
  const s = S.set;
  const sel = (id, opts) => `<select id="${id}">${opts.map(([v, l]) => `<option value="${v}" ${String(s[id]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const chk = (id, label) => `<label><input type="checkbox" id="${id}" ${s[id] ? 'checked' : ''}> ${label}</label>`;
  openModal(`<h2>설정</h2>
    <div class="set-grid">
      <span>Language</span><select id="setLang">${[['ko', '한국어'], ['en', 'English'], ['ja', '日本語']].map(([v, l]) => `<option value="${v}" ${S.cfg.lang === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <span>체크 후 자동으로 다음 칸</span>${sel('autoAdvance', [['off', '안 함'], ['single', '1장 보기에서만'], ['always', '항상']])}
      <span>칸 배경 (K)</span>${sel('bg', [['dark', '검정'], ['gray', '회색'], ['white', '흰색'], ['checker', '체크무늬 (투명 확인)']])}
      <span>'본 것' 기록까지</span>${sel('seenDelay', [[200, '0.2초'], [450, '0.45초'], [1000, '1초'], [2000, '2초']])}
      <span>썸네일 화질</span>${sel('thumbHigh', [['false', '보통 (빠름)'], ['true', '높게 (선명)']])}
      <span></span>${chk('wheelPaging', '그리드에서 휠로 페이지 넘기기')}
      <span></span>${chk('seenDot', '안 본 이미지에 주황 점 표시')}
      <span></span>${chk('clickClears', '그냥 클릭하면 선택 해제')}
      <span></span>${chk('confirmDelete', '삭제 전에 확인')}
    </div>
    <div class="foot"><button id="setReset">기본값</button><button id="setClose" class="primary">닫기</button></div>`);
  for (const id of Object.keys(SETTINGS_DEFAULT)) {
    const el = $('#' + id);
    if (!el) continue;
    el.onchange = () => {
      s[id] = el.type === 'checkbox' ? el.checked : (id === 'seenDelay' ? +el.value : id === 'thumbHigh' ? el.value === 'true' : el.value);
      saveSettings(); applySettings();
      if (id === 'thumbHigh') render();
    };
  }
  $('#setLang').onchange = (e) => req('/api/lang', { lang: e.target.value }).then(() => location.reload());
  $('#setReset').onclick = () => { S.set = { ...SETTINGS_DEFAULT }; saveSettings(); applySettings(); settingsModal(); };
  $('#setClose').onclick = closeModal;
}

function showHelp() {
  const rows = [
    ['← / →', '이전 / 다음 페이지 (1장 보기에서는 이전 / 다음 장)'], ['Shift + ← / →', '10페이지씩'],
    ['↑ / ↓', '페이지 안에서 이전 / 다음 칸 (마우스를 올려도 선택됨)'],
    ['PgUp / PgDn · 휠', '이전 / 다음 페이지'], ['Home / End · G', '처음 / 마지막 · 페이지 번호로 이동'],
    ['U', '다음 "안 본" 페이지로'],
    ...S.tags.map((t) => [t.key.toUpperCase(), `${t.label}${t.kind === 'negative' ? ' (불합격)' : ''}`]),
    ['0 · Backspace', '체크 해제'], ['M', '메모 (최근 메모 버튼으로 재사용)'], ['Ctrl+Z', '되돌리기 (체크·일괄 합격)'],
    ['Ctrl+클릭 · X', '선택 추가/해제'], ['Shift+클릭 · Shift+↑↓', '범위 선택'], ['누른 채 칸 훑기', '여러 칸 선택'],
    ['Ctrl+A / Ctrl+Shift+A', '이 페이지 / 목록 전체 선택'], ['Esc', '선택 해제 → 1장 보기 닫기'],
    ['P', '안 본 것 일괄 합격 (선택·지금까지·목록 전체)'], ['Del', '휴지통으로 (선택 전부 또는 현재 칸)'],
    ['E', '검열 덧칠: 블러(1)·모자이크(2)·먹칠(3), 브러시(B)·사각형(R)·부드럽게(F), [ ] 굵기, Shift+휠 세기, Space 원본 비교, Enter 저장 · Shift+Enter 저장 후 다음 \'검열 약함\' 컷 — 원본은 보관되고 복원 가능'],
    ['Space (누르고 있기)', '원본 크게 보기'], ['Enter · 더블클릭', '1장 보기 ↔ 원래 보기'],
    ['휠 · 드래그 (1장 보기)', '확대 · 이동, 더블클릭 = 원래 보기'],
    ['V', '세트별 보기 ↔ 그리드'], ['+ / −', '한 화면 장수'], ['K', '칸 배경 (검정·회색·흰색·체크무늬)'],
    ['F · I · B', '파일명 · 정보 패널 · 폴더 트리'], ['C · Ctrl+C · O', '경로 복사 · 이미지 복사 · 탐색기'],
    ['/', '검색 (p:open mouth, -smile 처럼 쓰면 프롬프트 검색)'], ['F5', '폴더 다시 읽기'],
    ['Ctrl+O · Ctrl+E', '폴더 열기 · 내보내기'], ['우클릭', '체크 메뉴'],
  ];
  openModal(`<h2>단축키</h2><table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
    <p style="color:var(--dim)">체크 없는 이미지는 본 것만 합격으로 칩니다(주황 점 = 아직 안 봄). ★대표를 고른 세트의 나머지는 세트 탈락으로 흐리게 표시됩니다.
    체크한 뒤 파일이 바뀌면(재생성 덮어쓰기) 이전 체크는 '파일 바뀜'으로 무시되고 다시 안 본 것이 됩니다.</p>
    <p style="color:var(--dim)">NAI 검수 뷰어 · 만든 사람 불프하르트 · 자세한 사용법은 설치 폴더의 Guide.html · v${S.cfg.version}</p>
    <div class="foot"><button id="helpClose" class="primary">닫기</button></div>`);
  $('#helpClose').onclick = closeModal;
}

// ───────────────────────── 프롬프트 검색 ─────────────────────────

async function runSearch(value) {
  const v = value.trim();
  if (/^p:/i.test(v)) {
    const q = v.slice(2).trim();
    S.search = '';
    if (!q) { S.promptHits = null; S.promptQuery = ''; return rebuild(curFile()?.key); }
    toast('프롬프트 읽는 중… (처음 한 번은 몇 초 걸립니다)');
    try {
      const res = await req('/api/search', { root: S.root, q });
      S.promptHits = new Set(res.rels.map((r) => r.toLowerCase()));
      S.promptQuery = q;
      toast(`프롬프트 일치 ${res.rels.length}장 (메타데이터 있는 ${res.with_prompt}/${res.scanned}장 중)`);
    } catch (e) { return toast('검색 실패: ' + e.message, true); }
  } else {
    S.promptHits = null; S.promptQuery = '';
    S.search = v;
  }
  rebuild(curFile()?.key);
}

// ───────────────────────── 1장 보기 확대 · 원본 미리보기 ─────────────────────────

let drag = null;
function applyZoom(cell) {
  cell.querySelector('img').style.transform = `translate(${S.zoom.x}px, ${S.zoom.y}px) scale(${S.zoom.s})`;
  const lv = cell.querySelector('.zoomlv');
  lv.hidden = S.zoom.s === 1;
  lv.textContent = `×${S.zoom.s.toFixed(1)}`;
}

function onWheel(e) {
  if (modalOpen()) return;
  e.preventDefault();
  const cell = e.target.closest('.cell.single');
  if (cell) {
    const rect = cell.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const z = S.zoom;
    const ns = Math.max(1, Math.min(12, z.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    z.x = ns === 1 ? 0 : px - (px - z.x) * (ns / z.s);
    z.y = ns === 1 ? 0 : py - (py - z.y) * (ns / z.s);
    z.s = ns;
    applyZoom(cell);
    return;
  }
  if (!S.set.wheelPaging) return;
  const t = performance.now();
  if (t - (onWheel.last || 0) < 160) return;
  onWheel.last = t;
  goPage(S.page + (e.deltaY > 0 ? 1 : -1));
}

function bindZoomDrag() {
  $('#stage').addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.cell.single');
    if (!cell || e.button !== 0 || S.zoom.s === 1) return;
    drag = { x: e.clientX - S.zoom.x, y: e.clientY - S.zoom.y, cell };
    cell.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    S.zoom.x = e.clientX - drag.x; S.zoom.y = e.clientY - drag.y;
    applyZoom(drag.cell);
  });
  window.addEventListener('mouseup', (e) => {
    if (drag) { drag.cell.classList.remove('dragging'); drag = null; }
    onMouseUp(e);
  });
}

function showPeek(on) {
  const f = curFile();
  const p = $('#peek');
  if (on && f) {
    p.querySelector('img').src = imgUrl(f, 0);
    p.querySelector('.cap').textContent = f.rel;
    p.hidden = false;
  } else p.hidden = true;
}

// ───────────────────────── 검열 덧칠 편집기 ─────────────────────────
// 검열만 약한 컷을 재생성·인페인트 없이 고친다(E). 미리보기는 브라우저 캔버스로, 저장은 서버(review_viewer.py apply_censor)가
// 같은 계산(블러 = 가우스 표준편차, 모자이크 = 칸 평균, 먹칠 = 검정)으로 원본 해상도에 입힌다.
// 같은 도구·세기로 이어 칠한 획은 한 묶음으로 한 번에 계산한다 — 겹쳐 칠해도 두 번 흐려지지 않는다(서버와 같은 규칙).

const CE_EXT = ['png', 'webp', 'jpg', 'jpeg', 'jfif'];
const CE_RANGE = { blur: [2, 80, 2], mosaic: [4, 80, 2] };   // 세기 최소·최대·단계(원본 px)
const CE_DEFAULT = { mode: 'blur', shape: 'brush', size: 70, str: { blur: 18, mosaic: 16 }, soft: false };
const CE = { open: false, busy: false, f: null, w: 0, h: 0, orig: null, view: null, base: null, eff: null, tmp: null, soft2: null,
  ops: [], gstart: 0, cur: null, pan: null, zoom: { s: 1, x: 0, y: 0 }, escAt: 0, info: null, comparing: false, ...CE_DEFAULT };

function ceLoadPrefs() {
  try { Object.assign(CE, JSON.parse(lsGet('rv:censor') || '{}')); } catch { /* 기본값 */ }
  CE.str = { ...CE_DEFAULT.str, ...CE.str };
}
function ceSavePrefs() { lsSet('rv:censor', JSON.stringify({ mode: CE.mode, shape: CE.shape, size: CE.size, str: CE.str, soft: CE.soft })); }
/** 가장자리 부드럽게(F): 칠한 모양의 테두리를 이만큼(가우스 px) 흐린다 — 긴 변의 1/120(1216px → 10). */
const ceFeather = () => (CE.soft ? Math.max(4, Math.round(Math.max(CE.w, CE.h) / 120)) : 0);

function ceCanvas(alpha = false) {
  const c = document.createElement('canvas');
  c.width = CE.w; c.height = CE.h;
  c.ctx = c.getContext('2d', { alpha, willReadFrequently: !alpha });
  return c;
}
function ceCopy(src) { const c = ceCanvas(); c.ctx.drawImage(src, 0, 0); return c; }
const ceKeyOf = (op) => `${op.mode}:${op.strength}:${op.feather || 0}`;

/** 칠한 영역에 들어갈 그림(전체 크기). 서버 _censor_effect와 같은 계산. */
function ceEffect(src, mode, s) {
  const c = ceCanvas(), x = c.ctx;
  if (mode === 'fill') { x.fillStyle = '#000'; x.fillRect(0, 0, CE.w, CE.h); return c; }
  if (mode === 'blur') {
    x.drawImage(src, 0, 0);   // 가장자리가 비어 어두워지지 않게 원본을 먼저 깐다
    x.filter = `blur(${s}px)`; x.drawImage(src, 0, 0); x.filter = 'none';
    return c;
  }
  const W = CE.w, H = CE.h, d = src.ctx.getImageData(0, 0, W, H), p = d.data;
  for (let by = 0; by < H; by += s) {
    const bh = Math.min(s, H - by);
    for (let bx = 0; bx < W; bx += s) {
      const bw = Math.min(s, W - bx);
      let r = 0, g = 0, b = 0;
      for (let y = by; y < by + bh; y++) for (let i = (y * W + bx) * 4, e = i + bw * 4; i < e; i += 4) { r += p[i]; g += p[i + 1]; b += p[i + 2]; }
      const n = bw * bh;
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      for (let y = by; y < by + bh; y++) for (let i = (y * W + bx) * 4, e = i + bw * 4; i < e; i += 4) { p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = 255; }
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}

function ceMask(x, ops) {
  x.fillStyle = x.strokeStyle = '#fff';
  x.lineCap = x.lineJoin = 'round';
  for (const op of ops) {
    const pts = op.points;
    if (op.shape === 'rect') {   // 정수 픽셀 [x0, x1) — 서버 _censor_mask와 같은 범위
      const [[x0, y0], [x1, y1]] = [pts[0], pts[pts.length - 1]].map(([px, py]) => [Math.round(px), Math.round(py)]);
      x.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || 1, Math.abs(y1 - y0) || 1);
      continue;
    }
    x.beginPath();
    x.arc(pts[0][0], pts[0][1], op.size / 2, 0, Math.PI * 2);
    x.fill();
    if (pts.length > 1) {
      x.lineWidth = op.size;
      x.beginPath();
      x.moveTo(pts[0][0], pts[0][1]);
      for (const [px, py] of pts.slice(1)) x.lineTo(px, py);
      x.stroke();
    }
  }
}

/** 화면 = 묶음 시작 전 그림 + (묶음 효과를 묶음 획 모양으로 오린 것). 부드럽게면 모양을 흐려서 오린다(서버 _censor_mask와 같음). */
function ceCompose(from = CE.gstart, to = CE.ops.length) {
  const v = CE.view.ctx, t = CE.tmp.ctx, ops = CE.ops.slice(from, to), feather = ops[0]?.feather || 0;
  v.drawImage(CE.base, 0, 0);
  t.globalCompositeOperation = 'source-over';
  t.clearRect(0, 0, CE.w, CE.h);
  if (feather) {
    const s = CE.soft2 ||= ceCanvas(true);
    s.ctx.clearRect(0, 0, CE.w, CE.h);
    ceMask(s.ctx, ops);
    t.filter = `blur(${feather}px)`; t.drawImage(s, 0, 0); t.filter = 'none';
  } else ceMask(t, ops);
  t.globalCompositeOperation = 'source-in';
  t.drawImage(CE.eff, 0, 0);
  t.globalCompositeOperation = 'source-over';
  v.drawImage(CE.tmp, 0, 0);
}

/** 처음부터 다시 그린다(되돌리기 뒤). */
function ceRebuild() {
  CE.view.ctx.drawImage(CE.orig, 0, 0);
  CE.base = CE.eff = null;
  for (let i = 0; i < CE.ops.length;) {
    let j = i + 1;
    while (j < CE.ops.length && ceKeyOf(CE.ops[j]) === ceKeyOf(CE.ops[i])) j++;
    CE.base = ceCopy(CE.view);
    CE.eff = ceEffect(CE.base, CE.ops[i].mode, CE.ops[i].strength);
    CE.gstart = i;
    ceCompose(i, j);
    i = j;
  }
  ceSyncBar();
}

function ceBegin(op) {
  const last = CE.ops[CE.ops.length - 1];
  if (!last || ceKeyOf(last) !== ceKeyOf(op)) {   // 새 묶음: 지금 화면을 바탕으로 효과를 한 번 계산
    CE.base = ceCopy(CE.view);
    CE.eff = ceEffect(CE.base, op.mode, op.strength);
    CE.gstart = CE.ops.length;
  }
  CE.ops.push(op);
  CE.cur = op;
  ceCompose();
}

function ceUndo() {
  if (CE.cur || !CE.ops.length) return;
  CE.ops.pop();
  ceRebuild();
}

function ceFit() {
  const st = $('#ceStage').getBoundingClientRect();
  const s = Math.min(st.width / CE.w, st.height / CE.h) * 0.98;
  CE.zoom = { s, x: (st.width - CE.w * s) / 2, y: (st.height - CE.h * s) / 2 };
  ceApplyZoom();
}
function ceApplyZoom() {
  CE.view.style.transform = CE.orig.style.transform = `translate(${CE.zoom.x}px, ${CE.zoom.y}px) scale(${CE.zoom.s})`;
  ceCursor();
}

/** Space를 누르고 있는 동안 원본(덧칠 전)을 보여 준다. */
function ceCompare(on) {
  if (!CE.open || CE.comparing === on || (on && CE.cur)) return;
  CE.comparing = on;
  CE.orig.hidden = !on;
  CE.view.hidden = on;
  $('#ceCmp').hidden = !on;
}
function ceXY(e) {
  const r = $('#ceStage').getBoundingClientRect();
  return [(e.clientX - r.left - CE.zoom.x) / CE.zoom.s, (e.clientY - r.top - CE.zoom.y) / CE.zoom.s].map((v) => Math.round(v * 10) / 10);
}
function ceCursor(e = CE.lastMouse) {
  const c = $('#ceCursor');
  if (!c) return;
  if (e) CE.lastMouse = e;
  c.hidden = !e || CE.shape !== 'brush' || !!CE.pan;
  if (c.hidden) return;
  const r = $('#ceStage').getBoundingClientRect();
  const d = CE.size * CE.zoom.s;
  Object.assign(c.style, { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px`, width: `${d}px`, height: `${d}px` });
}

function ceSet(what, v) {
  if (what === 'mode' || what === 'shape' || what === 'soft') CE[what] = v;
  if (what === 'size') CE.size = Math.max(6, Math.min(400, Math.round(v)));
  if (what === 'str' && CE.mode !== 'fill') {
    const [lo, hi] = CE_RANGE[CE.mode];
    CE.str[CE.mode] = Math.max(lo, Math.min(hi, Math.round(v)));
  }
  ceSavePrefs();
  ceSyncBar();
  ceCursor();
}

function ceSyncBar() {
  for (const b of $$('#cedit [data-ce]')) {
    const [k, v] = b.dataset.ce.split(':');
    if (v) b.classList.toggle('on', CE[k] === v);
  }
  $('#ceSize').value = CE.size; $('#ceSizeV').textContent = `${CE.size}px`;
  const fill = CE.mode === 'fill';
  $('#ceStrBox').classList.toggle('off', fill);
  if (!fill) {
    const [lo, hi, step] = CE_RANGE[CE.mode];
    Object.assign($('#ceStr'), { min: lo, max: hi, step });
    $('#ceStr').value = CE.str[CE.mode];
    $('#ceStrV').textContent = `${CE.str[CE.mode]}px`;
  } else $('#ceStrV').textContent = '—';
  $('#cedit [data-ce=soft]').classList.toggle('on', CE.soft);
  $('#ceSizeBox').classList.toggle('off', CE.shape === 'rect');
  $('#ceStage').classList.toggle('rect', CE.shape === 'rect');
  $('#ceCount').textContent = CE.ops.length ? `획 ${CE.ops.length}` : '아직 칠하지 않음';
}

async function openCensor(f = curFile()) {
  if (!f || CE.open || CE.busy) return;
  if (!CE_EXT.includes(f.ext)) return toast('검열 덧칠은 png · webp · jpg만 됩니다.', true);
  CE.busy = true;
  try {
    // img.decode()는 창이 가려져 있으면 끝나지 않을 수 있다 → 그리기와 무관하게 디코드하는 createImageBitmap
    const [info, img] = await Promise.all([req('/api/censor-info?p=' + enc(absOf(f))),
      fetch(imgUrl(f, 0)).then((r) => { if (!r.ok) throw new Error(`이미지 ${r.status}`); return r.blob(); }).then(createImageBitmap)]);
    ceLoadPrefs();
    Object.assign(CE, { open: true, f, info, w: img.width, h: img.height, ops: [], cur: null, pan: null, escAt: 0, lastMouse: null,
      comparing: false, soft2: null });
    hideCtx(); showPeek(false);
    const box = $('#cedit');
    box.innerHTML = `<div class="ce-bar">
        <b class="ce-name" title="${esc(f.rel)}">🩹 ${esc(f.name)}</b>
        <span class="ce-grp"><button data-ce="mode:blur"><kbd>1</kbd> 블러</button><button data-ce="mode:mosaic"><kbd>2</kbd> 모자이크</button><button data-ce="mode:fill"><kbd>3</kbd> 먹칠</button></span>
        <span class="ce-grp"><button data-ce="shape:brush"><kbd>B</kbd> 브러시</button><button data-ce="shape:rect"><kbd>R</kbd> 사각형</button>
          <button data-ce="soft" title="칠한 모양의 테두리를 부드럽게 흐린다(새로 칠하는 획부터)"><kbd>F</kbd> 부드럽게</button></span>
        <label class="ce-rng" id="ceSizeBox" title="[ ] 키">굵기 <input type="range" id="ceSize" min="6" max="400"><span id="ceSizeV"></span></label>
        <label class="ce-rng" id="ceStrBox" title="Shift+휠">세기 <input type="range" id="ceStr"><span id="ceStrV"></span></label>
        <span class="grow"></span>
        <span id="ceCount" class="ce-dim"></span>
        <button data-ce="undo" title="Ctrl+Z">↶ 되돌리기</button>
        ${info.backup ? '<button data-ce="restore" class="danger" title="처음 덧칠하기 전 원본으로 되돌립니다">원본 복원</button>' : ''}
        <button data-ce="cancel">취소 <kbd>Esc</kbd></button>
        <button data-ce="savenext" title="저장하고 목록에서 다음 '검열 약함' 체크 컷을 연다">저장 후 다음 <kbd>Shift+Enter</kbd></button>
        <button data-ce="save" class="primary">저장 <kbd>Enter</kbd></button>
      </div>
      <div class="ce-stage" id="ceStage"><div class="ce-cursor" id="ceCursor" hidden></div><div class="ce-cmp" id="ceCmp" hidden>원본 (덧칠 전)</div></div>
      <div class="ce-hint">드래그 = 칠하기 · 휠 = 확대 · 우클릭/가운데 드래그 = 이동 · <kbd>[</kbd> <kbd>]</kbd> 굵기 · Shift+휠 세기 · <kbd>0</kbd> 화면 맞춤 · Ctrl+Z 되돌리기 · Space 누르고 있기 = 원본 비교
        · 저장하면 원본은 뷰어 data\\${S.cfg.censor_dir}에 한 번 보관되고, 이 컷의 '검열 약함' 체크가 풀립니다${info.edits ? ` · 이미 ${info.edits}번 덧칠한 컷` : ''}</div>`;
    CE.orig = ceCanvas(); CE.orig.ctx.drawImage(img, 0, 0); img.close();
    CE.view = ceCopy(CE.orig);
    CE.tmp = ceCanvas(true);
    CE.base = CE.eff = null;
    CE.orig.hidden = true;
    $('#ceStage').prepend(CE.view, CE.orig);
    box.hidden = false;
    ceBind();
    ceSyncBar();
    ceFit();
  } catch (e) {
    toast('편집기를 열지 못했습니다: ' + e.message, true);
  } finally { CE.busy = false; }
}

function ceBind() {
  const st = $('#ceStage');
  $('#cedit .ce-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ce]');
    if (!b) return;
    const [k, v] = b.dataset.ce.split(':');
    if (v) return ceSet(k, v);
    ({ undo: ceUndo, save: () => ceSave(), savenext: () => ceSave(true), cancel: () => closeCensor(false), restore: ceRestoreAsk,
      soft: () => ceSet('soft', !CE.soft) })[k]?.();
    b.blur();
  });
  $('#ceSize').oninput = (e) => ceSet('size', +e.target.value);
  $('#ceStr').oninput = (e) => ceSet('str', +e.target.value);
  for (const r of ['#ceSize', '#ceStr']) $(r).addEventListener('change', (e) => e.target.blur());
  st.addEventListener('contextmenu', (e) => e.preventDefault());
  st.addEventListener('pointerdown', (e) => {
    if (CE.busy) return;
    st.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2) {
      CE.pan = { x: e.clientX - CE.zoom.x, y: e.clientY - CE.zoom.y };
      st.classList.add('panning'); ceCursor();
      return;
    }
    if (e.button !== 0 || CE.comparing) return;
    const p = ceXY(e);
    ceBegin({ mode: CE.mode, shape: CE.shape, size: CE.size, strength: CE.mode === 'fill' ? 0 : CE.str[CE.mode],
      feather: ceFeather(), points: CE.shape === 'rect' ? [p, p] : [p] });
  });
  st.addEventListener('pointermove', (e) => {
    ceCursor(e);
    if (CE.pan) {
      CE.zoom.x = e.clientX - CE.pan.x; CE.zoom.y = e.clientY - CE.pan.y;
      return ceApplyZoom();
    }
    const op = CE.cur;
    if (!op) return;
    const p = ceXY(e);
    if (op.shape === 'rect') op.points[1] = p;
    else {
      const [lx, ly] = op.points[op.points.length - 1];
      if (Math.hypot(p[0] - lx, p[1] - ly) < Math.max(1.5, op.size * 0.06)) return;
      op.points.push(p);
    }
    ceCompose();
  });
  const end = () => {
    if (CE.pan) { CE.pan = null; st.classList.remove('panning'); ceCursor(); return; }
    const op = CE.cur;
    if (!op) return;
    CE.cur = null;
    const [[x0, y0], [x1, y1]] = [op.points[0], op.points[op.points.length - 1]];
    if (op.shape === 'rect' && (Math.abs(x1 - x0) < 2 || Math.abs(y1 - y0) < 2)) { CE.ops.pop(); ceRebuild(); return; }   // 그냥 클릭
    ceSyncBar();
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('pointerleave', () => { if (!CE.cur && !CE.pan) $('#ceCursor').hidden = true; });
  st.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.shiftKey) {
      if (CE.mode !== 'fill') ceSet('str', CE.str[CE.mode] + (e.deltaY < 0 ? 1 : -1) * CE_RANGE[CE.mode][2]);
      return;
    }
    const r = st.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, z = CE.zoom;
    const ns = Math.max(0.05, Math.min(16, z.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    z.x = px - (px - z.x) * (ns / z.s); z.y = py - (py - z.y) * (ns / z.s); z.s = ns;
    ceApplyZoom();
  }, { passive: false });
}

function closeCensor(force) {
  if (!CE.open || CE.busy) return;
  if (!force && CE.ops.length && performance.now() - CE.escAt > 1500) {
    CE.escAt = performance.now();
    return toast('저장하지 않은 덧칠이 있습니다 — 한 번 더 누르면 버립니다.');
  }
  Object.assign(CE, { open: false, f: null, orig: null, view: null, base: null, eff: null, tmp: null, ops: [], cur: null, pan: null });
  const box = $('#cedit');
  box.hidden = true; box.innerHTML = '';
}

/** 저장·복원 뒤 화면 상태를 서버 결과에 맞춘다(새 수정 시각 = 썸네일·원본 다시 받음, '본 것' 기록). */
function ceApplyResult(f, res, edits) {
  const prev = S.reviews.get(f.key);
  const wasValid = prev && sameTime(prev.mtime, f.mtime);
  f.mtime = res.mtime; f.size = res.size;
  if (res.tags.length || res.note) S.reviews.set(f.key, { tags: res.tags, note: res.note, mtime: res.mtime });
  else if (wasValid) S.reviews.delete(f.key);
  S.seen.set(f.key, res.mtime);
  if (edits) S.edited.set(f.key, edits); else S.edited.delete(f.key);
  for (const k of [...S.metaCache.keys()]) if (k.startsWith(f.key + '|')) S.metaCache.delete(k);
  render(); scheduleTree();
}

const CENSOR_TAG = 'censor';   // config.json의 '검열 약함' 체크 id — 덧칠을 저장하면 풀린다(서버 censor_save와 같음)

/** 지금 목록에서 f 다음에 오는 '검열 약함' 컷(없으면 처음부터 다시 찾는다). */
function ceNextFlagged(f) {
  const at = S.pos.get(f.key) ?? -1;
  const order = [...S.list.slice(at + 1), ...S.list.slice(0, Math.max(0, at))];
  const i = order.find((idx) => S.files[idx] !== f && tagsOf(S.files[idx]).includes(CENSOR_TAG));
  return i === undefined ? null : S.files[i];
}

/** next = true면 저장 뒤 다음 '검열 약함' 컷을 바로 연다(Shift+Enter). */
async function ceSave(next = false) {
  if (CE.busy || !CE.open) return;
  if (!CE.ops.length) return toast('칠한 곳이 없습니다.');
  const f = CE.f;
  let nf = null;
  CE.busy = true; $('#cedit').classList.add('busy');
  try {
    const ops = CE.ops.map(({ mode, shape, size, strength, feather, points }) => ({ mode, shape, size, strength, feather, points }));
    const res = await req('/api/censor', { root: S.root, rel: f.rel, ops });
    CE.busy = false;
    closeCensor(true);
    ceApplyResult(f, res, res.edits);
    nf = next ? ceNextFlagged(f) : null;
    toast(`검열 덧칠 저장${res.edits > 1 ? ` (${res.edits}번째)` : ''} — 원본은 data\\${S.cfg.censor_dir}에 보관`
      + (next ? (nf ? ` · 다음 '검열 약함' 컷: ${nf.name}` : " · 남은 '검열 약함' 컷 없음") : ''));
  } catch (e) {
    toast('저장 실패: ' + e.message, true);
  } finally { CE.busy = false; $('#cedit')?.classList.remove('busy'); }
  if (nf) { rebuild(nf.key); openCensor(nf); }
}

function ceRestoreAsk() {
  openModal(`<h2>원본 복원 — ${esc(CE.f.name)}</h2>
    <div>처음 덧칠하기 전 파일로 되돌립니다. 지금까지 저장한 덧칠은 모두 사라지고, 보관한 원본 사본은 지웁니다.</div>
    <div class="foot"><button id="rsCancel">취소</button><button id="rsGo" class="danger">원본으로 (Enter)</button></div>`);
  const go = async () => {
    closeModal();
    const f = CE.f;
    CE.busy = true;
    try {
      const res = await req('/api/censor-restore', { root: S.root, rel: f.rel });
      CE.busy = false;
      closeCensor(true);
      ceApplyResult(f, res, 0);
      toast('원본으로 되돌렸습니다.');
    } catch (e) { toast('복원 실패: ' + e.message, true); } finally { CE.busy = false; }
  };
  $('#rsGo').onclick = go;
  $('#rsCancel').onclick = closeModal;
  S.modalEnter = go;
}

function ceKeydown(e) {
  if (CE.busy) return e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    if (e.code === 'KeyZ') { e.preventDefault(); ceUndo(); }
    if (e.code === 'KeyS') { e.preventDefault(); ceSave(e.shiftKey); }
    return;
  }
  if (/^(INPUT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) ceCompare(true); return; }
  const save = () => ceSave(e.shiftKey);
  const acts = {
    Digit1: () => ceSet('mode', 'blur'), Digit2: () => ceSet('mode', 'mosaic'), Digit3: () => ceSet('mode', 'fill'),
    Numpad1: () => ceSet('mode', 'blur'), Numpad2: () => ceSet('mode', 'mosaic'), Numpad3: () => ceSet('mode', 'fill'),
    KeyB: () => ceSet('shape', 'brush'), KeyR: () => ceSet('shape', 'rect'), KeyF: () => ceSet('soft', !CE.soft),
    BracketLeft: () => ceSet('size', CE.size / 1.18), BracketRight: () => ceSet('size', CE.size * 1.18),
    Digit0: ceFit, Numpad0: ceFit, Enter: save, NumpadEnter: save, Escape: () => closeCensor(false), Backspace: ceUndo,
  };
  const fn = acts[e.code];
  if (fn) { e.preventDefault(); fn(); }
}

// ───────────────────────── 입력 ─────────────────────────

function onKey(e) {
  if (CE.open && !modalOpen()) return ceKeydown(e);
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (!$('#ctx').hidden) return hideCtx();
    if (modalOpen()) return closeModal();
    if (typing) return document.activeElement.blur();
    if (S.sel.size) return clearSel();
    if (S.prevMode) return toggleSingle();
    return;
  }
  if (modalOpen()) {
    if (e.key === 'Enter' && S.modalEnter && !(typing && document.activeElement.tagName === 'TEXTAREA')) {
      e.preventDefault(); S.modalEnter();
    }
    return;
  }
  if (typing) return;
  hideCtx();
  const k = e.key;
  let lower = k.length === 1 ? k.toLowerCase() : k;
  // 한글 입력 상태면 e.key가 'ㅁ'·'Process'로 온다 → 물리 키(e.code)로 영문 단축키를 찾는다
  if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/.test(lower) && (k === 'Process' || /[^\x00-\x7f]/.test(k))) lower = e.code.slice(3).toLowerCase();

  if (e.ctrlKey || e.metaKey) {
    if (lower === 'z') { e.preventDefault(); undo(); }
    if (lower === 'o') { e.preventDefault(); showRootModal(); }
    if (lower === 'e') { e.preventDefault(); doExport(); }
    if (lower === 'c') { e.preventDefault(); copyImage(); }
    if (lower === 'a') { e.preventDefault(); if (e.shiftKey) selectAllList(); else selectPage(); }
    return;
  }
  if (e.altKey) return;

  const tag = S.tagByKey.get(lower);
  if (tag && !e.shiftKey) { e.preventDefault(); toggleTag(tag.id); return; }

  switch (k) {
    case 'ArrowRight': case 'PageDown': e.preventDefault(); goPage(S.page + (e.shiftKey ? 10 : 1)); break;
    case 'ArrowLeft': case 'PageUp': e.preventDefault(); goPage(S.page - (e.shiftKey ? 10 : 1)); break;
    case 'ArrowDown': case 'ArrowUp': {
      e.preventDefault();
      const d = k === 'ArrowDown' ? 1 : -1;
      if (e.shiftKey) { const f = curFile(); toggleSel(f, true); moveFocus(d); toggleSel(curFile(), true); paintMarks(); updateStatus(); }
      else moveFocus(d);
      break;
    }
    case 'Home': goPage(0); break;
    case 'End': goPage(S.pages.length - 1); break;
    case 'Enter': toggleSingle(); break;
    case ' ': e.preventDefault(); if (!e.repeat && !isSingle()) showPeek(true); break;
    case '0': case 'Backspace': clearMarks(); break;
    case 'Delete': deleteTargets(); break;
    case 'F5': e.preventDefault(); if (S.root) openRoot(S.root, true).then(() => toast('다시 읽음')); break;
    case '/': e.preventDefault(); $('#search').focus(); break;
    case '+': case '=': stepMode(1); break;
    case '-': case '_': stepMode(-1); break;
    default:
      switch (lower) {
        case 'm': editNote(); break;
        case 'e': openCensor(); break;
        case 'f': toggleNames(); break;
        case 'i': toggleInfo(); break;
        case 'b': toggleTree(); break;
        case 'c': runAct('copy'); break;
        case 'o': runAct('reveal'); break;
        case 'u': nextUnseenPage(); break;
        case 'x': runAct('sel'); break;
        case 'p': bulkPassModal(); break;
        case 'g': jumpPageModal(); break;
        case 'k': cycleBg(); break;
        case 'h': case '?': showHelp(); break;
        case 'v': S.prevMode = null; setMode(modeOf(S.mode).id === 'set' ? (lsGet('rv:gridMode') || '10') : 'set'); break;
      }
  }
}

function toggleNames() { S.showNames = !S.showNames; document.body.classList.toggle('nonames', !S.showNames); $('#btnNames').classList.toggle('on', S.showNames); lsSet('rv:names', S.showNames ? '1' : '0'); }
function toggleInfo() { S.showInfo = !S.showInfo; $('#info').hidden = !S.showInfo; $('#btnInfo').classList.toggle('on', S.showInfo); lsSet('rv:info', S.showInfo ? '1' : '0'); relayout(); if (S.showInfo) updateInfo(true); }
function toggleTree() { S.showTree = !S.showTree; $('#tree').hidden = !S.showTree; $('#btnTree').classList.toggle('on', S.showTree); lsSet('rv:tree', S.showTree ? '1' : '0'); relayout(); }
function cycleBg() {
  const order = ['dark', 'gray', 'white', 'checker'];
  S.set.bg = order[(order.indexOf(S.set.bg) + 1) % order.length];
  saveSettings(); applySettings();
  toast(`배경: ${{ dark: '검정', gray: '회색', white: '흰색', checker: '체크무늬' }[S.set.bg]}`);
}

let relayoutTimer = 0;
function relayout() { clearTimeout(relayoutTimer); relayoutTimer = setTimeout(render, 120); }

function syncControls() {
  $('#selMode').value = S.mode; $('#selFilter').value = S.filter; $('#selSort').value = S.sort;
}

function bindUI() {
  document.addEventListener('keydown', onKey);
  document.addEventListener('keyup', (e) => { if (e.key === ' ') { showPeek(false); ceCompare(false); } });
  window.addEventListener('blur', () => { showPeek(false); ceCompare(false); });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) hideCtx(); });
  $('#stage').addEventListener('wheel', onWheel, { passive: false });
  bindZoomDrag();
  window.addEventListener('resize', () => { relayout(); if (CE.open) ceFit(); });

  $('#btnRoot').onclick = showRootModal;
  $('#rootLabel').onclick = () => S.root && copyText(S.root, '폴더 경로 복사됨');
  $('#btnRescan').onclick = () => S.root && openRoot(S.root, true).then(() => toast('다시 읽음'));
  $('#btnExport').onclick = doExport;
  $('#btnPass').onclick = bulkPassModal;
  $('#btnHelp').onclick = showHelp;
  $('#btnSettings').onclick = settingsModal;
  $('#btnNames').onclick = toggleNames;
  $('#btnInfo').onclick = toggleInfo;
  $('#btnTree').onclick = toggleTree;
  $('#selMode').onchange = (e) => { S.prevMode = null; setMode(e.target.value); e.target.blur(); };
  $('#selFilter').onchange = (e) => { S.filter = e.target.value; rebuild(curFile()?.key); e.target.blur(); };
  $('#selSort').onchange = (e) => { S.sort = e.target.value; rebuild(curFile()?.key); e.target.blur(); };
  let st = 0;
  const search = $('#search');
  search.addEventListener('input', () => {
    clearTimeout(st);
    if (/^p:/i.test(search.value)) return;   // 프롬프트 검색은 Enter로
    st = setTimeout(() => runSearch(search.value), 200);
  });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { runSearch(search.value); search.blur(); } });

  const clickTagOrAct = (e) => {
    const b = e.target.closest('[data-tag],[data-act],[data-copy]');
    if (!b) return;
    if (b.dataset.copy !== undefined) return copyText(b.dataset.copy, '복사됨');
    if (b.closest('#ctx')) hideCtx();
    if (b.dataset.tag) toggleTag(b.dataset.tag); else runAct(b.dataset.act);
  };
  $('#palette').addEventListener('click', clickTagOrAct);
  $('#info').addEventListener('click', clickTagOrAct);
  $('#ctx').addEventListener('click', clickTagOrAct);
  $('#tree').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    S.sub = row.dataset.rel;
    rebuild();
    renderTree();
  });
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });

  S.showNames = lsGet('rv:names') !== '0';
  S.showInfo = lsGet('rv:info') === '1';
  S.showTree = lsGet('rv:tree') !== '0';
  document.body.classList.toggle('nonames', !S.showNames);
  $('#btnNames').classList.toggle('on', S.showNames);
  $('#info').hidden = !S.showInfo; $('#btnInfo').classList.toggle('on', S.showInfo);
  $('#tree').hidden = !S.showTree; $('#btnTree').classList.toggle('on', S.showTree);
}

// ───────────────────────── 설정 · 기타 ─────────────────────────

function loadSettings() {
  try { S.set = { ...SETTINGS_DEFAULT, ...JSON.parse(lsGet('rv:settings') || '{}') }; } catch { S.set = { ...SETTINGS_DEFAULT }; }
}
function saveSettings() { lsSet('rv:settings', JSON.stringify(S.set)); }
function applySettings() {
  document.body.dataset.bg = S.set.bg;
  document.body.classList.toggle('noseendot', !S.set.seenDot);
}

function savePos() {
  if (!S.root) return;
  const m = modeOf(S.mode).id;
  if (m !== 'set' && m !== '1') lsSet('rv:gridMode', m);
  lsSet(posKey(), JSON.stringify({ key: curFile()?.key, mode: S.prevMode || S.mode, filter: S.filter, sort: S.sort, sub: S.sub, includeSub: S.includeSub }));
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 저장소 막힘 */ } }

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(String(text)); toast(msg); } catch (e) { toast('복사 실패: ' + e.message, true); }
}

function toast(msg, err = false) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (err) d.className = 'err';
  const box = $('#toast');
  box.appendChild(d);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => d.remove(), err ? 5000 : 1800);
}

init().catch((e) => toast('초기화 실패: ' + e.message, true));
