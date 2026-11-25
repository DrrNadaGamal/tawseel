import { DICT } from './i18n.js';

export const state = { lang: localStorage.getItem('tws_lang') || (navigator.language || '').startsWith('ar') ? 'ar' : 'en' };
if (localStorage.getItem('tws_lang')) state.lang = localStorage.getItem('tws_lang');

export function t(key, vars) {
  let s = (DICT[state.lang] && DICT[state.lang][key]) ?? DICT.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

export function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t(document.body.dataset.title || 'app.name') + ' | ' + t('app.name');
  document.querySelectorAll('[data-i]').forEach((el) => { el.textContent = t(el.dataset.i); });
  document.querySelectorAll('[data-ph]').forEach((el) => { el.placeholder = t(el.dataset.ph); });
  document.querySelectorAll('[data-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.aria)); });
  const b = document.getElementById('langBtn');
  if (b) { b.textContent = state.lang === 'ar' ? 'English' : 'العربية'; }
}

export function setLang(l, rerender) {
  state.lang = l;
  localStorage.setItem('tws_lang', l);
  applyLang();
  if (rerender) rerender();
}

export function initLang(rerender) {
  applyLang();
  const b = document.getElementById('langBtn');
  if (b) b.onclick = () => setLang(state.lang === 'ar' ? 'en' : 'ar', rerender);
}

// tiny safe DOM builder: text always goes through textContent
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') throw new Error('no html');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const locale = () => (state.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');
export const fmtTime = (ms) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Cairo' }).format(new Date(ms));
export const fmtDateTime = (ms) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Africa/Cairo' }).format(new Date(ms));
export const fmtMoney = (n) => t('money', { n: new Intl.NumberFormat(locale()).format(n) });
export const fmtNum = (n) => new Intl.NumberFormat(locale()).format(n);
export function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  if (min < 60) return t('dur.m', { m: min });
  return t('dur.hm', { h: Math.floor(min / 60), m: min % 60 });
}
export const zoneName = (zones, id) => { const z = zones.find((x) => x.id === id); return z ? (state.lang === 'ar' ? z.ar : z.en) : id; };
export const driverName = (drivers, id) => { const d = drivers.find((x) => x.id === id); return d ? (state.lang === 'ar' ? d.ar : d.name) : '-'; };

// ---------- api ----------
export const session = {
  get() { try { return JSON.parse(sessionStorage.getItem('tws_session') || 'null'); } catch { return null; } },
  set(s) { sessionStorage.setItem('tws_session', JSON.stringify(s)); },
  clear() { sessionStorage.removeItem('tws_session'); },
};

export async function api(method, path, body) {
  const s = session.get();
  let res;
  try {
    res = await fetch('/api/' + path, { method, headers: { 'Content-Type': 'application/json', ...(s ? { Authorization: 'Bearer ' + s.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    const e = new Error('network'); e.network = true; throw e;
  }
  let json = {};
  try { json = await res.json(); } catch {}
  if (res.status === 401 && s) { session.clear(); }
  if (!res.ok) { const e = new Error(json.error || 'error'); e.status = res.status; e.data = json; throw e; }
  return json;
}

export async function login(role, driverId) {
  const r = await api('POST', 'login', { role, driverId });
  session.set({ token: r.token, role: r.role, driverId: r.driverId });
  return r;
}

export function errText(e) {
  if (e.network) return t('err.network');
  const k = 'err.' + e.message;
  const s = t(k);
  return s === k ? t('err.generic') : s;
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.className = 'toast show ' + kind;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

export const STATUS_KEYS = ['new', 'assigned', 'accepted', 'picked_up', 'delivered', 'failed', 'cancelled'];

export function logoSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('width', '28'); s.setAttribute('height', '28'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<rect width="32" height="32" rx="9" fill="#f59e0b"/><path d="M8 20h11l3-8h3" fill="none" stroke="#0f172a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="22" r="2.6" fill="#0f172a"/><circle cx="23" cy="22" r="2.6" fill="#0f172a"/>';
  return s;
}

const ICONS = {
  bike: '<circle cx="5.5" cy="17" r="3.2"/><circle cx="18.5" cy="17" r="3.2"/><path d="M5.5 17l4-8h5l4 8M9.5 9l-1-3H6M14.5 9l2-2h2"/>',
  car: '<path d="M4 16v-4l2-5h12l2 5v4M4 16h16M4 16v2h3v-2M17 16v2h3v-2"/><circle cx="7.5" cy="13" r=".8"/><circle cx="16.5" cy="13" r=".8"/>',
  van: '<path d="M3 17V7h11v10M14 10h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  phone: '<path d="M6 3h3l2 5-2 1.5a11 11 0 0 0 5.5 5.5L16 13l5 2v3a3 3 0 0 1-3 3A15 15 0 0 1 3 6a3 3 0 0 1 3-3z"/>',
  doc: '<path d="M7 3h8l4 4v14H7zM15 3v4h4M10 12h6M10 16h6"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-4 3-6 7-6s7 2 7 6"/>',
  home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
};
export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  return span;
}
export const vehicleIcon = (v) => icon(v === 'car' ? 'car' : v === 'van' ? 'van' : 'bike');
