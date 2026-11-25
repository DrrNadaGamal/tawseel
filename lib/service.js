import { ACTIONS, FAIL_REASONS, CANCEL_REASONS, applyAction, buildOrder, cleanText, computeAlerts, computeStats, makeCode, normalizeCode, normalizeDigits, publicTracking, quoteFee, slaState, etaFor, validateNewOrder, activeLoad, maskPhone, MAX_ATTEMPTS } from './core.js';
import { signToken, verifyToken, ROLES } from './auth.js';
import { loadState, mutate, RESET_MS } from './store.js';
import { seedState } from './seed.js';

const ok = (json, status = 200) => ({ status, json });
const bad = (error, status = 400, extra = {}) => ({ status, json: { error, ...extra } });

const ERR_STATUS = { forbidden: 403, not_your_order: 403, invalid_transition: 409, driver_offline: 409, driver_at_capacity: 409, already_assigned: 409, max_attempts: 409, busy: 503 };

function actorFrom(headers) {
  const h = headers.authorization || headers.Authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  return verifyToken(t);
}

function orderView(o, state, now, role) {
  const sla = slaState(o, now, state.settings);
  const eta = etaFor(o, now);
  const v = { ...o, sla, etaAt: eta ? eta.at : null, delayed: eta ? eta.delayed : false };
  if (role === 'driver') v.customer = { ...o.customer }; // driver needs the phone to call
  if (role === 'viewer') v.customer = { name: o.customer.name, phone: maskPhone(o.customer.phone) };
  return v;
}

// Rate limit for the public tracking endpoint (per instance, best effort).
const hits = new Map();
export function rateLimited(key, now, max = 40, windowMs = 60000) {
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

export async function handle({ method, path, body, headers = {}, query = {}, ip = 'x', store, now = Date.now(), rand = Math.random }) {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const [a, b, c] = parts;
  body = body && typeof body === 'object' ? body : {};

  if (method === 'GET' && a === 'health') return ok({ ok: true, time: now });

  // ----- public -----
  if (method === 'POST' && a === 'login') {
    const role = body.role;
    if (!ROLES.includes(role)) return bad('bad_role');
    let driverId = null;
    const { state } = await loadState(store, now);
    if (role === 'driver') {
      const d = state.drivers.find((x) => x.id === body.driverId);
      if (!d) return bad('unknown_driver');
      driverId = d.id;
    }
    const token = signToken({ role, driverId }, now);
    return ok({ token, role, driverId });
  }

  if (method === 'GET' && a === 'track' && b) {
    if (rateLimited('track:' + ip, now)) return bad('rate_limited', 429);
    const code = normalizeCode(decodeURIComponent(b));
    if (!code) return bad('bad_code', 400);
    const { state } = await loadState(store, now);
    const o = state.orders.find((x) => x.code === code);
    if (!o) return bad('not_found', 404);
    return ok(publicTracking(o, state.zones, state.drivers, now, state.settings));
  }

  if (method === 'GET' && a === 'demo-drivers') {
    const { state } = await loadState(store, now);
    return ok({ drivers: state.drivers.map((d) => ({ id: d.id, name: d.name, ar: d.ar, vehicle: d.vehicle, status: d.status })) });
  }

  if (method === 'GET' && a === 'demo-codes') {
    // demo convenience so visitors can try the tracking page: a few live codes, nothing else
    const { state } = await loadState(store, now);
    const live = state.orders.filter((o) => ['new', 'assigned', 'accepted', 'picked_up'].includes(o.status)).slice(-12);
    const pickBy = (s) => live.find((o) => o.status === s);
    const list = ['picked_up', 'accepted', 'new'].map(pickBy).filter(Boolean);
    const dlv = state.orders.filter((o) => o.status === 'delivered').slice(-1)[0];
    if (dlv) list.push(dlv);
    return ok({ codes: list.map((o) => ({ code: o.code, status: o.status })) });
  }

  if (method === 'POST' && a === 'quote') {
    const zones = (await loadState(store, now)).state;
    const q = quoteFee({ zoneId: body.zoneId, weightKg: Number(normalizeDigits(body.weightKg)), subtotal: Number(normalizeDigits(body.subtotal)), priority: body.priority, payment: body.payment }, zones.zones, zones.settings, now);
    if (!q.ok) return bad(q.error);
    return ok(q);
  }

  // ----- authenticated -----
  const actor = actorFrom(headers);
  if (!actor) return bad('unauthorized', 401);
  const role = actor.role;

  if (method === 'GET' && a === 'state') {
    const { state } = await loadState(store, now);
    let orders = state.orders;
    if (role === 'driver') orders = orders.filter((o) => o.driverId === actor.driverId || o.events.some((e) => e.driverId === actor.driverId && e.status === 'delivered'));
    const views = orders.map((o) => orderView(o, state, now, role));
    const out = { now, role, driverId: actor.driverId, zones: state.zones, settings: role === 'driver' ? undefined : state.settings, drivers: state.drivers.map((d) => ({ ...d, active: activeLoad(state.orders, d.id), phone: role === 'viewer' ? maskPhone(d.phone) : d.phone })), orders: views, nextReset: state.seededAt + RESET_MS, version: state.version || 0, constants: { failReasons: FAIL_REASONS, cancelReasons: CANCEL_REASONS, maxAttempts: MAX_ATTEMPTS } };
    if (role !== 'driver') {
      out.alerts = computeAlerts(state.orders, state.drivers, now, state.settings);
      out.stats = computeStats(state.orders, state.drivers, state.zones, now, 24, state.settings);
    } else {
      out.alerts = computeAlerts(orders, state.drivers, now, state.settings).filter((x) => x.type === 'late' || x.type === 'at_risk');
    }
    return ok(out);
  }

  if (method === 'POST' && a === 'orders' && !b) {
    if (!['admin', 'dispatcher'].includes(role)) return bad('forbidden', 403);
    const r = await mutate(store, now, (state) => {
      const v = validateNewOrder(body, state.zones, now, state.settings);
      if (!v.ok) return { ok: false, validation: v.errors };
      const used = new Set(state.orders.map((o) => o.code));
      let code; do code = makeCode(rand); while (used.has(code));
      const o = buildOrder(v.data, state.seq++, code, now);
      state.orders.push(o);
      return { ok: true, order: o };
    });
    if (r.validation) return bad('validation', 422, { fields: r.validation });
    if (!r.ok) return bad(r.error, ERR_STATUS[r.error] || 400);
    return ok({ order: r.order }, 201);
  }

  if (method === 'POST' && a === 'orders' && b && c && ACTIONS[c]) {
    const clientActionId = cleanText(body.clientActionId, 64);
    const r = await mutate(store, now, (state) => {
      const o = state.orders.find((x) => x.id === b);
      if (!o) return { ok: false, error: 'not_found' };
      state.usedActions ||= {};
      if (clientActionId && state.usedActions[clientActionId]) return { ok: true, duplicate: true, noWrite: true, order: o };
      const res = applyAction(o, c, actor, body, { orders: state.orders, drivers: state.drivers, now, settings: state.settings });
      if (res.ok && clientActionId) {
        state.usedActions[clientActionId] = now;
        const keys = Object.keys(state.usedActions);
        if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete state.usedActions[k];
      }
      return res;
    });
    if (!r.ok) return bad(r.error, r.error === 'not_found' ? 404 : r.error === 'busy' ? 503 : ERR_STATUS[r.error] || 422, { from: r.from });
    return ok({ order: r.order, duplicate: !!r.duplicate });
  }

  if (method === 'POST' && a === 'drivers' && b && c === 'status') {
    if (role === 'viewer') return bad('forbidden', 403);
    if (role === 'driver' && actor.driverId !== b) return bad('forbidden', 403);
    if (!['online', 'offline'].includes(body.status)) return bad('bad_status');
    const r = await mutate(store, now, (state) => {
      const d = state.drivers.find((x) => x.id === b);
      if (!d) return { ok: false, error: 'not_found' };
      if (body.status === 'offline' && activeLoad(state.orders, d.id) > 0 && role === 'driver') return { ok: false, error: 'has_active_orders' };
      d.status = body.status;
      return { ok: true, driver: d };
    });
    if (!r.ok) return bad(r.error, r.error === 'not_found' ? 404 : 409);
    return ok({ driver: r.driver });
  }

  if (method === 'PUT' && a === 'zones' && b) {
    if (role !== 'admin') return bad('forbidden', 403);
    const baseFee = Number(normalizeDigits(body.baseFee)), slaMin = Number(normalizeDigits(body.slaMin));
    if (!Number.isInteger(baseFee) || baseFee < 0 || baseFee > 500) return bad('bad_fee', 422);
    if (!Number.isInteger(slaMin) || slaMin < 20 || slaMin > 360) return bad('bad_sla', 422);
    const r = await mutate(store, now, (state) => {
      const z = state.zones.find((x) => x.id === b);
      if (!z) return { ok: false, error: 'not_found' };
      z.baseFee = baseFee; z.slaMin = slaMin;
      return { ok: true, zone: z };
    });
    if (!r.ok) return bad(r.error, 404);
    return ok({ zone: r.zone });
  }

  if (method === 'PUT' && a === 'settings') {
    if (role !== 'admin') return bad('forbidden', 403);
    const lim = { freeDeliveryOver: [0, 100000], nightSurcharge: [0, 200], expressMultiplierPct: [100, 400], perExtraKg: [0, 100], maxActivePerDriver: [1, 12] };
    const patch = {};
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      if (body[k] === undefined) continue;
      const n = Number(normalizeDigits(body[k]));
      if (!Number.isFinite(n) || n < lo || n > hi) return bad('bad_' + k, 422);
      patch[k] = n;
    }
    const r = await mutate(store, now, (state) => { Object.assign(state.settings, patch); return { ok: true, settings: state.settings }; });
    return ok({ settings: r.settings });
  }

  if (method === 'POST' && a === 'reset') {
    if (role !== 'admin') return bad('forbidden', 403);
    const r = await mutate(store, now, (state) => { const fresh = seedState(now); for (const k of Object.keys(state)) delete state[k]; Object.assign(state, fresh); return { ok: true }; });
    return ok({ ok: !!r.ok });
  }

  return bad('not_found', 404);
}
