import { icon, vehicleIcon, initLang, h, t, api, login, session, logoSvg, state as L, fmtTime, fmtMoney, fmtNum, fmtDur, zoneName, toast, errText } from './common.js';

document.getElementById('logo').append(logoSvg());
const app = document.getElementById('app');
const QKEY = 'tws_queue', CKEY = 'tws_driver_cache';
let S = null, poll = null, online = navigator.onLine, flushing = false, showDone = false;

const readQ = () => { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch { return []; } };
const writeQ = (q) => localStorage.setItem(QKEY, JSON.stringify(q));
const uid = () => 'a-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// ------------------------------------------------------------ login
async function gate() {
  clearInterval(poll);
  document.getElementById('logout').hidden = true;
  app.replaceChildren(h('div', { class: 'dcard' }, h('h2', null, t('drv.pick')), h('p', { class: 'mute', style: 'color:#64748b' }, t('drv.pickSub')), h('div', { id: 'dl' }, h('div', { class: 'empty' }, '…'))));
  try {
    const r = await api('GET', 'demo-drivers');
    document.getElementById('dl').replaceChildren(...r.drivers.map((d) => h('button', { class: 'btn ' + (d.status === 'online' ? 'amber' : 'ghost'), type: 'button', style: 'width:100%;justify-content:space-between;margin-bottom:10px;min-height:52px', 'data-driver': d.id, onclick: () => enter(d.id) }, h('b', null, L.lang === 'ar' ? d.ar : d.name), h('span', { style: 'font-weight:500;font-size:13px' }, t('vehicle.' + d.vehicle)))));
  } catch (e) { document.getElementById('dl').replaceChildren(h('div', { class: 'err' }, errText(e))); }
}
async function enter(id) {
  try { await login('driver', id); await load(); begin(); } catch (e) { toast(errText(e), 'err'); }
}
function begin() {
  document.getElementById('logout').hidden = false;
  clearInterval(poll);
  poll = setInterval(() => { if (!document.hidden) { flush().then(() => load(true)); } }, 12000);
}
document.getElementById('logout').onclick = () => { if (readQ().length && !confirm(t('drv.logoutPending'))) return; session.clear(); S = null; gate(); };

// ------------------------------------------------------------ data
async function load(silent) {
  try {
    const s = await api('GET', 'state');
    if (s.role !== 'driver') { session.clear(); return gate(); }
    online = true;
    S = s;
    localStorage.setItem(CKEY, JSON.stringify({ at: Date.now(), driverId: s.driverId, s }));
    render();
  } catch (e) {
    if (e.status === 401) { session.clear(); S = null; return gate(); }
    if (e.network) {
      online = false;
      if (!S) { try { const c = JSON.parse(localStorage.getItem(CKEY) || 'null'); const ses = session.get(); if (c && ses && c.driverId === ses.driverId) S = c.s; } catch {} }
      if (S) { applyQueueLocally(); render(); return; }
    }
    if (!silent) toast(errText(e), 'err');
  }
}

// optimistic local changes so the screen stays honest offline
const NEXT = { accept: 'accepted', pickup: 'picked_up', deliver: 'delivered', fail: 'failed', decline: 'new' };
function applyLocal(q) {
  const o = S.orders.find((x) => x.id === q.orderId);
  if (!o) return;
  o.status = NEXT[q.action];
  o.pendingSync = true;
  if (q.action === 'decline') o.driverId = null;
  if (q.action === 'deliver') { o.deliveredAt = Date.now(); o.proofNote = q.body.note; }
}
function applyQueueLocally() { for (const q of readQ()) applyLocal(q); }
const me = () => S.drivers.find((d) => d.id === S.driverId);
const mine = () => S.orders.filter((o) => o.driverId === S.driverId || (o.status === 'new' && false));

async function act(o, action, body) {
  const item = { id: uid(), orderId: o.id, action, body: { ...body, clientActionId: null }, at: Date.now() };
  item.body.clientActionId = item.id;
  try {
    await api('POST', 'orders/' + o.id + '/' + action, item.body);
    toast(t('toast.done'));
    await load();
  } catch (e) {
    if (e.network) {
      const q = readQ(); q.push(item); writeQ(q);
      online = false;
      if (S) { applyLocal(item); render(); }
      toast(t('drv.savedOffline'), 'ok');
    } else {
      toast(errText(e), 'err');
      await load(true);
    }
  }
}

async function flush() {
  if (flushing) return;
  let q = readQ();
  if (!q.length) return;
  flushing = true;
  const dropped = [];
  try {
    while (q.length) {
      const it = q[0];
      try {
        await api('POST', 'orders/' + it.orderId + '/' + it.action, it.body);
        q.shift(); writeQ(q);
      } catch (e) {
        if (e.network) { online = false; break; }
        if (e.status === 401) break;
        dropped.push({ it, err: e.message });   // server refused (e.g. order was reassigned): drop and tell the driver
        q.shift(); writeQ(q);
      }
    }
  } finally { flushing = false; }
  if (dropped.length) toast(t('drv.syncRejected', { n: dropped.length }), 'err');
  else if (!readQ().length && online) toast(t('drv.synced'));
  await load(true);
}
window.addEventListener('online', () => { online = true; flush().then(() => load(true)); });
window.addEventListener('offline', () => { online = false; if (S) render(); });

// ------------------------------------------------------------ render
function slaChip(o) {
  if (o.sla === 'ok' || o.sla === 'closed') return null;
  const mins = Math.round(Math.abs(S.now - (o.createdAt + o.slaMin * 60000)) / 60000);
  return h('span', { class: 'chip ' + o.sla }, o.sla === 'late' ? t('sla.lateBy', { m: fmtDur(mins) }) : t('sla.leftMin', { m: fmtDur(mins) }));
}
function taskCard(o) {
  const z = zoneName(S.zones, o.zoneId);
  const card = h('article', { class: 'dcard', 'data-order': o.id, 'aria-label': o.id },
    h('div', { class: 'row' }, h('span', { class: 'code mono' }, o.id), h('span', { class: 'chip ' + o.status }, t('status.' + o.status)), o.priority === 'express' ? h('span', { class: 'chip express' }, t('priority.express')) : null, slaChip(o), o.pendingSync ? h('span', { class: 'chip at_risk' }, t('drv.pending')) : null),
    h('div', { class: 'addr' }, o.street), h('div', { class: 'mute', style: 'color:#475569' }, z + ' · ' + o.customer.name),
    h('div', { style: 'margin-top:8px;font-size:14px' }, h('b', null, t('drv.pickup') + ': '), o.merchant),
    o.notes ? h('div', { style: 'font-size:14px;color:#475569' }, t('d.notes') + ': ' + o.notes) : null,
    o.payment === 'cod' ? h('div', { class: 'cash' }, t('drv.collect', { a: fmtMoney(o.amountDue) })) : h('div', { class: 'cash', style: 'background:#dcfce7;color:#166534' }, t('drv.prepaid')),
    h('a', { class: 'btn ghost', style: 'width:100%;border-color:#cbd5e1;color:#0f172a', href: 'tel:' + o.customer.phone }, icon('phone', 18), t('drv.call') + ' ' + o.customer.name));
  const acts = h('div', { class: 'acts' });
  if (o.pendingSync) { acts.append(h('div', { class: 'mute', style: 'color:#64748b;font-size:13px' }, t('drv.waitSync'))); }
  else if (o.status === 'assigned') {
    acts.className = 'acts two';
    acts.append(h('button', { class: 'btn green lg', type: 'button', 'data-act': 'accept', onclick: () => act(o, 'accept', {}) }, t('drv.accept')), h('button', { class: 'btn ghost lg', style: 'border-color:#cbd5e1;color:#0f172a', type: 'button', 'data-act': 'decline', onclick: () => declineSheet(o) }, t('drv.decline')));
  } else if (o.status === 'accepted') acts.append(h('button', { class: 'btn amber lg', type: 'button', 'data-act': 'pickup', onclick: () => act(o, 'pickup', {}) }, t('drv.picked')));
  else if (o.status === 'picked_up') {
    acts.className = 'acts two';
    acts.append(h('button', { class: 'btn green lg', type: 'button', 'data-act': 'deliver', onclick: () => deliverSheet(o) }, t('drv.delivered')), h('button', { class: 'btn ghost lg', style: 'border-color:#cbd5e1;color:#0f172a', type: 'button', 'data-act': 'fail', onclick: () => failSheet(o) }, t('drv.failed')));
  }
  card.append(acts);
  return card;
}

function render() {
  if (!S) return;
  if (document.querySelector('.scrim')) { /* keep sheets open; underlying list refreshes silently */ }
  const d = me();
  const q = readQ();
  const open = S.orders.filter((x) => ['assigned', 'accepted', 'picked_up'].includes(x.status) || (x.pendingSync && x.status !== 'delivered'));
  const rank = { picked_up: 0, accepted: 1, assigned: 2 };
  open.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.createdAt - b.createdAt);
  const done = S.orders.filter((x) => x.status === 'delivered').sort((a, b) => b.deliveredAt - a.deliveredAt);
  const cash = done.reduce((s, o) => s + (o.cashCollected || 0), 0);
  const root = h('div', null,
    h('div', { class: 'dr-bar' },
      h('div', null, h('b', null, L.lang === 'ar' ? d.ar : d.name), h('div', { class: 'mute', style: 'font-size:12px' }, t('vehicle.' + d.vehicle))),
      h('span', { class: 'sp' }),
      h('span', { class: 'sync', style: 'color:' + (online ? '#4ade80' : '#fbbf24'), 'data-sync': online ? 'online' : 'offline' }, online ? '● ' + t('drv.online') : '○ ' + t('drv.offlineNet')),
      h('button', { class: 'switch', type: 'button', id: 'shift', 'aria-pressed': d.status === 'online' ? 'true' : 'false', onclick: toggleShift }, h('span', { class: 'dot ' + d.status }), ' ', d.status === 'online' ? t('drv.onShift') : t('drv.offShift'))),
    q.length ? h('div', { class: 'banner warn', id: 'queueBanner', style: 'margin-bottom:12px' }, t('drv.queued', { n: q.length }), h('button', { class: 'btn amber sm', type: 'button', onclick: () => flush() }, t('drv.syncNow'))) : null,
    !online && !q.length ? h('div', { class: 'banner warn', style: 'margin-bottom:12px' }, t('drv.offlineHint')) : null,
    d.status === 'offline' ? h('div', { class: 'banner warn', style: 'margin-bottom:12px' }, t('drv.offShiftHint')) : null,
    h('div', { class: 'dr-h' }, t('drv.active') + ' (' + fmtNum(open.length) + ')'),
    open.length ? open.map(taskCard) : h('div', { class: 'empty' }, d.status === 'online' ? t('drv.none') : t('drv.noneOff')),
    h('div', { class: 'dr-h' }, t('drv.today') + ' · ' + fmtNum(done.length) + ' · ' + fmtMoney(cash)),
    h('button', { class: 'btn ghost sm', type: 'button', style: 'color:#e2e8f0;border-color:#334155;margin-bottom:10px', onclick: () => { showDone = !showDone; render(); } }, showDone ? t('drv.hide') : t('drv.show')),
    showDone ? done.slice(0, 12).map((o) => h('div', { class: 'dcard', style: 'padding:12px 14px;opacity:.9' }, h('div', { class: 'row' }, h('b', { class: 'mono' }, o.id), h('span', { class: 'chip ' + (o.sla || 'ok') }, t('sla.' + (o.sla === 'late_delivered' ? 'late_delivered' : 'on_time'))), h('span', { class: 'right mute', style: 'color:#64748b' }, fmtTime(o.deliveredAt))), h('div', { style: 'font-size:14px;color:#475569' }, o.street))) : null);
  app.replaceChildren(root);
}
async function toggleShift() {
  const d = me();
  try { await api('POST', 'drivers/' + d.id + '/status', { status: d.status === 'online' ? 'offline' : 'online' }); await load(); }
  catch (e) { toast(e.message === 'has_active_orders' ? t('err.has_active_orders') : errText(e), 'err'); }
}

// ------------------------------------------------------------ sheets
function sheet(title, body) {
  const prev = document.activeElement;
  const scrim = h('div', { class: 'scrim', style: 'align-items:flex-end', role: 'presentation' });
  const close = () => { scrim.remove(); prev?.focus?.(); };
  const box = h('div', { class: 'modal', style: 'border-radius:22px 22px 0 0;color:#0f172a', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', null, h('span', null, title), h('button', { class: 'x', type: 'button', 'aria-label': t('close'), onclick: close }, '×')), body);
  scrim.append(box);
  scrim.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(scrim);
  box.querySelector('input,select,textarea')?.focus();
  return close;
}
function declineSheet(o) {
  const note = h('input', { id: 'dn', maxlength: 160, placeholder: t('drv.declineWhy') });
  const err = h('div', { class: 'err', role: 'alert' });
  let close;
  const body = h('div', null, h('div', { class: 'field' }, h('label', { for: 'dn' }, t('drv.declineWhy')), note), err, h('button', { class: 'btn red lg', style: 'width:100%', type: 'button', onclick: async () => { if (note.value.trim().length < 3) { err.textContent = t('err.note_required'); note.setAttribute('aria-invalid', 'true'); return; } close(); await act(o, 'decline', { note: note.value }); } }, t('drv.decline')));
  close = sheet(t('drv.decline') + ' · ' + o.id, body);
}
function failSheet(o) {
  const reason = h('select', { id: 'fr' }, S.constants.failReasons.map((r) => h('option', { value: r }, t('reason.' + r))));
  const note = h('input', { id: 'fn', maxlength: 160, placeholder: t('note.optional') });
  const err = h('div', { class: 'err', role: 'alert' });
  let close;
  const body = h('div', null, h('div', { class: 'field' }, h('label', { for: 'fr' }, t('drv.failReason')), reason), h('div', { class: 'field' }, h('label', { for: 'fn' }, t('note.label')), note), err,
    h('button', { class: 'btn red lg', style: 'width:100%', type: 'button', onclick: async () => { if (reason.value === 'other' && note.value.trim().length < 4) { err.textContent = t('err.note_required'); note.setAttribute('aria-invalid', 'true'); return; } close(); await act(o, 'fail', { reason: reason.value, note: note.value }); } }, t('drv.failed')));
  close = sheet(t('drv.failed') + ' · ' + o.id, body);
}
function deliverSheet(o) {
  const proof = h('input', { id: 'dp', maxlength: 200, placeholder: t('drv.proofPh') });
  const rec = h('input', { id: 'dr', maxlength: 60, value: o.customer.name });
  const cash = h('input', { id: 'dc', type: 'number', inputmode: 'decimal', value: o.amountDue || '' });
  const errP = h('div', { class: 'err', role: 'alert' }), errC = h('div', { class: 'err', role: 'alert' });
  let close;
  const body = h('div', null,
    h('div', { class: 'field' }, h('label', { for: 'dp' }, t('drv.proof')), proof, errP),
    h('div', { class: 'field' }, h('label', { for: 'dr' }, t('drv.recipient')), rec),
    o.payment === 'cod' ? h('div', { class: 'field' }, h('label', { for: 'dc' }, t('drv.cashCollected', { a: fmtMoney(o.amountDue) })), cash, errC) : null,
    h('button', { class: 'btn green lg', style: 'width:100%', type: 'button', id: 'confirmDeliver', onclick: async () => {
      errP.textContent = errC.textContent = ''; proof.removeAttribute('aria-invalid'); cash.removeAttribute('aria-invalid');
      let bad = false;
      if (proof.value.trim().length < 4) { errP.textContent = t('err.proof_required'); proof.setAttribute('aria-invalid', 'true'); bad = true; }
      if (o.payment === 'cod' && (cash.value === '' || !Number.isFinite(Number(cash.value)) || Number(cash.value) < 0)) { errC.textContent = t('err.cash_required'); cash.setAttribute('aria-invalid', 'true'); bad = true; }
      if (bad) return;
      if (o.payment === 'cod' && Number(cash.value) !== o.amountDue && !confirm(t('drv.cashDiffer', { a: fmtMoney(o.amountDue), c: fmtMoney(Number(cash.value)) }))) return;
      close();
      await act(o, 'deliver', { note: proof.value, recipient: rec.value, cashCollected: o.payment === 'cod' ? Number(cash.value) : undefined });
    } }, t('drv.confirmDeliver')));
  close = sheet(t('drv.delivered') + ' · ' + o.id, body);
}

// ------------------------------------------------------------ boot
initLang(() => { if (S) render(); else if (!session.get()) gate(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  const s = session.get();
  if (s && s.role === 'driver') { await load(); if (S) { begin(); flush(); } else if (!session.get()) gate(); } else gate();
})();
