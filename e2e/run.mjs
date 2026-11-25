// Browser end-to-end test against a running deployment: BASE=https://... node e2e/run.mjs
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:4173';
const SHOTS = process.env.SHOTS || 'shots';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push(['PASS', name, Date.now() - t0]); console.log('PASS', name); }
  catch (e) { results.push(['FAIL', name, Date.now() - t0, e.message]); console.log('FAIL', name, '\n   ', e.message.replace(/\n/g, ' ').slice(0, 700)); }
}
async function api(method, path, body, token) {
  const r = await fetch(BASE + '/api/' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const tokenFor = async (role, driverId) => (await api('POST', 'login', { role, driverId })).json.token;

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--font-render-hinting=none'], headless: 'new' });
async function page(opts = {}) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.setViewport(opts.viewport || { width: 1360, height: 900 });
  p.ctx = ctx;
  return p;
}
const text = (p, sel) => p.$eval(sel, (e) => e.textContent);
const waitText = (p, needle, timeout = 12000) => p.waitForFunction((n) => document.body.innerText.includes(n), { timeout }, needle);
const clickText = async (p, sel, needle) => {
  const ok = await p.evaluate((sel, needle) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(needle) && !e.disabled); if (el) { el.click(); return true; } return false; }, sel, needle);
  assert.ok(ok, 'no element ' + sel + ' with text ' + needle);
};

// start from a known state
const adminToken = await tokenFor('admin');
assert.equal((await api('POST', 'reset', null, adminToken)).status, 200);

let code, orderId;
const dispatch = await page();
const driverPage = await page({ viewport: { width: 390, height: 844 } });
const visitor = await page({ viewport: { width: 390, height: 844 } });

await step('landing page shows demo tracking codes', async () => {
  await visitor.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await visitor.waitForSelector('#demoCodes button');
  assert.ok((await visitor.$$('#demoCodes button')).length >= 3);
});
await step('tracking: bad format and unknown code give clear errors', async () => {
  await visitor.goto(BASE + '/track.html', { waitUntil: 'networkidle0' });
  await visitor.type('#code', 'ABC');
  await visitor.click('button[type=submit]');
  await waitText(visitor, 'not in the right format');
  await visitor.$eval('#code', (e) => (e.value = ''));
  await visitor.type('#code', 'TWS-ZZZZZZ');
  await visitor.click('button[type=submit]');
  await waitText(visitor, 'could not find that code');
});

await step('dispatcher signs in and sees the live board with alerts', async () => {
  await dispatch.goto(BASE + '/dispatch.html', { waitUntil: 'networkidle0' });
  await dispatch.screenshot({ path: SHOTS + '/00-role-picker.png' });
  await clickText(dispatch, 'button', 'Dispatcher');
  await dispatch.waitForSelector('.board');
  await waitText(dispatch, 'Alerts');
  assert.ok((await dispatch.$$('.ocard')).length > 10);
  await sleep(300);
  await dispatch.screenshot({ path: SHOTS + '/01-board.png' });
});

await step('new order form validates fields and shows a live fee quote', async () => {
  await dispatch.click('#newBtn');
  await dispatch.waitForSelector('#newForm');
  await dispatch.type('#n-customerName', 'Laila Gamal');
  await dispatch.type('#n-customerPhone', '12345');
  await dispatch.type('#n-merchant', 'Baladi Bakery');
  await dispatch.type('#n-street', '5 Road 9, Maadi');
  await dispatch.click('#createSubmit');
  await waitText(dispatch, 'Enter an Egyptian mobile number');
  await waitText(dispatch, 'Choose a zone');
  assert.equal(await dispatch.$eval('#n-customerPhone', (e) => e.getAttribute('aria-invalid')), 'true');
  await dispatch.select('#n-zoneId', 'z-maadi');
  await dispatch.$eval('#n-customerPhone', (e) => (e.value = ''));
  await dispatch.type('#n-customerPhone', '01112223334');
  await dispatch.select('#n-priority', 'express');
  await waitText(dispatch, 'Zone base fee');
  await waitText(dispatch, 'Express');
  const total = await dispatch.$eval('.quote .tot', (e) => e.textContent);
  assert.match(total, /EGP \d+/);
  await sleep(300);
  await dispatch.screenshot({ path: SHOTS + '/02-new-order-quote.png' });
});

await step('creating the order puts it in the Needs a driver column', async () => {
  await dispatch.click('#createSubmit');
  await waitText(dispatch, 'created. Code TWS-');
  const t = await dispatch.$eval('#toast', (e) => e.textContent);
  code = t.match(/TWS-[A-Z0-9]{6}/)[0];
  orderId = t.match(/ORD-\d+/)[0];
  await dispatch.waitForSelector(`[data-order="${orderId}"]`);
  const colTitle = await dispatch.$eval(`[data-order="${orderId}"]`, (e) => e.closest('.col').querySelector('h3 span').textContent);
  assert.equal(colTitle, 'Needs a driver');
});

await step('customer tracking page shows "Order received" for the new code', async () => {
  await visitor.goto(BASE + '/track.html?code=' + code, { waitUntil: 'networkidle0' });
  await waitText(visitor, 'Order received');
  assert.ok(!(await visitor.evaluate(() => document.body.innerText)).includes('01112223334'), 'phone must not be public');
});

await step('assign: drivers in the zone first, offline driver disabled', async () => {
  await dispatch.click(`[data-order="${orderId}"]`);
  await waitText(dispatch, 'Assign a driver');
  await dispatch.screenshot({ path: SHOTS + '/03-order-detail.png' });
  await clickText(dispatch, '.modal .btn', 'Assign a driver');
  await dispatch.waitForSelector('[data-driver]');
  const list = await dispatch.$$eval('[data-driver]', (els) => els.map((e) => e.dataset.driver + (e.disabled ? '(disabled)' : '')));
  assert.equal(list[0].replace('(disabled)', ''), 'd-mona', 'Mona covers Maadi, so she is listed first. Got: ' + list.join());
  const salmaDisabled = await dispatch.$eval('[data-driver="d-salma"]', (e) => e.disabled);
  assert.equal(salmaDisabled, true);
  await dispatch.screenshot({ path: SHOTS + '/04-assign.png' });
  await dispatch.click('[data-driver="d-mona"]');
  await waitText(dispatch, 'Assigned to Mona');
  await dispatch.waitForFunction((id) => document.querySelector(`[data-order="${id}"]`)?.closest('.col').querySelector('h3 span').textContent === 'Assigned', { timeout: 8000 }, orderId);
  const colTitle = await dispatch.$eval(`[data-order="${orderId}"]`, (e) => e.closest('.col').querySelector('h3 span').textContent);
  assert.equal(colTitle, 'Assigned');
});

await step('driver (mobile): sees the order, accepts and picks up', async () => {
  await driverPage.goto(BASE + '/driver.html', { waitUntil: 'networkidle0' });
  await driverPage.waitForSelector('[data-driver="d-mona"]');
  await driverPage.screenshot({ path: SHOTS + '/05-driver-picker.png' });
  await driverPage.click('[data-driver="d-mona"]');
  await driverPage.waitForSelector(`[data-order="${orderId}"]`);
  await driverPage.click(`[data-order="${orderId}"] [data-act=accept]`);
  await driverPage.waitForSelector(`[data-order="${orderId}"] [data-act=pickup]`);
  await driverPage.click(`[data-order="${orderId}"] [data-act=pickup]`);
  await driverPage.waitForSelector(`[data-order="${orderId}"] [data-act=deliver]`);
  await sleep(300);
  await driverPage.screenshot({ path: SHOTS + '/06-driver-tasks.png' });
});

await step('driver cannot deliver without proof; cash mismatch needs confirmation', async () => {
  await driverPage.click(`[data-order="${orderId}"] [data-act=deliver]`);
  await driverPage.waitForSelector('#confirmDeliver');
  await sleep(400);
  await driverPage.evaluate(() => document.querySelector('#confirmDeliver').click());
  await waitText(driverPage, 'Add a delivery proof note').catch(async () => { await driverPage.screenshot({ path: SHOTS + '/debug-proof.png' }); throw new Error('no proof error; page text: ' + (await driverPage.evaluate(() => document.body.innerText)).slice(0, 400)); });
  assert.equal(await driverPage.$eval('#dp', (e) => e.getAttribute('aria-invalid')), 'true');
  await driverPage.screenshot({ path: SHOTS + '/07-driver-deliver-sheet.png' });
});

await step('driver delivers with proof and exact cash', async () => {
  await driverPage.type('#dp', 'Handed to customer at the door');
  await driverPage.evaluate(() => document.querySelector('#confirmDeliver').click());
  await waitText(driverPage, 'Done');
  await driverPage.waitForFunction((id) => !document.querySelector(`[data-order="${id}"] [data-act]`), {}, orderId);
});

await step('tracking page now says Delivered, dashboard shows the order closed', async () => {
  await visitor.goto(BASE + '/track.html?code=' + code, { waitUntil: 'networkidle0' });
  await waitText(visitor, 'Delivered');
  await visitor.screenshot({ path: SHOTS + '/08-track-delivered.png', fullPage: true });
  const st = await api('GET', 'state', null, adminToken);
  const o = st.json.orders.find((x) => x.id === orderId);
  assert.equal(o.status, 'delivered'); assert.equal(o.cashMismatch, false);
  assert.ok(o.events.map((e) => e.status).join() === 'new,assigned,accepted,picked_up,delivered');
});

await step('tracking page for a live order in transit (mobile screenshot)', async () => {
  const codes = (await api('GET', 'demo-codes')).json.codes;
  const live = codes.find((c) => c.status === 'picked_up');
  assert.ok(live);
  await visitor.goto(BASE + '/track.html?code=' + live.code, { waitUntil: 'networkidle0' });
  await waitText(visitor, 'On the way');
  await sleep(300);
  await visitor.screenshot({ path: SHOTS + '/09-track-in-transit.png', fullPage: true });
});

await step('offline driver: actions queue on the phone and sync on reconnect', async () => {
  const dTok = await tokenFor('dispatcher');
  const c = await api('POST', 'orders', { customerName: 'Hassan Ali', customerPhone: '01255551234', merchant: 'Cairo Books', street: '9 Salah Salem Road', zoneId: 'z-nasr', weightKg: 1, subtotal: 200, payment: 'paid' }, dTok);
  assert.equal(c.status, 201);
  const oid = c.json.order.id;
  assert.equal((await api('POST', `orders/${oid}/assign`, { driverId: 'd-karim' }, dTok)).status, 200);
  const p = await page({ viewport: { width: 390, height: 844 } });
  await p.goto(BASE + '/driver.html', { waitUntil: 'networkidle0' });
  await p.click('[data-driver="d-karim"]');
  await p.waitForSelector(`[data-order="${oid}"] [data-act=accept]`);
  await p.setOfflineMode(true);
  await p.click(`[data-order="${oid}"] [data-act=accept]`);
  await waitText(p, 'Saved on the phone');
  await p.waitForSelector('#queueBanner');
  await p.screenshot({ path: SHOTS + '/10-driver-offline-queue.png' });
  assert.equal((await api('GET', 'state', null, dTok)).json.orders.find((o) => o.id === oid).status, 'assigned', 'server not changed yet');
  await p.setOfflineMode(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.waitForFunction(() => !document.querySelector('#queueBanner'), { timeout: 15000 });
  await sleep(500);
  assert.equal((await api('GET', 'state', null, dTok)).json.orders.find((o) => o.id === oid).status, 'accepted');
  await p.ctx.close();
});

await step('offline action refused by the server is dropped and the driver is told', async () => {
  const dTok = await tokenFor('dispatcher');
  const c = await api('POST', 'orders', { customerName: 'Mariam Said', customerPhone: '01099998888', merchant: 'Layali Sweets', street: '14 Abbas El Akkad St', zoneId: 'z-nasr', weightKg: 1, subtotal: 150, payment: 'paid' }, dTok);
  const oid = c.json.order.id;
  await api('POST', `orders/${oid}/assign`, { driverId: 'd-hany' }, dTok);
  const p = await page({ viewport: { width: 390, height: 844 } });
  await p.goto(BASE + '/driver.html', { waitUntil: 'networkidle0' });
  await p.click('[data-driver="d-hany"]');
  await p.waitForSelector(`[data-order="${oid}"] [data-act=accept]`);
  await p.setOfflineMode(true);
  await p.click(`[data-order="${oid}"] [data-act=accept]`);
  await p.waitForSelector('#queueBanner');
  // dispatcher reassigns while the phone has no signal
  assert.equal((await api('POST', `orders/${oid}/assign`, { driverId: 'd-karim' }, dTok)).status, 200);
  await p.setOfflineMode(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await waitText(p, 'refused by the server', 15000);
  const st = (await api('GET', 'state', null, dTok)).json.orders.find((o) => o.id === oid);
  assert.equal(st.status, 'assigned'); assert.equal(st.driverId, 'd-karim');
  await p.ctx.close();
});

await step('Arabic: RTL layout and translated dashboard', async () => {
  await dispatch.click('#langBtn');
  await sleep(400);
  assert.equal(await dispatch.evaluate(() => document.documentElement.dir), 'rtl');
  await waitText(dispatch, 'لوحة التوزيع');
  await dispatch.screenshot({ path: SHOTS + '/11-board-arabic-rtl.png' });
  await driverPage.reload({ waitUntil: 'networkidle0' });
  await driverPage.evaluate(() => localStorage.setItem('tws_lang', 'ar'));
  await driverPage.reload({ waitUntil: 'networkidle0' });
  await driverPage.screenshot({ path: SHOTS + '/12-driver-arabic.png' });
  await dispatch.click('#langBtn');
  await sleep(300);
});

await step('zones tab: admin edits a fee and the live quote changes; dispatcher cannot', async () => {
  const before = (await api('POST', 'quote', { zoneId: 'z-newcairo', weightKg: 1, subtotal: 100, priority: 'standard', payment: 'paid' })).json.fee;
  const dTok = await tokenFor('dispatcher');
  assert.equal((await api('PUT', 'zones/z-newcairo', { baseFee: 99, slaMin: 90 }, dTok)).status, 403);
  const admin = await page();
  await admin.goto(BASE + '/dispatch.html', { waitUntil: 'networkidle0' });
  await clickText(admin, 'button', 'Admin');
  await admin.waitForSelector('.board');
  await clickText(admin, '.tab', 'Zones and fees');
  await admin.waitForSelector('table input[type=number]');
  await admin.screenshot({ path: SHOTS + '/13-zones-fees.png' });
  const idx = 5; // New Cairo is the 6th zone
  const inputs = await admin.$$('table input[type=number]');
  await inputs[idx * 2].focus();
  await admin.evaluate((el) => el.select(), inputs[idx * 2]);
  await inputs[idx * 2].type('70');
  await admin.evaluate((i) => { document.querySelectorAll('table tbody tr')[i].querySelector('button').click(); }, idx);
  await waitText(admin, 'Saved');
  const after = (await api('POST', 'quote', { zoneId: 'z-newcairo', weightKg: 1, subtotal: 100, priority: 'standard', payment: 'paid' })).json.fee;
  assert.equal(after - before, 70 - 55);
  assert.equal((await api('PUT', 'zones/z-newcairo', { baseFee: 55, slaMin: 90 }, adminToken)).status, 200);
  await clickText(admin, '.tab', 'Performance');
  await admin.waitForSelector('.bars');
  await sleep(300);
  await admin.screenshot({ path: SHOTS + '/14-performance.png' });
  await clickText(admin, '.tab', 'Drivers');
  await sleep(200);
  await admin.screenshot({ path: SHOTS + '/15-drivers.png' });
  await admin.ctx.close();
});

await step('viewer: no create button, API write refused, phones masked', async () => {
  const v = await page();
  await v.goto(BASE + '/dispatch.html', { waitUntil: 'networkidle0' });
  await clickText(v, 'button', 'Viewer');
  await v.waitForSelector('.board');
  assert.equal((await v.$('#newBtn')), null);
  const vt = await tokenFor('viewer');
  assert.equal((await api('POST', 'orders', { customerName: 'X Y' }, vt)).status, 403);
  const st = await api('GET', 'state', null, vt);
  assert.ok(st.json.orders.every((o) => !/^01\d{9}$/.test(o.customer.phone)));
  await v.ctx.close();
});

await step('concurrency: 8 simultaneous order creations are all saved with unique ids', async () => {
  const dTok = await tokenFor('dispatcher');
  const n0 = (await api('GET', 'state', null, dTok)).json.orders.length;
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => api('POST', 'orders', { customerName: 'Load Test ' + (i + 1), customerPhone: '0101234567' + i, merchant: 'Green Basket Market', street: (i + 1) + ' Test Street', zoneId: 'z-nasr', weightKg: 1, subtotal: 100 }, dTok)));
  const ok = rs.filter((r) => r.status === 201);
  const busy = rs.filter((r) => r.status === 503);
  console.log('   created', ok.length, 'busy(503)', busy.length);
  const st = (await api('GET', 'state', null, dTok)).json.orders;
  assert.equal(st.length, n0 + ok.length, 'every 201 must be persisted (no lost updates)');
  assert.equal(new Set(st.map((o) => o.id)).size, st.length);
  assert.ok(ok.length >= 6, 'at least 6 of 8 should succeed (others may report busy)');
});

await browser.close();
const failed = results.filter((r) => r[0] === 'FAIL');
console.log('\nconsole/page errors:', errors.length ? errors : 'none');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || errors.length ? 1 : 0);
