/* Aufgaben – Oberfläche. Kein Framework, kein Build-Schritt.

   Jede Änderung wird sofort lokal angezeigt und landet in einer Warteschlange
   (localStorage), die nacheinander an den Server geht. Ohne Netz bleibt sie
   liegen und wird beim nächsten Kontakt nachgeschickt – nichts geht verloren.
   Der Server verträgt Wiederholungen: Aufgaben und Kategorien bringen ihre Id
   selbst mit, ein zweites Anlegen liefert nur den vorhandenen Eintrag zurück. */
'use strict';
(() => {

// ============================================================ Grundlagen

const $ = (sel) => document.querySelector(sel);

const LS = {
  get(k, d) {
    try { const v = localStorage.getItem('aufgaben.' + k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) { try { localStorage.setItem('aufgaben.' + k, JSON.stringify(v)); } catch { /* voll/gesperrt */ } },
  del(k) { try { localStorage.removeItem('aufgaben.' + k); } catch { /* egal */ } },
};

// Muss zu COLORS in server.py passen.
const COLORS = ['#1c7ed6', '#0c8599', '#099268', '#2f9e44', '#5c940d', '#e67700',
                '#e8590c', '#e03131', '#c2255c', '#9c36b5', '#6741d9', '#868e96'];

const ICON = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  star: '<path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

function icon(name, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICON[name];
  return s;
}

/** Element bauen: h('div', {class, text, style, data, onclick, …}, …kinder) */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') for (const [p, pv] of Object.entries(v)) el.style.setProperty(p, pv);
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const E = {
  txt: $('#txt'), add: $('#add'), send: $('#send'), chips: $('#chips'), hint: $('#hint'),
  seg: $('#seg'), list: $('#list'), settings: $('#settings'), status: $('#status'),
  title: $('#title'), q: $('#q'), searchform: $('#searchform'), toast: $('#toast'),
  sheet: $('#sheet'), sheetform: $('#sheetform'), etext: $('#etext'), ecats: $('#ecats'),
  estar: $('#estar'), emeta: $('#emeta'), edel: $('#edel'), ereopen: $('#ereopen'),
  catdlg: $('#catdlg'), catform: $('#catform'), catname: $('#catname'), catnote: $('#catdlg-note'),
  catpal: $('#catpal'), login: $('#login'), loginform: $('#loginform'), pw: $('#pw'), loginerr: $('#loginerr'),
};

const S = {
  cats: [],                 // [{id, name, color}] in Anzeige-Reihenfolge
  open: [],                 // offene Aufgaben
  queue: LS.get('queue', []),
  filter: 'all',            // 'all' oder Kategorie-Id – ist zugleich das Ziel für ↵
  view: 'open',             // 'open' | 'done'
  searching: false,
  settings: false,
  online: true,
  authEnabled: false,
  version: '',
  done: { key: null, items: [], more: false, loading: false, error: false },
  search: { q: '', items: [], more: false, loading: false, error: false, seq: 0 },
  palette: null,            // Kategorie mit aufgeklappter Farbwahl (Einstellungen)
  flash: null,              // gerade angelegte Aufgabe kurz hervorheben
  installEvt: null,
};

const uid = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Date.now().toString(36) + Array.from(a, (b) => (b % 36).toString(36)).join('');
};
const nowISO = () => new Date().toISOString();
const catById = (id) => S.cats.find((c) => c.id === id);
const catName = (id) => catById(id)?.name ?? 'Ohne Kategorie';
const taskUrl = (id) => 'api/tasks/' + encodeURIComponent(id);
const catUrl = (id) => 'api/categories/' + encodeURIComponent(id);
const isTyping = () => E.txt.value.trim().length > 0;
const finePointer = () => matchMedia('(pointer: fine)').matches;
const compact = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
// Wichtige zuerst, sonst die neueste oben.
const byTask = (a, b) => (b.star - a.star) || (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);
const byDone = (a, b) => (a.done < b.done ? 1 : a.done > b.done ? -1 : 0);

// ============================================================ Datum

function dayDiff(iso) {
  const d = new Date(iso), n = new Date();
  return Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
}
function age(iso) {
  const n = dayDiff(iso);
  if (n <= 0) return '';
  if (n === 1) return 'gestern';
  if (n < 7) return `${n} Tage`;
  if (n < 35) return `${Math.floor(n / 7)} Wo.`;
  return new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function dayLabel(iso) {
  const n = dayDiff(iso);
  if (n === 0) return 'Heute';
  if (n === 1) return 'Gestern';
  const d = new Date(iso);
  const opt = { weekday: 'short', day: '2-digit', month: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opt.year = 'numeric';
  return d.toLocaleDateString('de-DE', opt);
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
const dateTime = (iso) => new Date(iso).toLocaleString('de-DE',
  { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const shortDate = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });

// ============================================================ Text

const URL_RE = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]'"]/gi;

function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0],
      onclick: (e) => e.stopPropagation() }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** #schule → Kategorie „Schule Nord“: exakter Treffer oder eindeutiger Anfang. Wie find_cat() im Server. */
function findCat(word) {
  const w = compact(word);
  if (w.length < 2) return null;
  const exact = S.cats.find((c) => compact(c.name) === w);
  if (exact) return exact;
  const start = S.cats.filter((c) => compact(c.name).startsWith(w));
  return start.length === 1 ? start[0] : null;
}

/** „!“ am Anfang = wichtig, „#name“ = Kategorie. Wie parse_quick() im Server. */
function parseQuick(text) {
  let star = false, cat = null;
  if (text.startsWith('!')) { star = true; text = text.slice(1).trimStart(); }
  for (const m of text.matchAll(/(^|\s)#([^\s#]{2,})/g)) {
    const c = findCat(m[2].replace(/[.,;:!?]+$/, ''));
    if (c) {
      cat = c.id;
      text = text.slice(0, m.index) + text.slice(m.index + m[0].length);
      break;
    }
  }
  return { text: text.replace(/[ \t]{2,}/g, ' ').trim(), cat, star };
}

// ============================================================ Abgleich mit dem Server

let syncing = null;
let again = false;

/** Warteschlange abarbeiten, danach den Stand holen. Liefert ein Promise, das
    erst erfüllt ist, wenn nichts mehr aussteht (oder das Netz fehlt). */
function sync() {
  if (syncing) { again = true; return syncing; }
  syncing = (async () => {
    try {
      do {
        again = false;
        if (await flush()) await pull();
      } while (again);
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

async function flush() {
  while (S.queue.length) {
    const op = S.queue[0];
    let res;
    try {
      res = await fetch(op.url, {
        method: op.method,
        headers: op.body ? { 'Content-Type': 'application/json' } : {},
        body: op.body ? JSON.stringify(op.body) : undefined,
        cache: 'no-store',
      });
    } catch {
      setOnline(false);
      return false;
    }
    if (res.status === 401) { needLogin(); return false; }
    // Proxy meldet: Container nicht da → später erneut, nie verwerfen.
    if ([502, 503, 504].includes(res.status)) { setOnline(false); return false; }
    if (res.status >= 500) {
      op.tries = (op.tries || 0) + 1;
      if (op.tries < 5) { saveQueue(); return false; }
    }
    if (!res.ok && res.status !== 404) toast('Eine Änderung wurde vom Server abgelehnt.');
    S.queue.shift();
    saveQueue();
  }
  setOnline(true);
  return true;
}

async function pull() {
  let res;
  try {
    res = await fetch('api/state', { cache: 'no-store' });
  } catch {
    setOnline(false);
    return;
  }
  if (res.status === 401) { needLogin(); return; }
  if (!res.ok) return;
  const d = await res.json();
  setOnline(true);
  if (S.queue.length) { again = true; return; }   // inzwischen neue Änderung – erst die senden
  S.authEnabled = d.auth;
  S.version = d.version;
  S.cats = d.categories;
  S.open = d.open;
  checkFilter();
  saveCache();
  render();
}

function enqueue(method, url, body) {
  S.queue.push(body === undefined ? { method, url } : { method, url, body });
  saveQueue();
  saveCache();
  sync();
}

function saveQueue() { LS.set('queue', S.queue); renderStatus(); }
function saveCache() { LS.set('cache', { cats: S.cats, open: S.open }); }

function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  renderStatus();
}

function checkFilter() {
  if (S.filter !== 'all' && !catById(S.filter)) S.filter = 'all';
}

// ============================================================ Aufgaben ändern

const lists = () => [S.open, S.done.items, S.search.items];
function update(id, patch) {
  for (const l of lists()) for (const t of l) if (t.id === id) Object.assign(t, patch);
}
function removeEverywhere(id) {
  S.open = S.open.filter((t) => t.id !== id);
  S.done.items = S.done.items.filter((t) => t.id !== id);
  S.search.items = S.search.items.filter((t) => t.id !== id);
}

function submit(chipCat) {
  const raw = E.txt.value.trim();
  if (!raw) return;
  const p = parseQuick(raw);
  if (!p.text) return;
  let cat = chipCat !== undefined ? chipCat : (p.cat || (S.filter === 'all' ? null : S.filter));
  if (cat && !catById(cat)) cat = null;
  E.txt.value = '';
  autoGrow(E.txt);
  updateTyping();
  addTask(p.text, cat, p.star, raw);
}

function addTask(text, cat, star, raw) {
  const t = { id: uid(), text, cat, star: !!star, created: nowISO(), done: null };
  S.open.push(t);
  S.flash = t.id;
  enqueue('POST', 'api/tasks', t);
  render();
  toast(cat ? `Gespeichert in „${catName(cat)}“` : 'Gespeichert', 'Rückgängig', () => {
    // Falsche Kategorie erwischt: Aufgabe zurücknehmen, Text wieder ins Feld.
    removeEverywhere(t.id);
    enqueue('DELETE', taskUrl(t.id));
    E.txt.value = raw;
    autoGrow(E.txt);
    render();
    E.txt.focus();
  });
}

function setDone(t, done, quiet) {
  const at = done ? nowISO() : null;
  update(t.id, { done: at });
  const copy = { ...t, done: at };
  if (done) {
    S.open = S.open.filter((x) => x.id !== t.id);
    if (S.done.key === 'all' || S.done.key === copy.cat) {
      S.done.items = [copy, ...S.done.items.filter((x) => x.id !== t.id)];
    }
  } else {
    if (!S.open.some((x) => x.id === t.id)) S.open.push(copy);
    S.done.items = S.done.items.filter((x) => x.id !== t.id);
  }
  enqueue('PATCH', taskUrl(t.id), { done: at });
  render();
  if (!quiet) toast(done ? 'Erledigt' : 'Wieder offen', 'Rückgängig', () => setDone(copy, !done, true));
}

function onCheck(t, row) {
  if (t.done) return setDone(t, false);
  if (row.classList.contains('ticking')) return;
  row.classList.add('ticking');                 // kurz abgehakt zeigen, dann weg
  setTimeout(() => setDone(t, true), 280);
}

function restoreTask(t) {
  const copy = { ...t };
  if (!copy.done) S.open.push(copy);
  else if (S.done.key === 'all' || S.done.key === copy.cat) S.done.items.push(copy);
  enqueue('POST', 'api/tasks', copy);
  render();
}

// ============================================================ Kategorien ändern

function nextColor() {
  const used = new Set(S.cats.map((c) => c.color));
  return COLORS.find((x) => !used.has(x)) || COLORS[S.cats.length % COLORS.length];
}

function addCat(name, color) {
  const existing = S.cats.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing;
  const c = { id: uid(), name, color: color || nextColor() };
  S.cats.push(c);
  enqueue('POST', 'api/categories', c);
  return c;
}

function renameCat(id, input) {
  const c = catById(id);
  const name = input.value.trim();
  if (!c) return;
  if (!name || name === c.name) { input.value = c.name; return; }
  c.name = name;
  enqueue('PATCH', catUrl(id), { name });
}

function recolorCat(id, color) {
  const c = catById(id);
  if (!c) return;
  c.color = color;
  S.palette = null;
  enqueue('PATCH', catUrl(id), { color });
  renderSettings();
}

function moveCat(id, dir) {
  const i = S.cats.findIndex((c) => c.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= S.cats.length) return;
  [S.cats[i], S.cats[j]] = [S.cats[j], S.cats[i]];
  enqueue('PUT', 'api/categories/order', { ids: S.cats.map((c) => c.id) });
  renderSettings();
}

function deleteCat(id) {
  const c = catById(id);
  if (!c) return;
  const n = S.open.filter((t) => t.cat === id).length;
  const msg = `Kategorie „${c.name}“ löschen?\n\nDie Aufgaben bleiben erhalten`
    + (n ? ` (${n} offen)` : '') + ' und stehen danach unter „Ohne Kategorie“ – auch die erledigten.';
  if (!confirm(msg)) return;
  S.cats = S.cats.filter((x) => x.id !== id);
  for (const l of lists()) for (const t of l) if (t.cat === id) t.cat = null;
  if (S.filter === id) S.filter = 'all';
  S.done.key = null;
  enqueue('DELETE', catUrl(id));
  renderSettings();
}

// ============================================================ Darstellung

function render() {
  renderStatus();
  if (S.settings) {
    // Nicht unter den Fingern wegbauen, während ein Name bearbeitet wird.
    const ae = document.activeElement;
    if (!(ae && ae.tagName === 'INPUT' && E.settings.contains(ae))) renderSettings();
    return;
  }
  renderChips();
  renderSeg();
  updateTyping();
  renderList();
}

function renderStatus() {
  E.status.hidden = S.online;
  E.status.textContent = S.queue.length ? `Offline · ${S.queue.length}` : 'Offline';
  E.status.title = S.queue.length
    ? `${S.queue.length} Änderung(en) warten und werden automatisch nachgeschickt`
    : 'Server nicht erreichbar';
}

function chipEl({ id, name, color, n, on, plus = true }) {
  return h('button', {
    class: 'chip' + (color ? '' : ' plain') + (on ? ' on' : ''),
    type: 'button',
    data: { id },
    style: color ? { '--c': color } : null,
    'aria-pressed': on ? 'true' : 'false',
  },
  color ? h('span', { class: 'dot' }) : null,
  plus ? h('span', { class: 'plus', text: '+' }) : null,
  h('span', { class: 'name', text: name }),
  n ? h('span', { class: 'n', text: String(n) }) : null);
}

function renderChips() {
  const counts = {};
  for (const t of S.open) counts[t.cat] = (counts[t.cat] || 0) + 1;
  E.chips.replaceChildren(
    chipEl({ id: 'all', name: 'Alle', n: S.open.length, on: S.filter === 'all' }),
    ...S.cats.map((c) => chipEl({ id: c.id, name: c.name, color: c.color, n: counts[c.id], on: S.filter === c.id })),
    h('button', { class: 'chip add', type: 'button', data: { id: '+' }, 'aria-label': 'Neue Kategorie' }, icon('plus')),
  );
}

function renderSeg() {
  for (const b of E.seg.children) {
    const on = b.dataset.v === S.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function updateTyping() {
  const typing = isTyping();
  document.body.classList.toggle('typing', typing);
  E.send.disabled = !typing;
  if (!typing) return;
  const p = parseQuick(E.txt.value.trim());
  const target = p.cat || (S.filter !== 'all' && catById(S.filter) ? S.filter : null);
  E.hint.replaceChildren('Speichert ',
    target ? h('span', {}, 'in ', h('b', { text: catName(target) })) : h('b', { text: 'ohne Kategorie' }),
    ' – oder Kategorie antippen');
}

function renderList() {
  if (S.searching) renderSearch();
  else if (S.view === 'done') renderDone();
  else renderOpen();
  if (S.flash) {
    const row = E.list.querySelector(`.task[data-id="${CSS.escape(S.flash)}"]`);
    if (row) row.classList.add('flash');
    S.flash = null;
  }
}

function taskRow(t, { showCat = false, right = null, doneDate = false } = {}) {
  const c = catById(t.cat);
  const meta = [];
  if (showCat) meta.push(h('span', { class: 'tag', text: c ? c.name : 'Ohne Kategorie' }));
  if (doneDate && t.done) meta.push((meta.length ? ' · ' : '') + 'erledigt ' + shortDate(t.done));
  const row = h('div', { class: 'task' + (t.done ? ' done' : ''), data: { id: t.id }, style: c ? { '--c': c.color } : null },
    h('button', {
      class: 'check', type: 'button',
      'aria-label': t.done ? 'Wieder öffnen' : 'Als erledigt markieren',
      onclick: () => onCheck(t, row),
    }, h('span', { class: 'box' }, icon('check'))),
    h('div', { class: 'body', onclick: () => openEdit(t) },
      h('div', { class: 'text' }, t.star ? icon('star', 'star') : null, linkify(t.text)),
      meta.length ? h('div', { class: 'meta' }, meta) : null),
    right ? h('span', { class: 'age', text: right }) : null);
  return row;
}

function emptyEl(big, small) {
  return h('div', { class: 'empty' },
    big ? h('div', { class: 'big', text: big }) : null,
    small ? h('div', { text: small }) : null);
}

function renderOpen() {
  const tasks = S.open.slice().sort(byTask);
  const cat = catById(S.filter);
  const out = [];
  if (!cat) {
    // „Alle“: nach Kategorie gruppiert, in der Reihenfolge der Chips
    const groups = new Map([[null, []], ...S.cats.map((c) => [c.id, []])]);
    for (const t of tasks) (groups.get(t.cat) || groups.get(null)).push(t);
    for (const [id, arr] of groups) {
      if (!arr.length) continue;
      const c = catById(id);
      out.push(h('section', { class: 'group', style: c ? { '--c': c.color } : null },
        h(c ? 'button' : 'div', {
          class: 'ghead' + (c ? '' : ' static'), type: c ? 'button' : null,
          onclick: c ? () => { setFilter(c.id); window.scrollTo(0, 0); } : null,
        }, h('span', { class: 'dot' }), h('span', { text: c ? c.name : 'Ohne Kategorie' }),
          h('span', { class: 'n', text: String(arr.length) })),
        h('div', { class: 'card' }, arr.map((t) => taskRow(t, { right: age(t.created) })))));
    }
    if (!tasks.length) {
      out.push(S.cats.length
        ? emptyEl('Alles erledigt', 'Nichts offen – oben einfach lostippen.')
        : h('div', { class: 'card welcome' },
          h('h2', { text: 'Schreib oben einfach los.' }),
          h('p', { text: 'Lege Kategorien für deine Einrichtungen, Projekte und Privates an. '
            + 'Danach: Text tippen, Kategorie antippen – gespeichert.' }),
          h('button', { class: 'btn primary', type: 'button', text: 'Erste Kategorie anlegen', onclick: openNewCat })));
    }
  } else {
    const arr = tasks.filter((t) => t.cat === cat.id);
    out.push(arr.length
      ? h('div', { class: 'card', style: { '--c': cat.color } }, arr.map((t) => taskRow(t, { right: age(t.created) })))
      : emptyEl(`In „${cat.name}“ ist nichts offen`, 'Was du jetzt oben eintippst, landet direkt hier.'));
  }
  E.list.replaceChildren(...out);
}

function renderDone() {
  if (S.done.key !== S.filter) loadDone(false);
  if (S.done.key !== S.filter) { E.list.replaceChildren(emptyEl('', 'Lade …')); return; }
  const cat = catById(S.filter);
  const items = S.done.items.filter((t) => !cat || t.cat === cat.id).sort(byDone);
  const out = [];
  if (!items.length) {
    if (S.done.loading) out.push(emptyEl('', 'Lade …'));
    else if (S.done.error) out.push(emptyEl('Gerade keine Verbindung', 'Erledigte Aufgaben kommen direkt vom Server.'));
    else out.push(emptyEl('Noch nichts erledigt', cat ? `in „${cat.name}“` : ''));
  } else {
    let day = null, card = null;
    for (const t of items) {
      const label = dayLabel(t.done);
      if (label !== day) {
        day = label;
        card = h('div', { class: 'card' });
        out.push(h('section', { class: 'group' }, h('div', { class: 'dayhead', text: label }), card));
      }
      card.append(taskRow(t, { showCat: !cat, right: timeOf(t.done) }));
    }
    if (S.done.more || S.done.loading) {
      out.push(h('button', {
        class: 'btn small loadmore', type: 'button', disabled: S.done.loading,
        text: S.done.loading ? 'Lade …' : 'Ältere laden', onclick: () => loadDone(true),
      }));
    }
  }
  E.list.replaceChildren(...out);
}

async function loadDone(more) {
  if (S.done.loading) return;
  const key = S.filter;
  S.done.loading = true;
  S.done.error = false;
  if (!more) Object.assign(S.done, { key, items: [], more: false });
  renderList();
  try {
    await sync();
    const res = await fetch(`api/done?kat=${encodeURIComponent(key)}&offset=${S.done.items.length}&limit=60`,
      { cache: 'no-store' });
    if (res.status === 401) needLogin();
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    if (S.filter === key) {
      const seen = new Set(S.done.items.map((t) => t.id));
      S.done.items.push(...d.tasks.filter((t) => !seen.has(t.id)));
      S.done.more = d.more;
    }
  } catch {
    S.done.error = true;
  } finally {
    S.done.loading = false;
    if (S.view === 'done' && !S.searching && !S.settings) renderList();
  }
}

function renderSearch() {
  const { q, items, loading, error, more } = S.search;
  const out = [];
  if (!q) {
    out.push(emptyEl('', 'Sucht in offenen und erledigten Aufgaben und in Kategorienamen.'));
  } else if (!items.length) {
    out.push(loading ? emptyEl('', 'Suche …') : emptyEl('Nichts gefunden', error ? 'Ohne Verbindung nur in offenen Aufgaben.' : ''));
  } else {
    out.push(h('p', { class: 'count', text: `${items.length}${more ? '+' : ''} Treffer`
      + (error ? ' – ohne Verbindung nur offene' : '') }));
    out.push(h('div', { class: 'card' },
      items.map((t) => taskRow(t, { showCat: true, doneDate: true, right: t.done ? null : age(t.created) }))));
  }
  E.list.replaceChildren(...out);
}

// ============================================================ Suche

let searchTimer;
function openSearch() {
  if (S.searching) return;
  S.searching = true;
  S.search = { q: '', items: [], more: false, loading: false, error: false, seq: S.search.seq + 1 };
  document.body.classList.add('searching');
  E.q.value = '';
  renderList();
  E.q.focus();
  pushLayer(() => {
    S.searching = false;
    document.body.classList.remove('searching');
    E.q.blur();
    render();
  });
}

async function runSearch() {
  const q = E.q.value.trim();
  const seq = ++S.search.seq;
  S.search.q = q;
  if (!q) { Object.assign(S.search, { items: [], loading: false, error: false }); renderList(); return; }
  S.search.loading = true;
  renderList();
  try {
    await sync();
    const res = await fetch('api/search?q=' + encodeURIComponent(q), { cache: 'no-store' });
    if (res.status === 401) needLogin();
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    if (seq === S.search.seq) Object.assign(S.search, { items: d.tasks, more: d.more, error: false });
  } catch {
    if (seq === S.search.seq) {
      // Ohne Netz wenigstens die offenen Aufgaben durchsuchen.
      const words = compact(q) ? q.toLowerCase().split(/\s+/) : [];
      const items = S.open.filter((t) => {
        const hay = (t.text + ' ' + catName(t.cat)).toLowerCase();
        return words.every((w) => hay.includes(w));
      }).sort(byTask);
      Object.assign(S.search, { items, more: false, error: true });
    }
  } finally {
    if (seq === S.search.seq) {
      S.search.loading = false;
      if (S.searching) renderList();
    }
  }
}

// ============================================================ Bearbeiten

let editing = null;
let editCat = null;

function openEdit(t) {
  editing = t;
  editCat = catById(t.cat) ? t.cat : null;
  E.etext.value = t.text;
  E.estar.checked = !!t.star;
  E.emeta.textContent = 'Erstellt ' + dateTime(t.created) + (t.done ? ' · erledigt ' + dateTime(t.done) : '');
  E.ereopen.hidden = !t.done;
  disarm(E.edel);
  renderEditCats();
  E.sheet.showModal();
  autoGrow(E.etext);
  pushLayer(() => E.sheet.close());
  if (finePointer()) E.etext.focus();
}

function renderEditCats() {
  E.ecats.replaceChildren(
    chipEl({ id: 'none', name: 'Ohne', on: editCat === null, plus: false }),
    ...S.cats.map((c) => chipEl({ id: c.id, name: c.name, color: c.color, on: editCat === c.id, plus: false })),
  );
}

function arm(btn, label) {
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = label;
  btn.classList.add('armed');
  clearTimeout(btn._timer);
  btn._timer = setTimeout(() => disarm(btn), 4000);
}
function disarm(btn) {
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.classList.remove('armed');
}

// ============================================================ Neue Kategorie (Dialog)

let newCatColor = null;

function openNewCat() {
  const withTask = isTyping();
  E.catname.value = '';
  E.catnote.textContent = withTask ? 'Deine Aufgabe wird gleich dort gespeichert.' : '';
  E.catnote.hidden = !withTask;
  newCatColor = nextColor();
  renderCatPalette();
  E.catdlg.showModal();
  pushLayer(() => E.catdlg.close());
  E.catname.focus();
}

function swatches(current, pick) {
  return COLORS.map((col) => h('button', {
    class: 'swatch' + (col === current ? ' on' : ''), type: 'button', style: { '--c': col },
    'aria-label': 'Farbe ' + col, onclick: () => pick(col),
  }));
}

function renderCatPalette() {
  E.catpal.replaceChildren(...swatches(newCatColor, (col) => { newCatColor = col; renderCatPalette(); }));
}

// ============================================================ Einstellungen

function openSettings() {
  S.settings = true;
  document.body.classList.add('settings');
  E.title.textContent = 'Einstellungen';
  renderSettings();
  window.scrollTo(0, 0);
  pushLayer(() => {
    S.settings = false;
    S.palette = null;
    document.body.classList.remove('settings');
    E.title.textContent = 'Aufgaben';
    render();
  });
}

function renderSettings() {
  const n = S.cats.length;
  const rows = S.cats.map((c, i) => h('div', { class: 'catrow', style: { '--c': c.color } },
    h('div', { class: 'catline' },
      h('button', {
        class: 'swatch', type: 'button', 'aria-label': 'Farbe ändern',
        onclick: () => { S.palette = S.palette === c.id ? null : c.id; renderSettings(); },
      }),
      h('input', {
        value: c.name, maxlength: '40', enterkeyhint: 'done', 'aria-label': 'Name', autocomplete: 'off',
        onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
        onchange: (e) => renameCat(c.id, e.target),
      }),
      h('button', { class: 'icon', type: 'button', 'aria-label': 'Nach oben', disabled: i === 0,
        onclick: () => moveCat(c.id, -1) }, icon('up')),
      h('button', { class: 'icon', type: 'button', 'aria-label': 'Nach unten', disabled: i === n - 1,
        onclick: () => moveCat(c.id, 1) }, icon('down')),
      h('button', { class: 'icon danger', type: 'button', 'aria-label': `„${c.name}“ löschen`,
        onclick: () => deleteCat(c.id) }, icon('trash'))),
    S.palette === c.id ? h('div', { class: 'palette' }, swatches(c.color, (col) => recolorCat(c.id, col))) : null));

  const addForm = h('form', {
    class: 'row',
    onsubmit: (e) => {
      e.preventDefault();
      const input = e.target.elements.nm;
      const name = input.value.trim();
      if (!name) return;
      addCat(name);
      renderSettings();
      E.settings.querySelector('input[name="nm"]')?.focus();
    },
  },
  h('input', { class: 'field', name: 'nm', placeholder: 'Neue Kategorie …', maxlength: '40',
    enterkeyhint: 'done', autocomplete: 'off', 'aria-label': 'Neue Kategorie' }),
  h('button', { class: 'btn primary', type: 'submit', text: 'Anlegen' }));

  const standalone = matchMedia('(display-mode: standalone)').matches;
  const tips = [
    !isSecureContext ? h('p', {}, h('b', { text: 'Hinweis: ' }),
      'Installieren, Kurzbefehle und Teilen funktionieren nur über HTTPS, z. B. hinter dem Reverse-Proxy.') : null,
    !standalone ? h('p', {}, h('b', { text: 'Als App installieren: ' }),
      'In Chrome „App installieren“ antippen oder Menü ⋮ → „Zum Startbildschirm hinzufügen“.',
      S.installEvt ? h('span', {}, ' ', h('button', {
        class: 'btn small primary', type: 'button', text: 'Jetzt installieren',
        onclick: async () => {
          const evt = S.installEvt;
          S.installEvt = null;
          evt.prompt();
          try { await evt.userChoice; } catch { /* abgebrochen */ }
          renderSettings();
        },
      })) : null) : null,
    h('p', {}, h('b', { text: 'Kurzbefehle: ' }),
      'App-Symbol lange drücken → „Neue Aufgabe“ oder eine der ersten drei Kategorien. '
      + 'Einen Eintrag kann man als eigenes Symbol auf den Startbildschirm ziehen.'),
    h('p', {}, h('b', { text: 'Teilen: ' }),
      'In jeder App „Teilen“ → „Aufgaben“. Der Text steht dann im Eingabefeld, nur noch die Kategorie antippen.'),
    h('p', {}, h('b', { text: 'Kürzel: ' }), h('code', { text: '!' }), ' am Anfang = wichtig, ',
      h('code', { text: '#name' }), ' = Kategorie – z. B. ', h('code', { text: '#schule Beamer prüfen' }), '.'),
  ];

  E.settings.replaceChildren(
    h('h2', { text: 'Kategorien' }),
    n ? h('div', { class: 'card' }, rows) : null,
    addForm,
    h('p', { class: 'note', text: 'Die ersten drei erscheinen als Kurzbefehl am App-Symbol. '
      + 'Reihenfolge mit den Pfeilen, Farbe über den Punkt.' }),
    h('h2', { text: 'Schnell erfassen' }),
    h('div', { class: 'card tips' }, tips),
    h('h2', { text: 'Daten' }),
    h('div', { class: 'linkrow' },
      h('a', { class: 'btn', href: 'api/export', download: '', text: 'Alles exportieren (JSON)' }),
      S.authEnabled ? h('button', { class: 'btn', type: 'button', text: 'Abmelden', onclick: logout }) : null),
    h('p', { class: 'version', text: `Version ${S.version || '–'}`
      + (S.queue.length ? ` · ${S.queue.length} Änderung(en) warten auf Verbindung` : '') }),
  );
}

// ============================================================ Anmeldung

function needLogin() {
  if (!E.login.hidden) return;
  E.login.hidden = false;
  E.loginerr.textContent = '';
  setTimeout(() => E.pw.focus(), 50);
}

async function logout() {
  if (S.queue.length && !confirm(`${S.queue.length} Änderung(en) sind noch nicht beim Server. Trotzdem abmelden?`)) return;
  try { await fetch('api/logout', { method: 'POST' }); } catch { /* egal */ }
  LS.del('cache');
  LS.del('queue');
  Object.assign(S, { queue: [], cats: [], open: [], filter: 'all' });
  closeTop();
  render();
  needLogin();
}

// ============================================================ Ebenen & Zurück-Taste

// Suche, Einstellungen und Dialoge legen je einen Verlaufseintrag an, damit die
// Zurück-Geste von Android sie schließt statt die App zu verlassen.
const layers = [];
function pushLayer(close) {
  layers.push(close);
  history.pushState({ layer: layers.length }, '');
}
function closeTop() {
  if (layers.length) history.back();
}

// ============================================================ Kleinkram

let toastTimer;
function toast(msg, action, fn) {
  E.toast.replaceChildren(h('span', { text: msg }), action ? h('button', {
    type: 'button', text: action,
    onmousedown: (e) => e.preventDefault(),       // Tastatur bleibt offen
    onclick: () => { hideToast(); fn(); },
  }) : null);
  E.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2500);
}
function hideToast() { E.toast.classList.remove('show'); }

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function setFilter(id) {
  S.filter = id;
  render();
}

/** Aufruf über Kurzbefehl (?neu, ?kat=…) oder „Teilen“ (?title, ?text, ?url). */
function readLaunch() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return false;
  if (p.get('kat')) S.filter = p.get('kat');
  const title = (p.get('title') || '').trim();
  const text = (p.get('text') || '').trim();
  const url = (p.get('url') || '').trim();
  const parts = [];
  if (title && !text.includes(title)) parts.push(title);
  if (text) parts.push(text);
  if (url && !text.includes(url)) parts.push(url);
  if (parts.length) E.txt.value = parts.join('\n');
  history.replaceState(null, '', location.pathname);
  return p.has('neu') || parts.length > 0;
}

// ============================================================ Ereignisse

function bindEvents() {
  // --- Eingabe: ↵ speichert, Umschalt+↵ macht eine neue Zeile
  let shiftEnter = false;
  E.txt.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.shiftKey) { shiftEnter = true; return; }
    e.preventDefault();
    submit();
  });
  E.txt.addEventListener('keyup', (e) => { if (e.key === 'Enter') shiftEnter = false; });
  // Manche Android-Tastaturen schicken kein keydown für ↵, nur dieses Ereignis.
  E.txt.addEventListener('beforeinput', (e) => {
    if ((e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') && !shiftEnter) {
      e.preventDefault();
      submit();
    }
  });
  E.txt.addEventListener('input', () => { autoGrow(E.txt); updateTyping(); });
  E.add.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  E.send.addEventListener('mousedown', (e) => e.preventDefault());

  // --- Chips: ohne Text = Filter, mit Text = dort speichern
  E.chips.addEventListener('mousedown', (e) => {
    if (isTyping() && e.target.closest('.chip:not(.add)')) e.preventDefault();   // Tastatur bleibt offen
  });
  E.chips.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    const id = b.dataset.id;
    if (id === '+') return openNewCat();
    if (isTyping()) {
      if (id !== 'all') { submit(id); E.txt.focus(); }
      return;
    }
    setFilter(id);
  });

  E.seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || S.view === b.dataset.v) return;
    S.view = b.dataset.v;
    render();
  });

  // --- Kopfzeile
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-back').addEventListener('click', closeTop);
  E.q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 220); });
  E.searchform.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); E.q.blur(); });

  // --- Bearbeiten-Dialog
  E.ecats.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    editCat = b.dataset.id === 'none' ? null : b.dataset.id;
    renderEditCats();
  });
  E.etext.addEventListener('input', () => autoGrow(E.etext));
  E.sheetform.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = editing;
    const text = E.etext.value.trim();
    if (!t) return;
    if (!text) { E.etext.focus(); return; }
    const patch = {};
    if (text !== t.text) patch.text = text;
    if (editCat !== (catById(t.cat) ? t.cat : null)) patch.cat = editCat;
    if (E.estar.checked !== !!t.star) patch.star = E.estar.checked;
    if (Object.keys(patch).length) {
      update(t.id, patch);
      enqueue('PATCH', taskUrl(t.id), patch);
      render();
    }
    closeTop();
  });
  E.edel.addEventListener('click', () => {
    if (!E.edel.classList.contains('armed')) return arm(E.edel, 'Wirklich löschen?');
    const t = { ...editing };
    closeTop();
    removeEverywhere(t.id);
    enqueue('DELETE', taskUrl(t.id));
    render();
    toast('Gelöscht', 'Rückgängig', () => restoreTask(t));
  });
  E.ereopen.addEventListener('click', () => {
    const t = editing;
    closeTop();
    setDone(t, false);
  });

  // --- Neue Kategorie
  E.catform.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = E.catname.value.trim();
    if (!name) { E.catname.focus(); return; }
    const c = addCat(name, newCatColor);
    closeTop();
    if (isTyping()) submit(c.id);
    else setFilter(c.id);
  });
  $('#catcancel').addEventListener('click', closeTop);

  // --- Dialoge: Esc und Klick daneben gehen über den Verlauf
  for (const dlg of [E.sheet, E.catdlg]) {
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeTop(); });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) closeTop(); });
  }
  window.addEventListener('popstate', () => {
    const close = layers.pop();
    if (close) close();
  });

  // --- Anmeldung
  E.loginform.addEventListener('submit', async (e) => {
    e.preventDefault();
    E.loginerr.textContent = '';
    try {
      const res = await fetch('api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: E.pw.value }),
      });
      if (!res.ok) {
        E.loginerr.textContent = res.status === 401 ? 'Falsches Passwort.' : 'Anmeldung fehlgeschlagen.';
        E.pw.select();
        return;
      }
    } catch {
      E.loginerr.textContent = 'Server nicht erreichbar.';
      return;
    }
    E.pw.value = '';
    E.login.hidden = true;
    sync();
  });

  // --- Tastatur am PC: „/“ sucht, „n“ springt ins Eingabefeld, Esc schließt
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || !E.login.hidden || document.querySelector('dialog[open]')) return;
    const tag = document.activeElement?.tagName;
    if (e.key === 'Escape' && layers.length) { e.preventDefault(); closeTop(); return; }
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === '/' && !S.settings) { e.preventDefault(); openSearch(); }
    if (e.key === 'n' && !S.settings && !S.searching) { e.preventDefault(); E.txt.focus(); }
  });

  // --- Wieder im Vordergrund: abgleichen; nach langer Pause frisch bei „Alle“ anfangen
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
      if (reloadPending) location.reload();
      return;
    }
    if (hiddenAt && Date.now() - hiddenAt > 30 * 60e3 && !isTyping() && !layers.length) {
      S.filter = 'all';
      S.view = 'open';
      render();
      window.scrollTo(0, 0);
    }
    sync();
    swReg?.update().catch(() => {});
  });
  window.addEventListener('online', () => sync());
  let ticks = 0;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    ticks += 1;
    if (S.queue.length || ticks % 4 === 0) sync();       // alle 60 s, mit Ausstehendem alle 15 s
  }, 15000);

  window.addEventListener('beforeinstallprompt', (e) => { S.installEvt = e; if (S.settings) renderSettings(); });
  window.addEventListener('appinstalled', () => { S.installEvt = null; if (S.settings) renderSettings(); });
}

// ============================================================ Service Worker

let swReg = null;
let reloadPending = false;

function registerSW() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;                    // allererste Installation
    // Neue Fassung: neu laden, aber nicht mitten im Tippen.
    if (isTyping() || layers.length) reloadPending = true;
    else location.reload();
  });
}

// ============================================================ Start

function boot() {
  const cache = LS.get('cache', null);
  if (cache) {
    S.cats = cache.cats || [];
    S.open = cache.open || [];
  }
  // Kein checkFilter() hier: ?kat= kann eine Kategorie meinen, die erst mit
  // dem nächsten Abgleich ankommt. Bis dahin zeigt renderOpen() einfach „Alle“.
  const focus = readLaunch();
  bindEvents();
  render();
  autoGrow(E.txt);
  if (focus || finePointer()) E.txt.focus({ preventScroll: true });
  registerSW();
  sync();
}

boot();
})();
