import { icon, vehicleIcon, initLang, h, t, api, logoSvg, state, fmtTime, fmtDateTime, fmtMoney, fmtDur, errText } from './common.js';

document.getElementById('logo').append(logoSvg());
const input = document.getElementById('code');
const errEl = document.getElementById('err');
const result = document.getElementById('result');
let data = null, timer = null, current = null;

const STEPS = ['placed', 'assigned', 'on_the_way', 'delivered'];
const ICONS = ['doc', 'user', 'bike', 'home'];

function mapSvg(stage) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 600 150'); s.setAttribute('class', 'map'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', t('track.mapLabel'));
  const pts = [[50, 100], [220, 100], [380, 45], [550, 45]];
  const p = pts[Math.min(stage, 3)];
  const mid = stage === 2 ? [(pts[2][0] + pts[3][0]) / 2 - 40, 45] : p;
  const pos = stage === 3 ? pts[3] : mid;
  s.innerHTML = '<path d="M50 100 H220 L380 45 H550" fill="none" stroke="#cbd5e1" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M50 100 H' + Math.min(pos[0], 220) + (pos[0] > 220 ? ' L' + Math.min(pos[0], 380) + ' ' + (100 - (Math.min(pos[0], 380) - 220) * 55 / 160) : '') + (pos[0] > 380 ? ' H' + pos[0] : '') + '" fill="none" stroke="#f59e0b" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="50" cy="100" r="11" fill="#0d9488" stroke="#fff" stroke-width="3"/><g transform="translate(550 45)"><path d="M0 18c-8-9-12-15-12-21a12 12 0 0 1 24 0c0 6-4 12-12 21z" fill="#ef4444" stroke="#fff" stroke-width="3"/><circle cy="-3" r="4" fill="#fff"/></g>' +
    (stage < 3 ? '<g transform="translate(' + pos[0] + ' ' + (pos[0] <= 220 ? 100 : pos[0] >= 380 ? 45 : 100 - (pos[0] - 220) * 55 / 160) + ')"><circle r="16" fill="#f59e0b" stroke="#fff" stroke-width="3"/><path d="M-7 3h9l3-6h3" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="-5" cy="5" r="2" fill="#0f172a"/><circle cx="6" cy="5" r="2" fill="#0f172a"/></g>' : '');
  return s;
}

function render() {
  result.replaceChildren();
  if (!data) return;
  const d = data;
  const failed = d.status === 'failed', cancelled = d.status === 'cancelled';
  const head = h('div', { class: 'card pad', style: 'margin-top:16px' });
  head.append(h('div', { class: 'row' }, h('span', { class: 'mono', style: 'font-weight:800;font-size:18px' }, d.code), d.priority === 'express' ? h('span', { class: 'chip express' }, t('priority.express')) : null, h('span', { class: 'right mute' }, t('track.from', { m: d.merchant }))));
  const label = cancelled ? 'track.s.cancelled' : failed ? 'track.s.failed' : 'track.s.' + d.publicStage;
  head.append(h('div', { class: 'bigstatus', style: 'margin:10px 0 2px' }, t(label)));
  head.append(h('div', { class: 'mute' }, t('track.hello', { n: d.customerFirstName }) + ' ' + (d.zone ? '· ' + (state.lang === 'ar' ? d.zone.ar : d.zone.en) : '')));
  if (d.eta && !cancelled) {
    head.append(h('div', { class: 'banner ' + (d.delayed ? 'warn' : 'info'), style: 'margin-top:12px' }, d.delayed ? t('track.delayed', { t: fmtTime(d.eta.at) }) : t('track.eta', { t: fmtTime(d.eta.at) })));
  }
  if (failed) head.append(h('div', { class: 'banner warn', style: 'margin-top:12px' }, t('track.failedNote')));
  if (d.status === 'delivered' && d.deliveredAt) head.append(h('div', { class: 'banner info', style: 'margin-top:12px' }, t('track.deliveredAt', { t: fmtDateTime(d.deliveredAt) })));
  result.append(head);

  if (!cancelled && !failed) {
    const steps = h('div', { class: 'steps', role: 'list' });
    STEPS.forEach((s, i) => steps.append(h('div', { class: 'step ' + (i < d.publicStage || d.publicStage === 3 ? 'done' : i === d.publicStage ? 'cur' : ''), role: 'listitem', 'aria-current': i === d.publicStage ? 'step' : false }, h('div', { class: 'c' }, i < d.publicStage || d.publicStage === 3 ? icon('check', 18) : icon(ICONS[i], 18)), t('track.step.' + s))));
    const box = h('div', { class: 'card pad', style: 'margin-top:14px' }, steps, h('div', { style: 'margin-top:12px' }, mapSvg(d.publicStage)), h('p', { class: 'mute', style: 'font-size:12.5px;margin:8px 0 0' }, t('track.mapNote')));
    result.append(box);
  }

  const info = h('div', { class: 'card pad', style: 'margin-top:14px' });
  if (d.driver) info.append(h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { style: 'background:var(--amber-bg);color:var(--amber-d);border-radius:12px;padding:10px;display:inline-flex' }, vehicleIcon(d.driver.vehicle)), h('div', null, h('b', null, t('track.driver', { n: d.driver.firstName })), h('div', { class: 'mute' }, t('vehicle.' + d.driver.vehicle)))));
  info.append(h('div', { class: 'row' }, h('span', { class: 'mute' }, t('track.items', { n: d.items })), d.payment === 'cod' && d.amountDue ? h('span', { class: 'chip cod right' }, t('track.cod', { a: fmtMoney(d.amountDue) })) : h('span', { class: 'chip ok right' }, t('track.prepaid'))));
  result.append(info);

  const tl = h('ul', { class: 'tl' });
  for (const e of [...d.timeline].reverse()) tl.append(h('li', null, h('b', null, t('track.tl.' + e.step)), ' ', h('span', { class: 'mute' }, fmtDateTime(e.at))));
  result.append(h('div', { class: 'card pad', style: 'margin-top:14px' }, h('h3', { style: 'margin-bottom:12px' }, t('track.history')), tl));
}

async function lookup(raw, silent) {
  errEl.textContent = '';
  input.removeAttribute('aria-invalid');
  if (!raw.trim()) { errEl.textContent = t('track.enter'); input.setAttribute('aria-invalid', 'true'); return; }
  try {
    data = await api('GET', 'track/' + encodeURIComponent(raw.trim()));
    current = raw.trim();
    history.replaceState(null, '', '?code=' + data.code);
    input.value = data.code;
    render();
    clearInterval(timer);
    if (!['delivered', 'cancelled'].includes(data.status)) timer = setInterval(() => lookup(current, true), 15000);
  } catch (e) {
    if (silent) return;
    data = null; render();
    clearInterval(timer);
    errEl.textContent = e.status === 404 ? t('track.notFound') : e.status === 400 ? t('track.badCode') : errText(e);
    input.setAttribute('aria-invalid', 'true');
  }
}

document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); lookup(input.value); });
initLang(render);
const q = new URLSearchParams(location.search).get('code');
if (q) { input.value = q; lookup(q); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
