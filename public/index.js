import { icon, initLang, h, t, api, logoSvg, errText } from './common.js';

document.getElementById('logo').append(logoSvg());
const input = document.getElementById('code');
const err = document.getElementById('codeErr');

document.getElementById('trackForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!v) { err.textContent = t('track.enter'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
  location.href = '/track.html?code=' + encodeURIComponent(v);
});
input.addEventListener('input', () => { err.textContent = ''; input.removeAttribute('aria-invalid'); });

async function demo() {
  const box = document.getElementById('demoCodes');
  box.replaceChildren();
  try {
    const r = await api('GET', 'demo-codes');
    if (!r.codes.length) return;
    box.append(h('span', null, t('home.try')));
    for (const c of r.codes) box.append(h('button', { type: 'button', class: 'mono', onclick: () => { location.href = '/track.html?code=' + c.code; } }, c.code));
  } catch {}
}
initLang(demo);
demo();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const map = { r1: 'box', r2: 'compass', r3: 'bike' };
document.querySelectorAll('.role-card .ic').forEach((el, i) => el.replaceChildren(icon(['box', 'compass', 'bike'][i], 24)));
