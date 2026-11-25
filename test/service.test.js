import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../lib/service.js';
import { MemoryStore } from '../lib/store.js';
import { signToken, verifyToken } from '../lib/auth.js';

const now = Date.parse('2026-11-25T13:00:00+02:00');
async function login(store, role, driverId) {
  const r = await handle({ method: 'POST', path: 'login', body: { role, driverId }, store, now });
  assert.equal(r.status, 200);
  return { authorization: 'Bearer ' + r.json.token };
}
const call = (store, method, path, body, headers = {}, t = now) => handle({ method, path, body, headers, store, now: t });
const newOrder = { customerName: 'Laila Gamal', customerPhone: '01112223334', merchant: 'Baladi Bakery', street: '5 Road 9 Maadi', zoneId: 'z-maadi', weightKg: 2, subtotal: 250, items: 1, priority: 'standard', payment: 'cod' };

test('auth: tokens verify, tamper and expiry fail', () => {
  const t = signToken({ role: 'admin' }, now);
  assert.equal(verifyToken(t, now + 1000).role, 'admin');
  assert.equal(verifyToken(t + 'x', now + 1000), null);
  assert.equal(verifyToken(t, now + 13 * 3600000), null);
  const [b, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ role: 'admin', exp: now + 99999999 })).toString('base64url') + '.' + s;
  assert.equal(verifyToken(forged, now), null);
});
test('unauthenticated requests are rejected, public endpoints work', async () => {
  const store = new MemoryStore();
  assert.equal((await call(store, 'GET', 'state')).status, 401);
  assert.equal((await call(store, 'POST', 'orders', newOrder)).status, 401);
  assert.equal((await call(store, 'GET', 'health')).status, 200);
});
test('create order -> assign -> driver flow -> public tracking by code', async () => {
  const store = new MemoryStore();
  const d = await login(store, 'dispatcher');
  const c = await call(store, 'POST', 'orders', newOrder, d);
  assert.equal(c.status, 201);
  const { id, code } = c.json.order;
  assert.match(code, /^TWS-/);
  let t = await call(store, 'GET', 'track/' + code.toLowerCase());
  assert.equal(t.status, 200); assert.equal(t.json.publicStage, 0);
  assert.equal((await call(store, 'POST', `orders/${id}/assign`, { driverId: 'd-mona' }, d)).status, 200);
  const dr = await login(store, 'driver', 'd-mona');
  assert.equal((await call(store, 'POST', `orders/${id}/accept`, {}, dr)).status, 200);
  assert.equal((await call(store, 'POST', `orders/${id}/pickup`, {}, dr)).status, 200);
  t = await call(store, 'GET', 'track/' + code);
  assert.equal(t.json.publicStage, 2); assert.equal(t.json.driver.firstName, 'Mona');
  const bad = await call(store, 'POST', `orders/${id}/deliver`, { note: 'ok' }, dr);
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'proof_required');
  const del = await call(store, 'POST', `orders/${id}/deliver`, { note: 'Handed to Laila', cashCollected: c.json.order.amountDue }, dr);
  assert.equal(del.status, 200);
  t = await call(store, 'GET', 'track/' + code);
  assert.equal(t.json.publicStage, 3);
});
test('create order validation returns 422 with per-field errors', async () => {
  const store = new MemoryStore();
  const d = await login(store, 'admin');
  const r = await call(store, 'POST', 'orders', { ...newOrder, customerPhone: '12345', customerName: '' }, d);
  assert.equal(r.status, 422);
  assert.ok(r.json.fields.customerPhone && r.json.fields.customerName);
});
test('permissions: viewer read-only, driver cannot touch others orders or create', async () => {
  const store = new MemoryStore();
  const v = await login(store, 'viewer');
  assert.equal((await call(store, 'POST', 'orders', newOrder, v)).status, 403);
  const st = await call(store, 'GET', 'state', null, v);
  assert.ok(!st.json.orders.some((o) => /^01\d{9}$/.test(o.customer.phone)), 'viewer phones masked');
  const adm = await login(store, 'admin');
  const c = await call(store, 'POST', 'orders', newOrder, adm);
  await call(store, 'POST', `orders/${c.json.order.id}/assign`, { driverId: 'd-karim' }, adm);
  const other = await login(store, 'driver', 'd-hany');
  assert.equal((await call(store, 'POST', `orders/${c.json.order.id}/accept`, {}, other)).status, 403);
  assert.equal((await call(store, 'POST', 'orders', newOrder, other)).status, 403);
  const hs = await call(store, 'GET', 'state', null, other);
  assert.ok(!hs.json.orders.some((o) => o.id === c.json.order.id), 'driver only sees own orders');
  assert.equal((await call(store, 'PUT', 'zones/z-nasr', { baseFee: 1, slaMin: 30 }, await login(store, 'dispatcher'))).status, 403);
});
test('idempotency: replaying the same clientActionId does not double apply', async () => {
  const store = new MemoryStore();
  const adm = await login(store, 'admin');
  const c = await call(store, 'POST', 'orders', newOrder, adm);
  const id = c.json.order.id;
  await call(store, 'POST', `orders/${id}/assign`, { driverId: 'd-mona' }, adm);
  const dr = await login(store, 'driver', 'd-mona');
  const a1 = await call(store, 'POST', `orders/${id}/accept`, { clientActionId: 'act-1' }, dr);
  const a2 = await call(store, 'POST', `orders/${id}/accept`, { clientActionId: 'act-1' }, dr);
  assert.equal(a1.status, 200); assert.equal(a2.status, 200); assert.equal(a2.json.duplicate, true);
  const st = await call(store, 'GET', 'state', null, adm);
  const o = st.json.orders.find((x) => x.id === id);
  assert.equal(o.events.filter((e) => e.status === 'accepted').length, 1);
});
test('zone fee edit by admin changes the next quote', async () => {
  const store = new MemoryStore();
  const adm = await login(store, 'admin');
  const before = (await call(store, 'POST', 'quote', { zoneId: 'z-nasr', weightKg: 1, subtotal: 100, priority: 'standard', payment: 'paid' })).json.fee;
  assert.equal((await call(store, 'PUT', 'zones/z-nasr', { baseFee: 50, slaMin: 60 }, adm)).status, 200);
  const after = (await call(store, 'POST', 'quote', { zoneId: 'z-nasr', weightKg: 1, subtotal: 100, priority: 'standard', payment: 'paid' })).json.fee;
  assert.equal(after - before, 20);
  assert.equal((await call(store, 'PUT', 'zones/z-nasr', { baseFee: -3, slaMin: 60 }, adm)).status, 422);
});
test('tracking: bad code 400, unknown 404, rate limit 429', async () => {
  const store = new MemoryStore();
  assert.equal((await call(store, 'GET', 'track/%3Cscript%3E')).status, 400);
  assert.equal((await call(store, 'GET', 'track/TWS-ZZZZZZ')).status, 404);
  let last;
  for (let i = 0; i < 45; i++) last = await handle({ method: 'GET', path: 'track/TWS-ZZZZZZ', store, now, ip: '9.9.9.9' });
  assert.equal(last.status, 429);
});
test('demo state resets after 6 hours', async () => {
  const store = new MemoryStore();
  const adm = await login(store, 'admin');
  await call(store, 'POST', 'orders', newOrder, adm);
  const n1 = (await call(store, 'GET', 'state', null, adm)).json.orders.length;
  const later = now + 6.5 * 3600000;
  const n2 = (await handle({ method: 'GET', path: 'state', headers: adm, store, now: later })).json.orders.length;
  assert.equal(n1, 42); assert.equal(n2, 41);
});
