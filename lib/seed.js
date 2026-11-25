import { DEFAULT_SETTINGS, DEFAULT_ZONES, applyAction, buildOrder, makeCode, validateNewOrder } from './core.js';

// Deterministic PRNG so seeds are reproducible in tests.
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DRIVERS = [
  { id: 'd-karim', name: 'Karim Hassan', ar: 'كريم حسن', vehicle: 'motorbike', phone: '01012345601', zones: ['z-nasr', 'z-heliopolis', 'z-newcairo'], status: 'online' },
  { id: 'd-mona', name: 'Mona Adel', ar: 'منى عادل', vehicle: 'motorbike', phone: '01112345602', zones: ['z-maadi', 'z-zamalek', 'z-dokki'], status: 'online' },
  { id: 'd-youssef', name: 'Youssef Samir', ar: 'يوسف سمير', vehicle: 'car', phone: '01212345603', zones: ['z-october', 'z-dokki', 'z-zamalek'], status: 'online' },
  { id: 'd-hany', name: 'Hany Mostafa', ar: 'هاني مصطفى', vehicle: 'motorbike', phone: '01512345604', zones: ['z-shubra', 'z-heliopolis', 'z-nasr'], status: 'online' },
  { id: 'd-salma', name: 'Salma Reda', ar: 'سلمى رضا', vehicle: 'van', phone: '01012345605', zones: ['z-newcairo', 'z-maadi', 'z-nasr'], status: 'offline' },
];

const CUSTOMERS = [
  ['Ahmed Fathy', 'أحمد فتحي'], ['Nourhan Ali', 'نورهان علي'], ['Mahmoud Sayed', 'محمود سيد'], ['Heba Ragab', 'هبة رجب'],
  ['Omar Tarek', 'عمر طارق'], ['Rania Hosny', 'رانيا حسني'], ['Tamer Gaber', 'تامر جابر'], ['Dina Wahba', 'دينا وهبة'],
  ['Walid Nasser', 'وليد ناصر'], ['Mariam Sherif', 'مريم شريف'], ['Khaled Ezzat', 'خالد عزت'], ['Sara Mounir', 'سارة منير'],
];
const MERCHANTS = ['Zahret El Madina Pharmacy', 'Bab El Hara Grill', 'Cairo Books', 'Nile Electronics', 'Baladi Bakery', 'Green Basket Market', 'Layali Sweets'];
const STREETS = ['12 Mostafa El Nahas St', '45 Road 9', '3 Abbas El Akkad St', '27 El Tahrir St', '8 Salah Salem Rd', '19 El Nozha St', '61 Makram Ebeid St', '5 Al Hegaz St', '33 El Laselky St', '90 Street 233'];

const MIN = 60000;

// Build a believable day of orders by replaying real actions through the same state machine the API uses.
export function seedState(now, rand = mulberry(20261125)) {
  const zones = DEFAULT_ZONES.map((z) => ({ ...z }));
  const settings = { ...DEFAULT_SETTINGS };
  const drivers = DRIVERS.map((d) => ({ ...d, zones: [...d.zones] }));
  const orders = [];
  const used = new Set();
  const pick = (a) => a[Math.floor(rand() * a.length)];
  let seq = 1001;
  const code = () => { let c; do c = makeCode(rand); while (used.has(c)); used.add(c); return c; };
  const phone = () => '01' + pick(['0', '1', '2', '5']) + String(10000000 + Math.floor(rand() * 89999999));

  // plan: list of [minutesAfterCreate, action, payloadFn]
  function add(ageMin, stage, driverId, opts = {}) {
    const zone = opts.zone ? zones.find((z) => z.id === opts.zone) : pick(zones);
    const created = now - ageMin * MIN;
    const v = validateNewOrder({
      customerName: pick(CUSTOMERS)[0], customerPhone: phone(), merchant: pick(MERCHANTS), street: pick(STREETS), zoneId: zone.id,
      weightKg: Math.round((0.5 + rand() * 9) * 2) / 2, subtotal: Math.round((120 + rand() * 1700) / 5) * 5,
      items: 1 + Math.floor(rand() * 5), priority: opts.priority || (rand() < 0.2 ? 'express' : 'standard'), payment: rand() < 0.65 ? 'cod' : 'paid',
    }, zones, created, settings);
    const o = buildOrder(v.data, seq++, code(), created);
    orders.push(o);
    const steps = { assigned: 1, accepted: 2, picked_up: 3, delivered: 4, failed: 4, cancelled: 1 }[stage] || 0;
    const t = (m) => created + m * MIN;
    const ctx = (m) => ({ orders, drivers, now: t(m), settings });
    const drv = { role: 'driver', driverId };
    const disp = { role: 'dispatcher' };
    const dur = opts.deliverAfter || 28 + Math.floor(rand() * 40);
    if (steps >= 1 && stage !== 'cancelled') applyAction(o, 'assign', disp, { driverId }, ctx(opts.assignAfter ?? 3));
    if (steps >= 2) applyAction(o, 'accept', drv, {}, ctx((opts.assignAfter ?? 3) + (opts.acceptAfter ?? 2)));
    if (steps >= 3) applyAction(o, 'pickup', drv, {}, ctx(Math.min(dur - 8, 14 + Math.floor(rand() * 10))));
    if (stage === 'delivered') applyAction(o, 'deliver', drv, { note: 'Handed to customer at door', cashCollected: o.amountDue, recipient: o.customer.name }, ctx(dur));
    if (stage === 'failed') applyAction(o, 'fail', drv, { reason: 'no_answer', note: 'Called twice' }, ctx(dur));
    if (stage === 'cancelled') applyAction(o, 'cancel', disp, { reason: 'customer_request' }, ctx(6));
    return o;
  }

  const live = ['d-karim', 'd-mona', 'd-youssef', 'd-hany'];
  // history: delivered earlier today, mostly on time
  for (let i = 0; i < 26; i++) {
    const late = i % 7 === 3;
    add(150 + i * 28 + Math.floor(rand() * 10), 'delivered', live[i % 4], { deliverAfter: late ? 95 + Math.floor(rand() * 40) : 26 + Math.floor(rand() * 38) });
  }
  add(400, 'delivered', 'd-karim', { deliverAfter: 118 });
  add(300, 'cancelled', 'd-mona');
  add(210, 'cancelled', 'd-hany');
  // live board
  add(2, 'new', null);
  add(7, 'new', null, { zone: 'z-nasr' });
  add(12, 'new', null, { priority: 'express', zone: 'z-maadi' });
  add(18, 'assigned', 'd-mona', { assignAfter: 12, zone: 'z-zamalek' });
  add(25, 'accepted', 'd-karim', { zone: 'z-nasr' });
  add(33, 'accepted', 'd-hany', { zone: 'z-shubra' });
  add(41, 'picked_up', 'd-youssef', { zone: 'z-dokki' });
  add(52, 'picked_up', 'd-karim', { zone: 'z-newcairo' });
  add(58, 'picked_up', 'd-mona', { zone: 'z-maadi' });
  add(95, 'picked_up', 'd-hany', { zone: 'z-heliopolis' }); // late
  add(48, 'picked_up', 'd-youssef', { priority: 'express', zone: 'z-zamalek' }); // late express
  add(20, 'failed', 'd-mona', { zone: 'z-zamalek', deliverAfter: 19 });
  orders.sort((a, b) => a.createdAt - b.createdAt);
  return { version: 1, seededAt: now, seq, zones, settings, drivers, orders, usedActions: {} };
}
