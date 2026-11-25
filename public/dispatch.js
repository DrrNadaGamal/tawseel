import { icon, vehicleIcon, initLang, h, t, api, login, session, logoSvg, state as L, fmtTime, fmtDateTime, fmtMoney, fmtNum, fmtDur, zoneName, driverName, toast, errText, STATUS_KEYS } from './common.js';

document.getElementById('logo').append(logoSvg());
const app = document.getElementById('app');
let S = null;               // last server state
let tab = 'board';
let poll = null;
const F = { q: '', status: '', zone: '', sla: '' };
let modalCount = 0;

// ---------------------------------------------------------------- auth gate
function gate() {
  clearInterval(poll);
  document.getElementById('rolePill').hidden = true;
  document.getElementById('logout').hidden = true;
  app.replaceChildren(h('div', { class: 'card pad', style: 'max-width:520px;margin:40px auto' },
    h('h1', { style: 'margin-bottom:6px' }, t('auth.title')),
    h('p', { class: 'mute', style: 'margin-top:0' }, t('auth.sub')),
    ...['admin', 'dispatcher', 'viewer'].map((r) => h('button', { class: 'btn ' + (r === 'dispatcher' ? 'amber' : 'ghost'), style: 'width:100%;margin-bottom:10px;justify-content:space-between', type: 'button', onclick: () => enter(r) }, h('b', null, t('role.' + r)), h('span', { style: 'font-weight:500;font-size:13px' }, t('role.' + r + '.d')))),
    h('p', { class: 'mute', style: 'font-size:12.5px' }, t('auth.demoNote'))));
}
async function enter(role) {
  try { await login(role); await load(); start(); } catch (e) { toast(errText(e), 'err'); }
}
function start() {
  const s = session.get();
  document.getElementById('rolePill').hidden = false;
  document.getElementById('rolePill').textContent = t('role.' + s.role);
  document.getElementById('logout').hidden = false;
  clearInterval(poll);
  poll = setInterval(() => { if (!document.hidden) load(true); }, 10000);
}
document.getElementById('logout').onclick = () => { session.clear(); S = null; gate(); };

async function load(silent) {
  try {
    S = await api('GET', 'state');
    if (S.role === 'driver') { session.clear(); S = null; return gate(); }
    banner(false);
    if (silent && tab === 'zones' && document.activeElement && document.activeElement.tagName === 'INPUT') return;
    render();
  } catch (e) {
    if (e.status === 401) { session.clear(); S = null; return gate(); }
    if (!silent) toast(errText(e), 'err');
    else banner(true);
  }
}
function banner(offline) {
  const el = document.getElementById('offBanner');
  if (el) el.hidden = !offline;
}

const can = (what) => {
  const r = S.role;
  if (what === 'write') return r === 'admin' || r === 'dispatcher';
  if (what === 'admin') return r === 'admin';
  return false;
};
const oById = (id) => S.orders.find((o) => o.id === id);
const sortNew = (a, b) => b.createdAt - a.createdAt;

// ---------------------------------------------------------------- render
function render() {
  if (!S) return;
  const act = document.activeElement;
  const keepId = act && act.dataset && act.dataset.keep;
  const kp = S.stats;
  const open = S.orders.filter((o) => ['new', 'assigned', 'accepted', 'picked_up', 'failed'].includes(o.status));
  const lateN = open.filter((o) => o.sla === 'late').length, riskN = open.filter((o) => o.sla === 'at_risk').length;
  const online = S.drivers.filter((d) => d.status === 'online').length;
  const kpi = (v, l, cls) => h('div', { class: 'card kpi ' + (cls || '') }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

  const root = h('div', null,
    h('div', { class: 'banner warn', id: 'offBanner', hidden: true, style: 'margin-top:12px' }, t('dash.offline')),
    h('div', { class: 'row', style: 'margin-top:16px' },
      h('h1', { style: 'font-size:24px' }, t('dash.title')),
      h('span', { class: 'mute', style: 'font-size:13px' }, t('dash.reset', { t: fmtTime(S.nextReset) })),
      h('span', { class: 'right row' },
        can('admin') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: resetDemo }, t('dash.resetNow')) : null,
        can('write') ? h('button', { class: 'btn amber', type: 'button', id: 'newBtn', onclick: createModal }, '+ ' + t('dash.newOrder')) : null)),
    h('div', { class: 'kpis' },
      kpi(fmtNum(S.stats.active), t('kpi.active')),
      kpi(fmtNum(S.orders.filter((o) => o.status === 'new').length), t('kpi.unassigned'), S.orders.some((o) => o.status === 'new') ? '' : ''),
      kpi(fmtNum(lateN) + ' / ' + fmtNum(riskN), t('kpi.lateRisk'), lateN ? 'warn' : ''),
      kpi(kp.onTimePct == null ? '-' : kp.onTimePct + '%', t('kpi.onTime')),
      kpi(kp.avgDeliveryMin == null ? '-' : fmtDur(kp.avgDeliveryMin), t('kpi.avg')),
      kpi(fmtNum(online) + '/' + fmtNum(S.drivers.length), t('kpi.drivers'))),
    tabs(),
    h('div', { id: 'pane' }, pane()));
  app.replaceChildren(root);
  if (keepId) { const el = app.querySelector('[data-keep="' + keepId + '"]'); if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch {} } }
}

function tabs() {
  const items = ['board', 'orders', 'drivers', 'zones', 'stats'];
  const el = h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('dash.sections') });
  for (const k of items) {
    const n = k === 'board' ? S.alerts.filter((a) => a.severity === 'high').length : 0;
    el.append(h('button', { class: 'tab', role: 'tab', id: 'tab-' + k, 'aria-selected': tab === k ? 'true' : 'false', onclick: () => { tab = k; render(); } }, t('tab.' + k), n ? h('span', { class: 'n' }, n) : null));
  }
  return el;
}

function pane() {
  return { board: boardPane, orders: ordersPane, drivers: driversPane, zones: zonesPane, stats: statsPane }[tab]();
}

// ---------------------------------------------------------------- cards
function slaChip(o) {
  if (['cancelled'].includes(o.status)) return null;
  if (o.status === 'delivered') return h('span', { class: 'chip ' + o.sla }, t('sla.' + o.sla));
  if (o.sla === 'ok' || o.sla === 'closed') return null;
  const mins = Math.round(Math.abs(S.now - (o.createdAt + o.slaMin * 60000)) / 60000);
  return h('span', { class: 'chip ' + o.sla }, o.sla === 'late' ? t('sla.lateBy', { m: fmtDur(mins) }) : t('sla.leftMin', { m: fmtDur(mins) }));
}
function orderCard(o) {
  const dn = o.driverId ? driverName(S.drivers, o.driverId) : null;
  return h('button', { class: 'ocard ' + (o.sla === 'late' || o.sla === 'at_risk' ? o.sla : ''), type: 'button', onclick: () => detailModal(o.id), 'data-order': o.id },
    h('div', { class: 'r1' }, h('b', { class: 'mono' }, o.id), h('span', { class: 'mute', style: 'font-size:12px' }, fmtTime(o.createdAt))),
    h('div', { class: 'r2' }, o.customer.name + ' · ' + zoneName(S.zones, o.zoneId)),
    h('div', { class: 'r3' },
      o.priority === 'express' ? h('span', { class: 'chip express' }, t('priority.express')) : null,
      o.payment === 'cod' ? h('span', { class: 'chip cod' }, 'COD ' + fmtMoney(o.amountDue)) : null,
      slaChip(o),
      o.status === 'failed' ? h('span', { class: 'chip failed' }, t('status.failed') + ' ' + o.attempts + '/' + S.constants.maxAttempts) : null,
      dn ? h('span', { class: 'chip' }, icon('user', 13), dn) : null));
}

function boardPane() {
  const by = (fn) => S.orders.filter(fn).sort(sortNew);
  const cols = [
    ['col.new', by((o) => o.status === 'new' || o.status === 'failed')],
    ['col.assigned', by((o) => o.status === 'assigned' || o.status === 'accepted')],
    ['col.onway', by((o) => o.status === 'picked_up')],
    ['col.done', by((o) => ['delivered', 'cancelled'].includes(o.status)).slice(0, 10)],
  ];
  const board = h('div', { class: 'board' }, cols.map(([k, list]) => h('div', { class: 'col', role: 'region', 'aria-label': t(k) }, h('h3', null, h('span', null, t(k)), h('span', { class: 'c' }, fmtNum(list.length))), list.length ? list.map(orderCard) : h('div', { class: 'empty' }, t('col.empty')))));
  const al = S.alerts;
  const alertBox = h('aside', { class: 'card alerts', 'aria-label': t('alerts.title') },
    h('div', { class: 'pad', style: 'padding-bottom:10px' }, h('h3', null, t('alerts.title') + ' (' + fmtNum(al.length) + ')')),
    al.length ? al.slice(0, 14).map((a) => h('button', { class: 'a', type: 'button', onclick: () => detailModal(a.orderId) }, h('span', { class: 'sev ' + a.severity }), h('span', null, h('b', null, a.orderId + ' · ' + t('alert.' + a.type)), h('span', { class: 'mute' }, alertDetail(a))))) : h('div', { class: 'empty' }, t('alerts.none')));
  return h('div', { class: 'layout' }, board, alertBox);
}
function alertDetail(a) {
  const o = oById(a.orderId);
  const z = o ? zoneName(S.zones, o.zoneId) : '';
  const m = a.minutes != null ? ' · ' + t('alert.min', { m: fmtDur(a.minutes) }) : '';
  const d = a.driverId ? ' · ' + driverName(S.drivers, a.driverId) : '';
  return z + m + d;
}

// ---------------------------------------------------------------- orders table
function ordersPane() {
  const rows = S.orders.filter((o) => {
    if (F.status && o.status !== F.status) return false;
    if (F.zone && o.zoneId !== F.zone) return false;
    if (F.sla && o.sla !== F.sla) return false;
    if (F.q) { const q = F.q.toLowerCase(); if (!(o.id + ' ' + o.code + ' ' + o.customer.name + ' ' + o.merchant).toLowerCase().includes(q)) return false; }
    return true;
  }).sort(sortNew);
  const sel = (key, label, opts) => h('select', { 'aria-label': label, onchange: (e) => { F[key] = e.target.value; render(); } }, h('option', { value: '' }, label), opts.map(([v, l]) => h('option', { value: v, selected: F[key] === v }, l)));
  const filters = h('div', { class: 'filters' },
    h('input', { type: 'search', 'data-keep': 'q', value: F.q, placeholder: t('f.search'), 'aria-label': t('f.search'), oninput: (e) => { F.q = e.target.value; render(); } }),
    sel('status', t('f.status'), STATUS_KEYS.map((s) => [s, t('status.' + s)])),
    sel('zone', t('f.zone'), S.zones.map((z) => [z.id, zoneName(S.zones, z.id)])),
    sel('sla', t('f.sla'), ['ok', 'at_risk', 'late', 'on_time', 'late_delivered'].map((s) => [s, t('sla.' + s)])));
  const tbl = h('table', null,
    h('thead', null, h('tr', null, ['th.order', 'th.code', 'th.customer', 'th.zone', 'th.status', 'th.sla', 'th.driver', 'th.fee', 'th.created'].map((k) => h('th', null, t(k))))),
    h('tbody', null, rows.length ? rows.map((o) => h('tr', { class: 'click', tabindex: 0, onclick: () => detailModal(o.id), onkeydown: (e) => { if (e.key === 'Enter') detailModal(o.id); } },
      h('td', { class: 'mono' }, o.id), h('td', { class: 'mono' }, o.code), h('td', null, o.customer.name), h('td', null, zoneName(S.zones, o.zoneId)),
      h('td', null, h('span', { class: 'chip ' + o.status }, t('status.' + o.status))), h('td', null, o.sla === 'ok' ? h('span', { class: 'mute' }, '-') : h('span', { class: 'chip ' + o.sla }, t('sla.' + o.sla))),
      h('td', null, o.driverId ? driverName(S.drivers, o.driverId) : '-'), h('td', null, fmtMoney(o.fee)), h('td', null, fmtTime(o.createdAt)))) : h('tr', null, h('td', { colspan: 9, class: 'empty' }, t('f.none')))));
  return h('div', { class: 'card pad' }, filters, h('div', { class: 'tbl-wrap' }, tbl), h('p', { class: 'mute', style: 'font-size:12.5px;margin-bottom:0' }, t('f.count', { n: fmtNum(rows.length), total: fmtNum(S.orders.length) })));
}

// ---------------------------------------------------------------- drivers
function driversPane() {
  const per = Object.fromEntries(S.stats.perDriver.map((p) => [p.driverId, p]));
  const tbl = h('table', null,
    h('thead', null, h('tr', null, ['th.driver', 'th.vehicle', 'th.zones', 'th.state', 'th.load', 'th.delivered', 'th.ontime', 'th.cash', ''].map((k) => h('th', null, k ? t(k) : '')))),
    h('tbody', null, S.drivers.map((d) => {
      const p = per[d.id] || {};
      return h('tr', null,
        h('td', null, h('b', null, driverName(S.drivers, d.id)), h('div', { class: 'mute mono', style: 'font-size:12px' }, d.phone)),
        h('td', null, t('vehicle.' + d.vehicle)),
        h('td', null, d.zones.map((z) => zoneName(S.zones, z)).join('، ')),
        h('td', null, h('span', { class: 'dot ' + d.status }), ' ', t('driver.' + d.status)),
        h('td', null, d.active + '/' + S.settings.maxActivePerDriver),
        h('td', null, fmtNum(p.delivered || 0)),
        h('td', null, p.onTimePct == null ? '-' : p.onTimePct + '%'),
        h('td', null, fmtMoney(p.cash || 0)),
        h('td', null, can('write') ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => setDriverStatus(d) }, d.status === 'online' ? t('driver.setOffline') : t('driver.setOnline')) : null));
    })));
  return h('div', { class: 'card pad' }, h('div', { class: 'tbl-wrap' }, tbl), h('p', { class: 'mute', style: 'font-size:12.5px' }, t('drivers.note')));
}
async function setDriverStatus(d) {
  try { await api('POST', 'drivers/' + d.id + '/status', { status: d.status === 'online' ? 'offline' : 'online' }); await load(); } catch (e) { toast(errText(e), 'err'); }
}

// ---------------------------------------------------------------- zones & fees
function zonesPane() {
  const per = Object.fromEntries(S.stats.perZone.map((p) => [p.zoneId, p]));
  const admin = can('admin');
  const rows = S.zones.map((z) => {
    const p = per[z.id] || {};
    const fee = h('input', { type: 'number', min: 0, max: 500, value: z.baseFee, disabled: !admin, 'aria-label': t('z.base') + ' ' + zoneName(S.zones, z.id), style: 'width:90px' });
    const sla = h('input', { type: 'number', min: 20, max: 360, value: z.slaMin, disabled: !admin, 'aria-label': t('z.sla') + ' ' + zoneName(S.zones, z.id), style: 'width:90px' });
    return h('tr', null, h('td', null, h('b', null, zoneName(S.zones, z.id))), h('td', null, fee), h('td', null, sla), h('td', null, fmtNum(p.orders || 0)), h('td', null, p.avgMin == null ? '-' : fmtDur(p.avgMin)), h('td', null, p.latePct == null ? '-' : p.latePct + '%'),
      h('td', null, admin ? h('button', { class: 'btn sm', type: 'button', onclick: async (ev) => { ev.target.disabled = true; try { await api('PUT', 'zones/' + z.id, { baseFee: fee.value, slaMin: sla.value }); toast(t('z.saved')); await load(); } catch (e) { toast(e.status === 422 ? t('z.invalid') : errText(e), 'err'); ev.target.disabled = false; } } }, t('z.save')) : null));
  });
  const s = S.settings;
  const sf = (key, label) => h('div', { class: 'field' }, h('label', { for: 's-' + key }, label), h('input', { id: 's-' + key, type: 'number', value: s[key], disabled: !admin, 'data-set': key }));
  const settings = h('div', { class: 'card pad' }, h('h3', { style: 'margin-bottom:12px' }, t('z.rules')),
    h('div', { class: 'grid2' }, sf('freeDeliveryOver', t('s.free')), sf('nightSurcharge', t('s.night')), sf('expressMultiplierPct', t('s.express')), sf('perExtraKg', t('s.perKg')), sf('maxActivePerDriver', t('s.cap'))),
    h('p', { class: 'mute', style: 'font-size:13px' }, t('s.notes', { w: s.freeWeightKg, a: s.nightStartHour, b: s.nightEndHour, c: s.codFeePct, mn: s.codFeeMin, mx: s.codFeeMax })),
    admin ? h('button', { class: 'btn', type: 'button', onclick: async () => { const body = {}; settings.querySelectorAll('[data-set]').forEach((i) => { body[i.dataset.set] = i.value; }); try { await api('PUT', 'settings', body); toast(t('z.saved')); await load(); } catch (e) { toast(e.status === 422 ? t('z.invalid') : errText(e), 'err'); } } }, t('z.save')) : h('p', { class: 'mute' }, t('z.adminOnly')));
  return h('div', { class: 'two' },
    h('div', { class: 'card pad' }, h('h3', { style: 'margin-bottom:12px' }, t('z.title')), h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['z.zone', 'z.base', 'z.sla', 'z.orders', 'z.avg', 'z.late', ''].map((k) => h('th', null, k ? t(k) : '')))), h('tbody', null, rows)))),
    settings);
}

// ---------------------------------------------------------------- stats
function statsPane() {
  const st = S.stats;
  const maxB = Math.max(1, ...st.buckets.map((b) => Math.max(b.created, b.delivered)));
  const bars = h('div', { class: 'bars', role: 'img', 'aria-label': t('stats.hourly') }, st.buckets.flatMap((b) => [h('div', { class: 'b', style: 'height:' + (b.created / maxB * 100) + '%', title: fmtTime(b.hourStart) + ': ' + b.created }), h('div', { class: 'b d', style: 'height:' + (b.delivered / maxB * 100) + '%', title: fmtTime(b.hourStart) + ': ' + b.delivered })]));
  const zoneRows = st.perZone.filter((z) => z.delivered).sort((a, b) => (b.latePct || 0) - (a.latePct || 0)).map((z) => h('div', { style: 'margin:10px 0' }, h('div', { class: 'row' }, h('b', null, zoneName(S.zones, z.zoneId)), h('span', { class: 'right mute' }, t('stats.lateOf', { p: z.latePct, n: z.delivered }))), h('div', { class: 'hbar bad' }, h('i', { style: 'width:' + Math.max(2, z.latePct) + '%' }))));
  const drvRows = st.perDriver.map((p) => h('tr', null, h('td', null, driverName(S.drivers, p.driverId)), h('td', null, fmtNum(p.delivered)), h('td', null, p.onTimePct == null ? '-' : p.onTimePct + '%'), h('td', null, p.avgMin == null ? '-' : fmtDur(p.avgMin)), h('td', null, fmtNum(p.failed)), h('td', null, fmtMoney(p.cash))));
  return h('div', { class: 'two' },
    h('div', { class: 'card pad' }, h('h3', null, t('stats.hourly')), h('div', { class: 'row mute', style: 'font-size:12.5px;margin:6px 0 12px' }, h('span', null, h('span', { class: 'dot', style: 'background:var(--amber)' }), ' ' + t('stats.created')), h('span', null, h('span', { class: 'dot', style: 'background:var(--teal)' }), ' ' + t('stats.delivered'))), bars,
      h('div', { class: 'kpis', style: 'margin-bottom:0' }, h('div', { class: 'kpi' }, h('div', { class: 'v' }, fmtMoney(st.feeRevenue)), h('div', { class: 'l' }, t('stats.fees'))), h('div', { class: 'kpi' }, h('div', { class: 'v' }, fmtMoney(st.cashCollected)), h('div', { class: 'l' }, t('stats.cash'))), h('div', { class: 'kpi' }, h('div', { class: 'v' }, st.failedAttemptPct == null ? '-' : st.failedAttemptPct + '%'), h('div', { class: 'l' }, t('stats.failed'))))),
    h('div', { class: 'card pad' }, h('h3', null, t('stats.zoneLate')), zoneRows.length ? zoneRows : h('div', { class: 'empty' }, t('f.none'))),
    h('div', { class: 'card pad', style: 'grid-column:1/-1' }, h('h3', { style: 'margin-bottom:10px' }, t('stats.drivers')), h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['th.driver', 'th.delivered', 'th.ontime', 'stats.avg', 'stats.failedN', 'th.cash'].map((k) => h('th', null, t(k))))), h('tbody', null, drvRows)))));
}

// ---------------------------------------------------------------- modals
function modal(title, body, opts = {}) {
  const prev = document.activeElement;
  const scrim = h('div', { class: 'scrim', role: 'presentation' });
  const close = () => { scrim.remove(); modalCount--; if (prev && prev.focus) prev.focus(); };
  const box = h('div', { class: 'modal ' + (opts.wide ? 'wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h2', null, h('span', null, title), h('button', { class: 'x', type: 'button', 'aria-label': t('close'), onclick: close }, '×')), body);
  scrim.append(box);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(scrim);
  modalCount++;
  const f = box.querySelector('input,select,textarea,button.btn');
  (opts.focus ? box.querySelector(opts.focus) : f)?.focus();
  return close;
}

function feeLines(lines, total) {
  return h('div', { class: 'quote', 'aria-live': 'polite' },
    lines.map((l) => h('div', { class: 'l' }, h('span', null, t('fee.' + l.key)), h('span', null, (l.amount < 0 ? '-' : '') + fmtMoney(Math.abs(l.amount))))),
    h('div', { class: 'l tot' }, h('span', null, t('fee.total')), h('span', null, fmtMoney(total))));
}

function detailModal(id) {
  const o = oById(id);
  if (!o) return;
  const body = h('div', null);
  const closeRef = {};
  const dn = o.driverId ? driverName(S.drivers, o.driverId) : '-';
  body.append(
    h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'chip ' + o.status }, t('status.' + o.status)), slaChip(o), o.priority === 'express' ? h('span', { class: 'chip express' }, t('priority.express')) : null, h('span', { class: 'mono right' }, o.code)),
    h('div', { class: 'grid2', style: 'font-size:14px' },
      h('div', null, h('div', { class: 'mute' }, t('d.customer')), h('b', null, o.customer.name), h('div', { class: 'mono' }, o.customer.phone)),
      h('div', null, h('div', { class: 'mute' }, t('d.address')), h('b', null, o.street), h('div', null, zoneName(S.zones, o.zoneId))),
      h('div', null, h('div', { class: 'mute' }, t('d.merchant')), h('b', null, o.merchant), h('div', null, t('d.items', { n: o.items, w: o.weightKg }))),
      h('div', null, h('div', { class: 'mute' }, t('d.driver')), h('b', null, dn), h('div', null, t('d.sla', { m: fmtDur(o.slaMin) })))),
    o.notes ? h('p', { class: 'mute' }, t('d.notes') + ': ' + o.notes) : null,
    o.payment === 'cod' ? h('div', { class: 'banner info', style: 'margin:10px 0' }, t('d.cod', { a: fmtMoney(o.amountDue) }), o.cashMismatch ? h('b', null, ' · ' + t('d.mismatch', { c: fmtMoney(o.cashCollected) })) : null) : h('div', { class: 'banner info', style: 'margin:10px 0' }, t('d.prepaid')),
    o.proofNote ? h('p', null, h('b', null, t('d.proof') + ': '), o.proofNote) : null,
    feeLines(o.feeLines, o.fee));
  const tl = h('ul', { class: 'tl', style: 'margin-top:16px' });
  for (const e of [...o.events].reverse()) tl.append(h('li', null, h('b', null, t('ev.' + e.action)), ' ', h('span', { class: 'mute' }, fmtDateTime(e.at) + (e.by && e.by !== 'system' ? ' · ' + evBy(e.by) : '')), e.note ? h('div', { class: 'mute' }, evNote(e.note)) : null));
  body.append(h('h3', { style: 'margin-top:16px' }, t('d.history')), tl);
  if (can('write')) {
    const acts = h('div', { class: 'row', style: 'margin-top:8px' });
    const st = o.status;
    if (['new', 'assigned', 'accepted'].includes(st)) acts.append(h('button', { class: 'btn amber', type: 'button', onclick: () => { closeRef.c(); assignModal(o.id); } }, st === 'new' ? t('a.assign') : t('a.reassign')));
    if (['assigned', 'accepted'].includes(st)) acts.append(h('button', { class: 'btn ghost', type: 'button', onclick: () => quick(o, 'unassign', closeRef) }, t('a.unassign')));
    if (st === 'failed') acts.append(h('button', { class: 'btn amber', type: 'button', disabled: o.attempts >= S.constants.maxAttempts, onclick: () => quick(o, 'redispatch', closeRef) }, t('a.redispatch')), o.attempts >= S.constants.maxAttempts ? h('span', { class: 'mute' }, t('a.maxAttempts')) : null);
    if (['new', 'assigned', 'accepted', 'failed'].includes(st)) acts.append(h('button', { class: 'btn red right', type: 'button', onclick: () => { closeRef.c(); cancelModal(o.id); } }, t('a.cancel')));
    body.append(acts);
  } else body.append(h('p', { class: 'mute' }, t('readonly')));
  closeRef.c = modal(o.id + ' · ' + zoneName(S.zones, o.zoneId), body, { wide: true });
}
const evBy = (by) => by.startsWith('driver:') ? t('role.driver') : t('role.' + by);
function evNote(n) {
  const m = n.match(/^([a-z_]+)(?:: (.*))?$/);
  if (m && L && (['no_answer', 'wrong_address', 'refused', 'unreachable', 'customer_request', 'merchant_request', 'duplicate', 'out_of_zone', 'outside_driver_zones', 'other'].includes(m[1]))) return t('reason.' + m[1]) + (m[2] ? ': ' + m[2] : '');
  return n;
}
async function quick(o, action, closeRef, body = {}) {
  try { await api('POST', 'orders/' + o.id + '/' + action, body); closeRef.c && closeRef.c(); toast(t('toast.done')); await load(); } catch (e) { toast(errText(e), 'err'); await load(true); }
}

function assignModal(id) {
  const o = oById(id);
  const ref = {};
  const list = S.drivers.map((d) => ({ d, match: d.zones.includes(o.zoneId), full: d.active >= S.settings.maxActivePerDriver && d.id !== o.driverId }))
    .sort((a, b) => (b.d.status === 'online') - (a.d.status === 'online') || b.match - a.match || a.d.active - b.d.active);
  const body = h('div', null, h('p', { class: 'mute', style: 'margin-top:0' }, t('as.sub', { z: zoneName(S.zones, o.zoneId) })),
    list.map(({ d, match, full }) => h('button', { class: 'btn ghost', type: 'button', disabled: d.status === 'offline' || full || d.id === o.driverId, style: 'width:100%;justify-content:space-between;margin-bottom:8px;text-align:start', 'data-driver': d.id,
      onclick: async () => { try { await api('POST', 'orders/' + o.id + '/assign', { driverId: d.id }); ref.c(); toast(t('toast.assigned', { n: driverName(S.drivers, d.id) })); await load(); } catch (e) { toast(errText(e), 'err'); await load(true); } } },
      h('span', null, h('span', { class: 'dot ' + d.status }), ' ', h('b', null, driverName(S.drivers, d.id)), ' ', h('span', { class: 'mute' }, t('vehicle.' + d.vehicle))),
      h('span', { class: 'row' }, match ? h('span', { class: 'chip ok' }, t('as.zoneMatch')) : h('span', { class: 'chip at_risk' }, t('as.outside')), h('span', { class: 'chip' }, d.active + '/' + S.settings.maxActivePerDriver), d.status === 'offline' ? h('span', { class: 'chip closed' }, t('driver.offline')) : null))));
  ref.c = modal(t('a.assign') + ' · ' + o.id, body);
}

function cancelModal(id) {
  const o = oById(id);
  const ref = {};
  const reason = h('select', { id: 'cr' }, S.constants.cancelReasons.map((r) => h('option', { value: r }, t('reason.' + r))));
  const note = h('input', { id: 'cn', maxlength: 160, placeholder: t('note.optional') });
  const err = h('div', { class: 'err', role: 'alert' });
  const body = h('div', null, h('p', null, t('cancel.sure', { id: o.id })), h('div', { class: 'field' }, h('label', { for: 'cr' }, t('cancel.reason')), reason), h('div', { class: 'field' }, h('label', { for: 'cn' }, t('note.label')), note), err,
    h('div', { class: 'row' }, h('button', { class: 'btn red', type: 'button', onclick: async () => { try { await api('POST', 'orders/' + o.id + '/cancel', { reason: reason.value, note: note.value }); ref.c(); toast(t('toast.cancelled')); await load(); } catch (e) { err.textContent = e.message === 'note_required' ? t('err.note_required') : errText(e); } } }, t('a.cancel')), h('button', { class: 'btn ghost', type: 'button', onclick: () => ref.c() }, t('keep'))));
  ref.c = modal(t('a.cancel') + ' · ' + o.id, body);
}

function createModal() {
  const ref = {};
  const f = {};
  const field = (key, label, el, extra) => { f[key] = el; return h('div', { class: 'field' }, h('label', { for: 'n-' + key }, label), el, h('div', { class: 'err', id: 'e-' + key, role: 'alert' }), extra); };
  const inp = (key, attrs = {}) => h('input', { id: 'n-' + key, name: key, autocomplete: 'off', ...attrs });
  const quoteBox = h('div', { id: 'quoteBox' });
  const refresh = debounce(async () => {
    const body = vals();
    try {
      const q = await api('POST', 'quote', body);
      quoteBox.replaceChildren(feeLines(q.lines, q.fee), h('p', { class: 'mute', style: 'font-size:12.5px;margin:6px 0 0' }, body.payment === 'cod' ? t('n.codDue', { a: fmtMoney(Number(body.subtotal) + q.fee) }) : t('n.paidNote')));
    } catch { quoteBox.replaceChildren(h('p', { class: 'mute' }, t('n.quoteWait'))); }
  }, 250);
  const vals = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === 'checkbox' ? el.checked : el.value]));
  const zoneSel = h('select', { id: 'n-zoneId', name: 'zoneId' }, h('option', { value: '' }, t('n.pickZone')), S.zones.map((z) => h('option', { value: z.id }, zoneName(S.zones, z.id) + ' · ' + fmtMoney(z.baseFee))));
  const prio = h('select', { id: 'n-priority' }, h('option', { value: 'standard' }, t('priority.standard')), h('option', { value: 'express' }, t('priority.express')));
  const pay = h('select', { id: 'n-payment' }, h('option', { value: 'cod' }, t('pay.cod')), h('option', { value: 'paid' }, t('pay.paid')));
  const form = h('form', { novalidate: true, id: 'newForm' },
    h('div', { class: 'grid2' }, field('customerName', t('n.name'), inp('customerName', { maxlength: 60 })), field('customerPhone', t('n.phone'), inp('customerPhone', { inputmode: 'tel', placeholder: '01012345678' }))),
    h('div', { class: 'grid2' }, field('merchant', t('n.merchant'), inp('merchant', { maxlength: 60 })), field('zoneId', t('n.zone'), zoneSel)),
    field('street', t('n.street'), inp('street', { maxlength: 140 })),
    h('div', { class: 'grid2' }, field('weightKg', t('n.weight'), inp('weightKg', { type: 'number', step: '0.5', min: '0.5', max: '60', value: '2' })), field('subtotal', t('n.subtotal'), inp('subtotal', { type: 'number', min: '0', value: '350' }))),
    h('div', { class: 'grid2' }, field('priority', t('n.priority'), prio), field('payment', t('n.payment'), pay)),
    field('notes', t('n.notes'), inp('notes', { maxlength: 160 })),
    h('h3', { style: 'margin-top:4px' }, t('n.quote')), quoteBox,
    h('div', { class: 'row', style: 'margin-top:16px' }, h('button', { class: 'btn amber', type: 'submit', id: 'createSubmit' }, t('n.create')), h('button', { class: 'btn ghost', type: 'button', onclick: () => ref.c() }, t('keep'))));
  f.items = { value: 1 };
  form.addEventListener('input', () => { form.querySelectorAll('.err').forEach((e) => (e.textContent = '')); form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid')); if (f.zoneId.value) refresh(); });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('#createSubmit');
    btn.disabled = true;
    try {
      const r = await api('POST', 'orders', vals());
      ref.c();
      toast(t('toast.created', { id: r.order.id, code: r.order.code }));
      await load();
    } catch (e) {
      btn.disabled = false;
      if (e.status === 422 && e.data.fields) {
        let first = null;
        for (const [k, v] of Object.entries(e.data.fields)) { const el = f[k]; const m = form.querySelector('#e-' + k); if (el && m) { m.textContent = t('v.' + v); el.setAttribute('aria-invalid', 'true'); first ||= el; } }
        first?.focus();
      } else toast(errText(e), 'err');
    }
  });
  ref.c = modal(t('dash.newOrder'), form, { wide: true, focus: '#n-customerName' });
  quoteBox.replaceChildren(h('p', { class: 'mute' }, t('n.quoteWait')));
}
function debounce(fn, ms) { let tm; return (...a) => { clearTimeout(tm); tm = setTimeout(() => fn(...a), ms); }; }

async function resetDemo() {
  if (!confirm(t('dash.resetConfirm'))) return;
  try { await api('POST', 'reset'); toast(t('toast.reset')); await load(); } catch (e) { toast(errText(e), 'err'); }
}

// ---------------------------------------------------------------- boot
initLang(() => { if (S) { start(); render(); } else gate(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  const s = session.get();
  if (s && s.role !== 'driver') { await load(); if (S) start(); } else gate();
})();
