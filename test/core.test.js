import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteFee, DEFAULT_ZONES, DEFAULT_SETTINGS, normalizePhone, normalizeCode, makeCode, isNight, slaState, applyAction, validateNewOrder, buildOrder, computeAlerts, computeStats, publicTracking, cleanText, slaMinutesFor } from '../lib/core.js';

const zones = DEFAULT_ZONES.map((z) => ({ ...z }));
const noon = Date.parse('2026-11-25T12:00:00+02:00'); // Cairo midday (Egypt is UTC+2 in November)
const midnight = Date.parse('2026-11-25T23:30:00+02:00');

test('fee: base zone fee only, standard, prepaid', () => {
  const q = quoteFee({ zoneId: 'z-nasr', weightKg: 2, subtotal: 300, priority: 'standard', payment: 'paid' }, zones, DEFAULT_SETTINGS, noon);
  assert.equal(q.fee, 30);
});
test('fee: weight surcharge counts only kilos above the free weight, rounded up', () => {
  const q = quoteFee({ zoneId: 'z-nasr', weightKg: 7.2, subtotal: 300, priority: 'standard', payment: 'paid' }, zones, DEFAULT_SETTINGS, noon);
  assert.equal(q.lines.find((l) => l.key === 'weight').amount, 3 * 4);
  assert.equal(q.fee, 42);
});
test('fee: express multiplies base+weight, then night adds flat', () => {
  const q = quoteFee({ zoneId: 'z-maadi', weightKg: 7, subtotal: 200, priority: 'express', payment: 'paid' }, zones, DEFAULT_SETTINGS, midnight);
  // (40 + 2*4) = 48 -> x1.5 = 72, + 15 night = 87
  assert.equal(q.fee, 87);
});
test('fee: free delivery waives base only, never weight or night, and never for express', () => {
  const s = quoteFee({ zoneId: 'z-nasr', weightKg: 8, subtotal: 1600, priority: 'standard', payment: 'paid' }, zones, DEFAULT_SETTINGS, midnight);
  assert.equal(s.fee, 12 + 15);
  const e = quoteFee({ zoneId: 'z-nasr', weightKg: 1, subtotal: 1600, priority: 'express', payment: 'paid' }, zones, DEFAULT_SETTINGS, noon);
  assert.equal(e.fee, 45);
});
test('fee: COD fee is 1% clamped between 5 and 25', () => {
  const f = (subtotal) => quoteFee({ zoneId: 'z-nasr', weightKg: 1, subtotal, priority: 'standard', payment: 'cod' }, zones, { ...DEFAULT_SETTINGS, freeDeliveryOver: 1e9 }, noon).lines.find((l) => l.key === 'cod').amount;
  assert.equal(f(100), 5);
  assert.equal(f(1000), 10);
  assert.equal(f(9000), 25);
});
test('fee: rejects bad inputs', () => {
  assert.equal(quoteFee({ zoneId: 'nope', weightKg: 1, subtotal: 1 }, zones).error, 'unknown_zone');
  assert.equal(quoteFee({ zoneId: 'z-nasr', weightKg: 0, subtotal: 1 }, zones).error, 'bad_weight');
  assert.equal(quoteFee({ zoneId: 'z-nasr', weightKg: 1, subtotal: -5 }, zones).error, 'bad_subtotal');
});
test('night window wraps midnight in Cairo time', () => {
  assert.equal(isNight(Date.parse('2026-11-25T22:00:00+02:00')), true);
  assert.equal(isNight(Date.parse('2026-11-25T05:59:00+02:00')), true);
  assert.equal(isNight(Date.parse('2026-11-25T06:00:00+02:00')), false);
  assert.equal(isNight(Date.parse('2026-11-25T21:59:00+02:00')), false);
});
test('phone normalisation: Egyptian formats and Arabic digits', () => {
  assert.equal(normalizePhone('01012345678'), '01012345678');
  assert.equal(normalizePhone('+20 101 234 5678'), '01012345678');
  assert.equal(normalizePhone('٠١٠١٢٣٤٥٦٧٨'), '01012345678');
  assert.equal(normalizePhone('0131234567'), null);
  assert.equal(normalizePhone('01312345678'), null);
  assert.equal(normalizePhone('abc'), null);
});
test('tracking codes: format, normalisation, no ambiguous chars', () => {
  for (let i = 0; i < 200; i++) assert.match(makeCode(), /^TWS-[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(normalizeCode('tws ab2cd3'), 'TWS-AB2CD3');
  assert.equal(normalizeCode('AB2CD3'), 'TWS-AB2CD3');
  assert.equal(normalizeCode('TWS-AB0CD3'), null);
  assert.equal(normalizeCode('<script>'), null);
});
test('cleanText strips markup characters and control chars', () => {
  assert.equal(cleanText('  a<b>c\n\td  '), 'a b c d');
});

function mk(over = {}) {
  const v = validateNewOrder({ customerName: 'Sara Ali', customerPhone: '01012345678', merchant: 'Cairo Books', street: '12 Road 9', zoneId: 'z-nasr', weightKg: 2, subtotal: 400, items: 2, priority: 'standard', payment: 'cod', ...over }, zones, noon);
  assert.ok(v.ok, JSON.stringify(v));
  return buildOrder(v.data, 1001, 'TWS-ABCDEF', noon);
}
const drivers = () => [
  { id: 'd1', name: 'Karim H', vehicle: 'motorbike', zones: ['z-nasr'], status: 'online' },
  { id: 'd2', name: 'Mona A', vehicle: 'car', zones: ['z-maadi'], status: 'offline' },
];
const ctx = (orders, ds, now) => ({ orders, drivers: ds, now, settings: DEFAULT_SETTINGS });
const disp = { role: 'dispatcher' };
const drv = (id) => ({ role: 'driver', driverId: id });

test('order validation reports each bad field', () => {
  const v = validateNewOrder({ customerName: '', customerPhone: '123', merchant: '', street: 'x', zoneId: 'x', weightKg: 100, subtotal: 'abc' }, zones, noon);
  assert.equal(v.ok, false);
  for (const k of ['customerName', 'customerPhone', 'merchant', 'street', 'zoneId', 'weightKg', 'subtotal']) assert.ok(v.errors[k], k);
});
test('COD order amount due = subtotal + fee; prepaid = 0', () => {
  const cod = mk();
  assert.equal(cod.amountDue, 400 + cod.fee);
  assert.equal(mk({ payment: 'paid' }).amountDue, 0);
});
test('happy path: assign, accept, pickup, deliver with proof and exact cash', () => {
  const o = mk(); const ds = drivers(); const os = [o];
  assert.ok(applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon + 60000)).ok);
  assert.ok(applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon + 120000)).ok);
  assert.ok(applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon + 600000)).ok);
  const d = applyAction(o, 'deliver', drv('d1'), { note: 'Left with doorman', cashCollected: o.amountDue }, ctx(os, ds, noon + 1800000));
  assert.ok(d.ok);
  assert.equal(o.status, 'delivered');
  assert.equal(o.cashMismatch, false);
  assert.equal(slaState(o, noon + 3e6), 'on_time');
});
test('invalid transitions are rejected', () => {
  const o = mk(); const ds = drivers(); const os = [o];
  assert.equal(applyAction(o, 'deliver', disp, { note: 'xxxx' }, ctx(os, ds, noon)).error, 'invalid_transition');
  assert.equal(applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon)).error, 'not_your_order');
  applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon));
  assert.equal(applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon)).error, 'invalid_transition');
});
test('assign rules: offline driver, capacity, unknown', () => {
  const ds = drivers();
  const orders = [mk(), mk(), mk(), mk(), mk()];
  assert.equal(applyAction(orders[0], 'assign', disp, { driverId: 'd2' }, ctx(orders, ds, noon)).error, 'driver_offline');
  assert.equal(applyAction(orders[0], 'assign', disp, { driverId: 'zz' }, ctx(orders, ds, noon)).error, 'unknown_driver');
  for (let i = 0; i < 4; i++) assert.ok(applyAction(orders[i], 'assign', disp, { driverId: 'd1' }, ctx(orders, ds, noon)).ok);
  assert.equal(applyAction(orders[4], 'assign', disp, { driverId: 'd1' }, ctx(orders, ds, noon)).error, 'driver_at_capacity');
});
test('roles: viewer cannot act, driver cannot assign or cancel', () => {
  const o = mk(); const os = [o]; const ds = drivers();
  assert.equal(applyAction(o, 'assign', { role: 'viewer' }, { driverId: 'd1' }, ctx(os, ds, noon)).error, 'forbidden');
  assert.equal(applyAction(o, 'assign', drv('d1'), { driverId: 'd1' }, ctx(os, ds, noon)).error, 'forbidden');
  assert.equal(applyAction(o, 'cancel', drv('d1'), { reason: 'duplicate' }, ctx(os, ds, noon)).error, 'forbidden');
});
test('delivery needs proof note and cash for COD; mismatch is flagged not hidden', () => {
  const o = mk(); const os = [o]; const ds = drivers();
  applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon));
  applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon));
  applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon));
  assert.equal(applyAction(o, 'deliver', drv('d1'), { note: 'ok' }, ctx(os, ds, noon)).error, 'proof_required');
  assert.equal(applyAction(o, 'deliver', drv('d1'), { note: 'given to customer' }, ctx(os, ds, noon)).error, 'cash_required');
  assert.ok(applyAction(o, 'deliver', drv('d1'), { note: 'given to customer', cashCollected: o.amountDue - 10 }, ctx(os, ds, noon)).ok);
  assert.equal(o.cashMismatch, true);
});
test('failed delivery: reason required; redispatch up to 3 attempts, then only cancel', () => {
  const o = mk(); const os = [o]; const ds = drivers();
  for (let i = 1; i <= 3; i++) {
    assert.ok(applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon)).ok);
    applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon));
    applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon));
    if (i === 1) assert.equal(applyAction(o, 'fail', drv('d1'), {}, ctx(os, ds, noon)).error, 'reason_required');
    assert.ok(applyAction(o, 'fail', drv('d1'), { reason: 'no_answer' }, ctx(os, ds, noon)).ok);
    assert.equal(o.attempts, i);
    if (i < 3) assert.ok(applyAction(o, 'redispatch', disp, {}, ctx(os, ds, noon)).ok);
  }
  assert.equal(applyAction(o, 'redispatch', disp, {}, ctx(os, ds, noon)).error, 'max_attempts');
  assert.ok(applyAction(o, 'cancel', disp, { reason: 'customer_request' }, ctx(os, ds, noon)).ok);
});
test('cancel is blocked once picked up and on delivered orders', () => {
  const o = mk(); const os = [o]; const ds = drivers();
  applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon));
  applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon));
  applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon));
  assert.equal(applyAction(o, 'cancel', disp, { reason: 'duplicate' }, ctx(os, ds, noon)).error, 'invalid_transition');
});
test('driver decline returns the order to the queue with a required note', () => {
  const o = mk(); const os = [o]; const ds = drivers();
  applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon));
  assert.equal(applyAction(o, 'decline', drv('d1'), {}, ctx(os, ds, noon)).error, 'note_required');
  assert.ok(applyAction(o, 'decline', drv('d1'), { note: 'bike broke down' }, ctx(os, ds, noon)).ok);
  assert.equal(o.status, 'new'); assert.equal(o.driverId, null);
});
test('SLA: states over time, express is tighter', () => {
  const o = mk();
  const min = (m) => noon + m * 60000;
  assert.equal(o.slaMin, 60);
  assert.equal(slaState(o, min(10)), 'ok');
  assert.equal(slaState(o, min(46)), 'at_risk');
  assert.equal(slaState(o, min(61)), 'late');
  const ex = mk({ priority: 'express' });
  assert.equal(ex.slaMin, slaMinutesFor(zones[0], 'express'));
  assert.equal(ex.slaMin, 36);
});
test('alerts: late, unassigned, not accepted, driver offline', () => {
  const o1 = mk(); const o2 = mk(); const os = [o1, o2]; const ds = drivers();
  applyAction(o2, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon + 1000));
  ds[0].status = 'offline';
  const types = computeAlerts(os, ds, noon + 70 * 60000).map((a) => a.type);
  for (const t of ['late', 'unassigned', 'not_accepted', 'driver_offline']) assert.ok(types.includes(t), t);
});
test('stats: on-time %, averages and cash only count delivered orders', () => {
  const ds = drivers(); const os = [];
  const deliver = (min) => {
    const o = mk(); os.push(o);
    applyAction(o, 'assign', disp, { driverId: 'd1' }, ctx(os, ds, noon + 1000));
    applyAction(o, 'accept', drv('d1'), {}, ctx(os, ds, noon + 2000));
    applyAction(o, 'pickup', drv('d1'), {}, ctx(os, ds, noon + 3000));
    applyAction(o, 'deliver', drv('d1'), { note: 'handed over', cashCollected: o.amountDue }, ctx(os, ds, noon + min * 60000));
  };
  deliver(30); deliver(50); deliver(80);
  os.push(mk());
  const s = computeStats(os, ds, zones, noon + 100 * 60000);
  assert.equal(s.deliveredCount, 3);
  assert.equal(s.onTimePct, 67);
  assert.equal(s.avgDeliveryMin, 53);
  assert.equal(s.perDriver[0].delivered, 3);
  assert.equal(s.cashCollected, os.slice(0, 3).reduce((x, o) => x + o.amountDue, 0));
});
test('public tracking exposes no phone, street or internal notes', () => {
  const o = mk({ notes: 'secret gate code 1234' });
  const t = publicTracking(o, zones, drivers(), noon);
  const s = JSON.stringify(t);
  assert.ok(!s.includes('01012345678')); assert.ok(!s.includes('12 Road 9')); assert.ok(!s.includes('gate code'));
  assert.equal(t.customerFirstName, 'Sara');
});
