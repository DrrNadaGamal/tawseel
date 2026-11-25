// Tawseel core: pure business logic (no I/O). Every function takes `now` explicitly so it is testable.

export const TERMINAL = ['delivered', 'failed_final', 'cancelled'];
export const PIPELINE = ['new', 'assigned', 'accepted', 'picked_up', 'delivered'];
export const MAX_ATTEMPTS = 3;

export const FAIL_REASONS = ['no_answer', 'wrong_address', 'refused', 'unreachable', 'other'];
export const CANCEL_REASONS = ['customer_request', 'merchant_request', 'duplicate', 'out_of_zone', 'other'];

export const DEFAULT_SETTINGS = {
  nightStartHour: 22,
  nightEndHour: 6,
  nightSurcharge: 15,
  expressMultiplierPct: 150,
  freeWeightKg: 5,
  perExtraKg: 4,
  freeDeliveryOver: 1500,
  codFeePct: 1,
  codFeeMin: 5,
  codFeeMax: 25,
  maxActivePerDriver: 4,
  atRiskPct: 75,
  expressSlaPct: 60,
  unassignedAlertMin: 5,
  unacceptedAlertMin: 4,
  notPickedAlertMin: 15,
};

export const DEFAULT_ZONES = [
  { id: 'z-nasr', en: 'Nasr City', ar: 'مدينة نصر', baseFee: 30, slaMin: 60 },
  { id: 'z-heliopolis', en: 'Heliopolis', ar: 'مصر الجديدة', baseFee: 35, slaMin: 60 },
  { id: 'z-maadi', en: 'Maadi', ar: 'المعادي', baseFee: 40, slaMin: 75 },
  { id: 'z-zamalek', en: 'Zamalek', ar: 'الزمالك', baseFee: 35, slaMin: 60 },
  { id: 'z-dokki', en: 'Dokki / Mohandessin', ar: 'الدقي والمهندسين', baseFee: 40, slaMin: 70 },
  { id: 'z-newcairo', en: 'New Cairo', ar: 'القاهرة الجديدة', baseFee: 55, slaMin: 90 },
  { id: 'z-october', en: '6th of October', ar: 'السادس من أكتوبر', baseFee: 65, slaMin: 110 },
  { id: 'z-shubra', en: 'Shubra', ar: 'شبرا', baseFee: 35, slaMin: 75 },
];

// ---------- helpers ----------
export function cairoHour(ms) {
  const h = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Cairo' }).format(new Date(ms));
  return Number(h) % 24;
}

export function isNight(ms, s = DEFAULT_SETTINGS) {
  const h = cairoHour(ms);
  const a = s.nightStartHour, b = s.nightEndHour;
  return a > b ? h >= a || h < b : h >= a && h < b;
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
export function makeCode(rand = Math.random) {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
  return 'TWS-' + c;
}
export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = raw.startsWith('TWS') ? raw.slice(3) : raw;
  if (!/^[A-HJKMNP-Z2-9]{6}$/.test(body)) return null;
  return 'TWS-' + body;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
export function normalizeDigits(str) {
  return String(str ?? '').replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d));
}

// Egyptian mobile numbers: 01[0125]xxxxxxxx, with optional +20 / 0020 / 20 prefix.
export function normalizePhone(input) {
  let p = normalizeDigits(input).replace(/[\s\-().]/g, '');
  if (p.startsWith('+20')) p = '0' + p.slice(3);
  else if (p.startsWith('0020')) p = '0' + p.slice(4);
  else if (p.startsWith('20') && p.length === 12) p = '0' + p.slice(2);
  return /^01[0125]\d{8}$/.test(p) ? p : null;
}
export function maskPhone(p) {
  return p ? p.slice(0, 3) + '****' + p.slice(-4) : '';
}

export function cleanText(v, max = 200) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// ---------- fee rules ----------
export function quoteFee(input, zones, settings = DEFAULT_SETTINGS, now = Date.now()) {
  const zone = zones.find((z) => z.id === input.zoneId);
  if (!zone) return { ok: false, error: 'unknown_zone' };
  const weight = Number(input.weightKg);
  const subtotal = Number(input.subtotal);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 60) return { ok: false, error: 'bad_weight' };
  if (!Number.isFinite(subtotal) || subtotal < 0 || subtotal > 100000) return { ok: false, error: 'bad_subtotal' };
  const express = input.priority === 'express';
  const cod = input.payment === 'cod';
  const lines = [];

  const freeOver = express ? false : subtotal >= settings.freeDeliveryOver;
  lines.push({ key: 'base', amount: zone.baseFee });
  const extraKg = Math.max(0, Math.ceil(weight - settings.freeWeightKg));
  const weightFee = extraKg * settings.perExtraKg;
  if (weightFee) lines.push({ key: 'weight', amount: weightFee });
  let running = zone.baseFee + weightFee;
  if (express) {
    const expressTotal = Math.round((running * settings.expressMultiplierPct) / 100);
    lines.push({ key: 'express', amount: expressTotal - running });
    running = expressTotal;
  }
  if (isNight(now, settings)) {
    lines.push({ key: 'night', amount: settings.nightSurcharge });
    running += settings.nightSurcharge;
  }
  if (freeOver) {
    // Free delivery waives the zone base fee only, never weight or night surcharges.
    lines.push({ key: 'free_delivery', amount: -zone.baseFee });
    running -= zone.baseFee;
  }
  if (cod) {
    const raw = Math.round((subtotal * settings.codFeePct) / 100);
    const codFee = Math.min(settings.codFeeMax, Math.max(settings.codFeeMin, raw));
    lines.push({ key: 'cod', amount: codFee });
    running += codFee;
  }
  return { ok: true, lines, fee: running, zoneId: zone.id, express, cod, night: isNight(now, settings) };
}

// ---------- SLA ----------
export function slaMinutesFor(zone, priority, settings = DEFAULT_SETTINGS) {
  const base = zone.slaMin;
  return priority === 'express' ? Math.max(20, Math.round((base * settings.expressSlaPct) / 100)) : base;
}

export function slaState(order, now, settings = DEFAULT_SETTINGS) {
  const total = order.slaMin * 60000;
  if (order.status === 'delivered') {
    return order.deliveredAt - order.createdAt <= total ? 'on_time' : 'late_delivered';
  }
  if (TERMINAL.includes(order.status)) return 'closed';
  const elapsed = now - order.createdAt;
  if (elapsed > total) return 'late';
  if (elapsed >= (total * settings.atRiskPct) / 100) return 'at_risk';
  return 'ok';
}

export function etaFor(order, now) {
  if (TERMINAL.includes(order.status)) return null;
  const due = order.createdAt + order.slaMin * 60000;
  if (now <= due) return { at: due, delayed: false };
  return { at: now + 15 * 60000, delayed: true };
}

// ---------- state machine ----------
// action -> { from: [statuses], to: status, roles: [...] }
export const ACTIONS = {
  assign: { from: ['new', 'assigned', 'accepted'], to: 'assigned', roles: ['admin', 'dispatcher'] },
  unassign: { from: ['assigned', 'accepted'], to: 'new', roles: ['admin', 'dispatcher'] },
  accept: { from: ['assigned'], to: 'accepted', roles: ['driver'] },
  decline: { from: ['assigned', 'accepted'], to: 'new', roles: ['driver'] },
  pickup: { from: ['accepted'], to: 'picked_up', roles: ['driver', 'admin', 'dispatcher'] },
  deliver: { from: ['picked_up'], to: 'delivered', roles: ['driver', 'admin', 'dispatcher'] },
  fail: { from: ['picked_up'], to: 'failed', roles: ['driver', 'admin', 'dispatcher'] },
  redispatch: { from: ['failed'], to: 'new', roles: ['admin', 'dispatcher'] },
  cancel: { from: ['new', 'assigned', 'accepted', 'failed'], to: 'cancelled', roles: ['admin', 'dispatcher'] },
};

export function activeLoad(orders, driverId) {
  return orders.filter((o) => o.driverId === driverId && ['assigned', 'accepted', 'picked_up'].includes(o.status)).length;
}

function err(code, extra = {}) {
  return { ok: false, error: code, ...extra };
}

/**
 * Apply an action to an order. Mutates the order and `ctx.drivers` data on success.
 * actor: { role, driverId?, name }
 * payload: { driverId?, note?, reason?, cashCollected?, recipient? }
 */
export function applyAction(order, action, actor, payload, ctx) {
  const { orders, drivers, now, settings = DEFAULT_SETTINGS } = ctx;
  const def = ACTIONS[action];
  if (!def) return err('unknown_action');
  if (actor.role === 'viewer') return err('forbidden');
  if (!def.roles.includes(actor.role)) return err('forbidden');
  if (actor.role === 'driver') {
    if (action !== 'assign' && order.driverId !== actor.driverId) return err('not_your_order');
  }
  if (!def.from.includes(order.status)) {
    return err('invalid_transition', { from: order.status, action });
  }
  const note = cleanText(payload.note, 240);
  let eventNote = note;

  if (action === 'assign') {
    const d = drivers.find((x) => x.id === payload.driverId);
    if (!d) return err('unknown_driver');
    if (d.status === 'offline') return err('driver_offline');
    if (order.status === 'accepted' && order.driverId === d.id) return err('already_assigned');
    if (order.driverId !== d.id && activeLoad(orders, d.id) >= settings.maxActivePerDriver) return err('driver_at_capacity');
    order.driverId = d.id;
    order.assignedAt = now;
    eventNote = note || (d.zones.includes(order.zoneId) ? '' : 'outside_driver_zones');
  }
  if (action === 'unassign' || action === 'decline') {
    if (action === 'decline' && !note) return err('note_required');
    order.driverId = null;
  }
  if (action === 'pickup') order.pickedUpAt = now;
  if (action === 'deliver') {
    if (note.length < 4) return err('proof_required');
    if (order.payment === 'cod') {
      const cash = Number(payload.cashCollected);
      if (!Number.isFinite(cash)) return err('cash_required');
      order.cashCollected = cash;
      if (cash !== order.amountDue) eventNote = (note + ' [cash_mismatch ' + cash + '/' + order.amountDue + ']').trim();
      order.cashMismatch = cash !== order.amountDue;
    }
    order.recipient = cleanText(payload.recipient, 60) || order.customer.name;
    order.deliveredAt = now;
    order.proofNote = note;
  }
  if (action === 'fail') {
    const reason = payload.reason;
    if (!FAIL_REASONS.includes(reason)) return err('reason_required');
    if (reason === 'other' && note.length < 4) return err('note_required');
    order.attempts += 1;
    order.lastFailReason = reason;
    eventNote = (reason + (note ? ': ' + note : '')).trim();
    if (order.attempts >= MAX_ATTEMPTS) {
      // Too many attempts: stays "failed" and can only be cancelled.
      order.maxAttemptsReached = true;
    }
  }
  if (action === 'redispatch') {
    if (order.attempts >= MAX_ATTEMPTS) return err('max_attempts');
    order.driverId = null;
  }
  if (action === 'cancel') {
    const reason = payload.reason;
    if (!CANCEL_REASONS.includes(reason)) return err('reason_required');
    if (reason === 'other' && note.length < 4) return err('note_required');
    eventNote = (reason + (note ? ': ' + note : '')).trim();
    order.cancelledAt = now;
    order.cancelReason = reason;
  }

  const to = def.to;
  order.status = to;
  order.updatedAt = now;
  order.events.push({ at: now, status: to, action, by: actor.role === 'driver' ? 'driver:' + actor.driverId : actor.role, driverId: order.driverId || null, note: eventNote });
  return { ok: true, order };
}

export function validateNewOrder(body, zones, now, settings = DEFAULT_SETTINGS) {
  const errors = {};
  const name = cleanText(body.customerName, 60);
  if (name.length < 2) errors.customerName = 'required';
  const phone = normalizePhone(body.customerPhone);
  if (!phone) errors.customerPhone = 'invalid_phone';
  const merchant = cleanText(body.merchant, 60);
  if (merchant.length < 2) errors.merchant = 'required';
  const street = cleanText(body.street, 140);
  if (street.length < 5) errors.street = 'required';
  const zone = zones.find((z) => z.id === body.zoneId);
  if (!zone) errors.zoneId = 'unknown_zone';
  const weightKg = Number(normalizeDigits(body.weightKg));
  if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 60) errors.weightKg = 'bad_weight';
  const subtotal = Number(normalizeDigits(body.subtotal));
  if (!Number.isFinite(subtotal) || subtotal < 0 || subtotal > 100000) errors.subtotal = 'bad_subtotal';
  const items = Math.round(Number(normalizeDigits(body.items || 1)));
  if (!Number.isFinite(items) || items < 1 || items > 99) errors.items = 'bad_items';
  const priority = body.priority === 'express' ? 'express' : 'standard';
  const payment = body.payment === 'paid' ? 'paid' : 'cod';
  if (Object.keys(errors).length) return { ok: false, errors };
  const q = quoteFee({ zoneId: zone.id, weightKg, subtotal, priority, payment }, zones, settings, now);
  if (!q.ok) return { ok: false, errors: { quote: q.error } };
  return {
    ok: true,
    data: {
      customer: { name, phone },
      merchant,
      street,
      zoneId: zone.id,
      notes: cleanText(body.notes, 160),
      weightKg,
      subtotal,
      items,
      priority,
      payment,
      fee: q.fee,
      feeLines: q.lines,
      amountDue: payment === 'cod' ? subtotal + q.fee : 0,
      slaMin: slaMinutesFor(zone, priority, settings),
    },
  };
}

export function buildOrder(data, seq, code, now) {
  return {
    id: 'ORD-' + seq,
    code,
    ...data,
    status: 'new',
    driverId: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, status: 'new', action: 'create', by: 'system', note: '' }],
  };
}

// ---------- alerts ----------
export function computeAlerts(orders, drivers, now, settings = DEFAULT_SETTINGS) {
  const out = [];
  const min = (a) => Math.floor((now - a) / 60000);
  for (const o of orders) {
    if (TERMINAL.includes(o.status)) continue;
    const s = slaState(o, now, settings);
    if (s === 'late') out.push({ type: 'late', severity: 'high', orderId: o.id, minutes: min(o.createdAt + o.slaMin * 60000) });
    else if (s === 'at_risk') out.push({ type: 'at_risk', severity: 'medium', orderId: o.id, minutes: Math.max(0, Math.ceil((o.createdAt + o.slaMin * 60000 - now) / 60000)) });
    if (o.status === 'new' && min(o.createdAt) >= settings.unassignedAlertMin) out.push({ type: 'unassigned', severity: 'medium', orderId: o.id, minutes: min(o.createdAt) });
    if (o.status === 'assigned' && o.assignedAt && min(o.assignedAt) >= settings.unacceptedAlertMin) out.push({ type: 'not_accepted', severity: 'medium', orderId: o.id, minutes: min(o.assignedAt) });
    if (o.status === 'accepted') {
      const accAt = lastEventAt(o, 'accepted') || o.updatedAt;
      if (min(accAt) >= settings.notPickedAlertMin) out.push({ type: 'not_picked', severity: 'medium', orderId: o.id, minutes: min(accAt) });
    }
    if (o.driverId && ['assigned', 'accepted', 'picked_up'].includes(o.status)) {
      const d = drivers.find((x) => x.id === o.driverId);
      if (d && d.status === 'offline') out.push({ type: 'driver_offline', severity: 'high', orderId: o.id, driverId: d.id });
    }
    if (o.status === 'failed') out.push({ type: 'failed', severity: 'high', orderId: o.id, attempts: o.attempts });
  }
  const rank = { high: 0, medium: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function lastEventAt(o, status) {
  for (let i = o.events.length - 1; i >= 0; i--) if (o.events[i].status === status) return o.events[i].at;
  return null;
}

// ---------- stats ----------
export function computeStats(orders, drivers, zones, now, windowHours = 24, settings = DEFAULT_SETTINGS) {
  const since = now - windowHours * 3600000;
  const inWin = orders.filter((o) => o.createdAt >= since);
  const delivered = inWin.filter((o) => o.status === 'delivered');
  const failedOrders = inWin.filter((o) => o.attempts > 0);
  const onTime = delivered.filter((o) => o.deliveredAt - o.createdAt <= o.slaMin * 60000);
  const mins = (o) => (o.deliveredAt - o.createdAt) / 60000;
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);

  const perDriver = drivers.map((d) => {
    const mine = delivered.filter((o) => o.driverId === d.id || o.events.some((e) => e.status === 'delivered' && e.driverId === d.id));
    const own = mine.filter((o) => o.events.some((e) => e.status === 'delivered' && e.driverId === d.id));
    const ot = own.filter((o) => o.deliveredAt - o.createdAt <= o.slaMin * 60000);
    const fails = inWin.filter((o) => o.events.some((e) => e.action === 'fail' && e.driverId === d.id)).length;
    return {
      driverId: d.id,
      delivered: own.length,
      onTimePct: pct(ot.length, own.length),
      avgMin: avg(own.map(mins)),
      failed: fails,
      active: activeLoad(orders, d.id),
      cash: own.reduce((s, o) => s + (o.cashCollected || 0), 0),
    };
  });

  const perZone = zones.map((z) => {
    const zo = inWin.filter((o) => o.zoneId === z.id);
    const zd = zo.filter((o) => o.status === 'delivered');
    const zl = zd.filter((o) => o.deliveredAt - o.createdAt > o.slaMin * 60000);
    return { zoneId: z.id, orders: zo.length, delivered: zd.length, avgMin: avg(zd.map(mins)), latePct: pct(zl.length, zd.length) };
  });

  const buckets = [];
  for (let i = windowHours - 1; i >= 0; i--) {
    const start = now - (i + 1) * 3600000;
    const end = now - i * 3600000;
    buckets.push({ hourStart: start, created: orders.filter((o) => o.createdAt >= start && o.createdAt < end).length, delivered: orders.filter((o) => o.deliveredAt && o.deliveredAt >= start && o.deliveredAt < end).length });
  }

  return {
    windowHours,
    created: inWin.length,
    deliveredCount: delivered.length,
    onTimePct: pct(onTime.length, delivered.length),
    avgDeliveryMin: avg(delivered.map(mins)),
    failedAttemptPct: pct(failedOrders.length, inWin.length),
    feeRevenue: delivered.reduce((s, o) => s + o.fee, 0),
    cashCollected: delivered.reduce((s, o) => s + (o.cashCollected || 0), 0),
    cashMismatches: delivered.filter((o) => o.cashMismatch).length,
    active: orders.filter((o) => ['assigned', 'accepted', 'picked_up'].includes(o.status)).length,
    byStatus,
    perDriver,
    perZone,
    buckets,
  };
}

// ---------- public tracking view ----------
export function publicTracking(order, zones, drivers, now, settings = DEFAULT_SETTINGS) {
  const zone = zones.find((z) => z.id === order.zoneId);
  const driver = order.driverId ? drivers.find((d) => d.id === order.driverId) : null;
  const visible = ['new', 'assigned', 'picked_up', 'delivered', 'failed', 'cancelled'];
  const timeline = [];
  for (const e of order.events) {
    if (!visible.includes(e.status)) continue;
    const label = e.status === 'new' && e.action === 'create' ? 'placed' : e.status === 'new' ? 'back_in_queue' : e.status;
    timeline.push({ at: e.at, step: label });
  }
  const eta = etaFor(order, now);
  const sla = slaState(order, now, settings);
  return {
    code: order.code,
    status: order.status,
    publicStage: stageOf(order),
    customerFirstName: order.customer.name.split(' ')[0],
    zone: zone ? { en: zone.en, ar: zone.ar } : null,
    priority: order.priority,
    merchant: order.merchant,
    items: order.items,
    amountDue: order.payment === 'cod' ? order.amountDue : 0,
    payment: order.payment,
    createdAt: order.createdAt,
    deliveredAt: order.deliveredAt || null,
    eta,
    delayed: sla === 'late',
    attempts: order.attempts,
    driver: driver && ['assigned', 'accepted', 'picked_up'].includes(order.status) ? { firstName: driver.name.split(' ')[0], vehicle: driver.vehicle } : null,
    timeline,
  };
}

// Customer-facing stage index 0..3: placed, preparing/assigned, on the way, delivered
export function stageOf(order) {
  switch (order.status) {
    case 'new': return 0;
    case 'assigned':
    case 'accepted': return 1;
    case 'picked_up': return 2;
    case 'delivered': return 3;
    default: return order.status === 'failed' ? 2 : 0;
  }
}
