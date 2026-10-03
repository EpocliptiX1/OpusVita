// OpusVita API + static file server. Run with: npm start  (or: node server.js)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { open, reset, SLOTS, SESSION_MIN, isoDate, addDays, slotStart, rng } = require('./db');

let db = open();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const USER_ID = 1; // single demo user; real login comes with the security week

const MOODS = ['Very low', 'Low', 'Okay', 'Good', 'Great'];
const SLEEP = ['poor', 'fair', 'good'];
const OVERTIME = ['no overtime', 'overtime 1–2 days', 'overtime 3–4 days', 'overtime every day'];
const STRESSORS = ['Workload', 'Deadlines', 'Team conflict', 'Manager pressure', 'Personal life', 'Commute'];
const REMINDER_OPTIONS = [15, 30, 60, 120, 1440];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const CANCEL_LIMIT_H = 12;

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bool = v => (v ? 1 : 0);
const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// ---------------- data access ----------------
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function getUser() {
  const u = one('SELECT * FROM users WHERE id = ?', USER_ID);
  u.band_connected = !!u.band_connected;
  return u;
}
function getSettings() {
  const s = one('SELECT * FROM settings WHERE user_id = ?', USER_ID);
  for (const k of ['notifications', 'default_share', 'default_calendar', 'weekly_report', 'anonymous_stats']) s[k] = !!s[k];
  return s;
}
function psychologists() {
  return q('SELECT * FROM psychologists').map(p => ({ ...p, tags: JSON.parse(p.tags) }));
}
function psychologist(id) {
  const p = psychologists().find(x => x.id === id);
  if (!p) throw new ApiError(404, 'Psychologist not found');
  return p;
}

// sessions whose time has passed are marked completed automatically
function refreshStatuses() {
  const nowIso = new Date();
  for (const b of q("SELECT id,date,slot FROM bookings WHERE status='booked'"))
    if (slotStart(b.date, b.slot).getTime() + SESSION_MIN * 60000 < nowIso.getTime())
      run("UPDATE bookings SET status='completed', updated_at=datetime('now') WHERE id=?", b.id);
}
function bookingView(b) {
  const p = psychologist(b.psychologist_id);
  const start = slotStart(b.date, b.slot);
  const hoursLeft = (start - Date.now()) / 3600000;
  return {
    ...b, add_calendar: !!b.add_calendar, share_summary: !!b.share_summary, remind: !!b.remind,
    psychologist: { id: p.id, name: p.name, initials: p.initials, role: p.role, color: p.color, room: p.room },
    end: new Date(start.getTime() + SESSION_MIN * 60000).toTimeString().slice(0, 5),
    can_change: b.status === 'booked' && hoursLeft > CANCEL_LIMIT_H,
    hours_left: Math.round(hoursLeft),
  };
}
function userBookings() {
  refreshStatuses();
  return q('SELECT * FROM bookings WHERE user_id = ? ORDER BY date, slot', USER_ID).map(bookingView);
}

// ---------------- availability ----------------
function availableDays(p, excludeBookingId) {
  const days = [];
  const now = new Date();
  for (let i = 0; days.length < 8 && i < 28; i++) {
    const d = addDays(now, i);
    if (!p.work_days.includes(String(d.getDay()))) continue;
    const date = isoDate(d);
    const taken = new Set(q("SELECT slot FROM bookings WHERE psychologist_id=? AND date=? AND status='booked' AND id IS NOT ?", p.id, date, excludeBookingId ?? null).map(x => x.slot));
    const slots = SLOTS.map(time => ({ time, available: !taken.has(time) && slotStart(date, time) - now > 2 * 3600000 }));
    if (i === 0 && !slots.some(s => s.available)) continue; // today is over
    days.push({ date, slots, free: slots.filter(s => s.available).length });
  }
  return days;
}
function nextFree(p) {
  const d = availableDays(p).find(x => x.free > 0);
  return d ? { date: d.date, time: d.slots.find(s => s.available).time } : null;
}
function assertSlotBookable(p, date, slot, excludeId) {
  if (!SLOTS.includes(slot)) throw new ApiError(400, 'Unknown time slot');
  const day = availableDays(p, excludeId).find(d => d.date === date);
  if (!day) throw new ApiError(400, `${p.name} is not available on that date`);
  if (!day.slots.find(s => s.time === slot).available) throw new ApiError(409, 'Sorry, that time was just taken. Please pick another slot.');
}

// ---------------- health analytics ----------------
function healthRange(days) {
  return q('SELECT * FROM health_daily WHERE user_id=? ORDER BY date DESC LIMIT ?', USER_ID, days).reverse();
}
// personal "normal": average of the 30 days before the most recent week
function baseline() {
  const rows = q('SELECT * FROM health_daily WHERE user_id=? ORDER BY date DESC LIMIT 30 OFFSET 7', USER_ID);
  const b = {};
  for (const k of ['resting_hr', 'hrv', 'sleep_min', 'deep_min', 'steps', 'stress', 'spo2']) b[k] = Math.round(avg(rows.map(r => r[k])));
  return b;
}
function wellbeingScore(t, b) {
  const clamp = x => Math.max(0, Math.min(100, x));
  const parts = {
    sleep: clamp((t.sleep_min / 450) * 100),
    recovery: clamp((t.hrv / b.hrv) * 100),
    heart: clamp(100 - Math.max(0, t.resting_hr - b.resting_hr) * 5),
    calm: clamp(100 - t.stress),
  };
  const score = Math.round(parts.sleep * 0.3 + parts.recovery * 0.25 + parts.heart * 0.2 + parts.calm * 0.25);
  const label = score >= 75 ? 'Balanced' : score >= 55 ? 'Under strain' : 'Overloaded';
  return { score, label, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])) };
}
// simulated heart rate for today, every 20 minutes up to now
function intraday() {
  const now = new Date();
  const r = rng(Number(isoDate(now).replace(/-/g, '')));
  const pts = [];
  for (let m = 0; m <= now.getHours() * 60 + now.getMinutes(); m += 20) {
    const h = m / 60;
    let bpm = h < 7 ? 58 + r() * 5 : h < 9 ? 74 + r() * 10 : h < 13 ? 82 + r() * 14 : h < 14 ? 76 + r() * 6 : h < 19 ? 84 + r() * 16 : 72 + r() * 8;
    if (h >= 7 && r() > 0.93) bpm += 20; // short spikes (stairs, stressful meeting)
    pts.push({ t: `${String(Math.floor(h)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`, bpm: Math.round(bpm) });
  }
  return pts;
}

function dashboard() {
  const user = getUser();
  const rows = healthRange(14);
  const today = rows[rows.length - 1];
  const b = baseline();
  let elevatedDays = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].resting_hr >= b.resting_hr + 5; i--) elevatedDays++;
  const last7 = rows.slice(-7);
  const avgSleep = Math.round(avg(rows.slice(-Math.max(elevatedDays, 1)).map(r => r.sleep_min)));
  const bookings = userBookings();
  const lastCheckin = one('SELECT * FROM checkins WHERE user_id=? ORDER BY created_at DESC LIMIT 1', USER_ID);
  const checkinCount = one('SELECT COUNT(*) c FROM checkins WHERE user_id=?', USER_ID).c;
  const checkedInRecently = lastCheckin && Date.now() - new Date(lastCheckin.created_at) < 3 * 86400000;
  return {
    user, settings: getSettings(), today, baseline: b, last7,
    wellbeing: wellbeingScore(today, b),
    alert: elevatedDays >= 3 && !checkedInRecently ? { elevated_days: elevatedDays, avg_sleep: avgSleep } : null,
    elevated_days: elevatedDays,
    upcoming: bookings.find(x => x.status === 'booked') || null,
    last_checkin: lastCheckin ? { ...lastCheckin, stressors: JSON.parse(lastCheckin.stressors) } : null,
    checkin_count: checkinCount,
    intraday: intraday(),
  };
}

// ---------------- check-in scoring ("processing") ----------------
function scoreCheckin(c, health) {
  let s = (4 - c.mood) * 2 + (2 - c.sleep) * 2 + (10 - c.energy) / 2 + c.overtime * 1.5 + c.stressors.length * 0.5;
  if (health.elevated_days >= 3) s += 2; // wearable data backs up the self-report
  s = Math.round(s * 10) / 10;
  return { score: s, level: s >= 10 ? 'session' : s >= 5 ? 'chat' : 'self-care' };
}
function matchPsychologists(c) {
  const wants = new Set(c.stressors);
  if (c.sleep === 0) wants.add('Sleep');
  if (c.mood <= 1) wants.add('Low mood');
  if (c.energy <= 3) wants.add('Low energy');
  if (c.overtime >= 2) wants.add('Overtime');
  return psychologists()
    .map(p => ({ ...p, match: p.tags.filter(t => wants.has(t)).length, next_free: nextFree(p) }))
    .sort((a, b) => b.match - a.match || b.rating - a.rating);
}

// ---------------- routes ----------------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/dashboard', () => dashboard());

route('GET', '/api/health', ({ query }) => {
  const days = Math.min(60, Math.max(7, Number(query.get('days')) || 7));
  return { days: healthRange(days), baseline: baseline() };
});

route('POST', '/api/device/sync', () => {
  const u = getUser();
  if (!u.band_connected) throw new ApiError(400, 'Band is disconnected. Reconnect it in Profile.');
  run("UPDATE users SET band_last_sync=?, band_battery=MAX(5, band_battery-1) WHERE id=?", new Date().toISOString(), USER_ID);
  const today = isoDate(new Date());
  const h = new Date().getHours();
  run('UPDATE health_daily SET steps = MAX(steps, ?) WHERE user_id=? AND date=?', Math.round(4600 * Math.min(1, Math.max(0.1, (h - 7) / 14))), USER_ID, today);
  return dashboard();
});
route('PUT', '/api/device', ({ body }) => {
  run('UPDATE users SET band_connected=? WHERE id=?', bool(body.connected), USER_ID);
  if (body.connected) run('UPDATE users SET band_last_sync=? WHERE id=?', new Date().toISOString(), USER_ID);
  return getUser();
});

route('GET', '/api/me', () => ({ user: getUser(), settings: getSettings() }));
route('PUT', '/api/me', ({ body }) => {
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  if (name.length < 2) throw new ApiError(400, 'Please enter your name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, 'Please enter a valid email address');
  if (one('SELECT 1 FROM users WHERE email=? AND id<>?', email, USER_ID)) throw new ApiError(409, 'That email is already used by another account');
  run('UPDATE users SET name=?, email=?, job_title=?, department=? WHERE id=?', name, email, String(body.job_title || '').trim(), String(body.department || '').trim(), USER_ID);
  return getUser();
});
route('PUT', '/api/settings', ({ body }) => {
  const s = { ...getSettings(), ...body };
  if (!REMINDER_OPTIONS.includes(Number(s.reminder_minutes))) throw new ApiError(400, 'Invalid reminder time');
  if (!DAYS.includes(s.checkin_day)) throw new ApiError(400, 'Invalid check-in day');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.checkin_time)) throw new ApiError(400, 'Invalid check-in time');
  if (!['video', 'person'].includes(s.default_format)) throw new ApiError(400, 'Invalid session format');
  if (!['system', 'light', 'dark'].includes(s.theme)) throw new ApiError(400, 'Invalid theme');
  run(`UPDATE settings SET notifications=?, reminder_minutes=?, checkin_day=?, checkin_time=?, default_format=?, default_share=?,
       default_calendar=?, weekly_report=?, anonymous_stats=?, theme=? WHERE user_id=?`,
    bool(s.notifications), Number(s.reminder_minutes), s.checkin_day, s.checkin_time, s.default_format, bool(s.default_share),
    bool(s.default_calendar), bool(s.weekly_report), bool(s.anonymous_stats), s.theme, USER_ID);
  return getSettings();
});

route('GET', '/api/psychologists', () => psychologists().map(p => ({ ...p, next_free: nextFree(p) })));
route('GET', '/api/psychologists/:id/availability', ({ params, query }) =>
  availableDays(psychologist(params.id), query.get('exclude') ? Number(query.get('exclude')) : null));

route('GET', '/api/checkins', () =>
  q('SELECT * FROM checkins WHERE user_id=? ORDER BY created_at DESC', USER_ID).map(c => ({ ...c, stressors: JSON.parse(c.stressors) })));
route('POST', '/api/checkins', ({ body }) => {
  const c = {
    mood: Number(body.mood), sleep: Number(body.sleep), energy: Number(body.energy), overtime: Number(body.overtime),
    stressors: Array.isArray(body.stressors) ? body.stressors.filter(s => STRESSORS.includes(s)) : [],
    notes: String(body.notes || '').trim().slice(0, 500) || null,
  };
  if (![0, 1, 2, 3, 4].includes(c.mood) || ![0, 1, 2].includes(c.sleep) || !(c.energy >= 1 && c.energy <= 10) || ![0, 1, 2, 3].includes(c.overtime))
    throw new ApiError(400, 'Please answer every question');
  const d = dashboard();
  const { score, level } = scoreCheckin(c, d);
  const avgSleep = Math.round(avg(d.last7.map(r => r.sleep_min)));
  const summary = `${MOODS[c.mood]} mood, ${SLEEP[c.sleep]} sleep (band avg ${Math.floor(avgSleep / 60)}h ${avgSleep % 60}m), energy ${c.energy}/10, ${OVERTIME[c.overtime]}.`
    + (c.stressors.length ? ` Main stressors: ${c.stressors.join(', ').toLowerCase()}.` : '')
    + (d.elevated_days >= 3 ? ` Resting heart rate above normal for ${d.elevated_days} days.` : '');
  const res = run(`INSERT INTO checkins (user_id,created_at,mood,sleep,energy,overtime,stressors,notes,score,level,summary) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    USER_ID, new Date().toISOString(), c.mood, c.sleep, c.energy, c.overtime, JSON.stringify(c.stressors), c.notes, score, level, summary);
  return { id: Number(res.lastInsertRowid), ...c, score, level, summary, elevated_days: d.elevated_days, matches: matchPsychologists(c) };
});
route('DELETE', '/api/checkins', () => {
  run('DELETE FROM checkins WHERE user_id=?', USER_ID);
  return { ok: true };
});

route('GET', '/api/bookings', () => userBookings());
route('POST', '/api/bookings', ({ body }) => {
  const p = psychologist(body.psychologist_id);
  if (!['video', 'person'].includes(body.format)) throw new ApiError(400, 'Choose a session format');
  const upcoming = one("SELECT COUNT(*) c FROM bookings WHERE user_id=? AND status='booked'", USER_ID).c;
  if (upcoming >= 3) throw new ApiError(400, 'You already have 3 upcoming sessions. Cancel one to book another.');
  assertSlotBookable(p, body.date, body.slot);
  try {
    const res = run(`INSERT INTO bookings (user_id,psychologist_id,checkin_id,date,slot,format,add_calendar,share_summary,remind) VALUES (?,?,?,?,?,?,?,?,?)`,
      USER_ID, p.id, body.checkin_id || null, body.date, body.slot, body.format, bool(body.add_calendar), bool(body.share_summary), bool(body.remind));
    return bookingView(one('SELECT * FROM bookings WHERE id=?', res.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'Sorry, that time was just taken. Please pick another slot.');
    throw e;
  }
});
route('PATCH', '/api/bookings/:id', ({ params, body }) => {
  refreshStatuses();
  const b = one('SELECT * FROM bookings WHERE id=? AND user_id=?', Number(params.id), USER_ID);
  if (!b) throw new ApiError(404, 'Session not found');
  if (b.status !== 'booked') throw new ApiError(400, 'This session can no longer be changed');
  if (!bookingView(b).can_change) throw new ApiError(400, `Sessions can only be changed more than ${CANCEL_LIMIT_H} hours before they start. Please contact your psychologist.`);
  if (body.status === 'cancelled') {
    run("UPDATE bookings SET status='cancelled', cancel_reason=?, updated_at=datetime('now') WHERE id=?", String(body.reason || '').slice(0, 200) || null, b.id);
  } else {
    const p = psychologist(b.psychologist_id);
    const format = body.format || b.format;
    if (!['video', 'person'].includes(format)) throw new ApiError(400, 'Invalid format');
    assertSlotBookable(p, body.date, body.slot, b.id);
    run(`UPDATE bookings SET date=?, slot=?, format=?, add_calendar=?, share_summary=?, remind=?, reschedule_count=reschedule_count+1, updated_at=datetime('now') WHERE id=?`,
      body.date, body.slot, format, bool(body.add_calendar ?? b.add_calendar), bool(body.share_summary ?? b.share_summary), bool(body.remind ?? b.remind), b.id);
  }
  return bookingView(one('SELECT * FROM bookings WHERE id=?', b.id));
});

route('GET', '/api/export', () => ({
  exported_at: new Date().toISOString(), user: getUser(), settings: getSettings(),
  checkins: q('SELECT * FROM checkins WHERE user_id=?', USER_ID), bookings: q('SELECT * FROM bookings WHERE user_id=?', USER_ID),
  health_daily: q('SELECT * FROM health_daily WHERE user_id=? ORDER BY date', USER_ID),
}));
route('POST', '/api/reset', () => { db = reset(db); return { ok: true }; });

// ---------------- HTTP plumbing ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e5) reject(new ApiError(413, 'Request too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new ApiError(400, 'Invalid JSON')); } });
  });
}
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) return json(res, 404, { error: 'Not found' });
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = r.handler({ params: url.pathname.match(r.re).groups || {}, query: url.searchParams, body });
      const extra = url.pathname === '/api/export' ? { 'Content-Disposition': 'attachment; filename="opusvita-my-data.json"' } : {};
      console.log(`${req.method} ${url.pathname} 200`);
      return json(res, 200, result, extra);
    } catch (e) {
      const status = e.status || 500;
      console.log(`${req.method} ${url.pathname} ${status} ${e.message}`);
      return json(res, status, { error: status === 500 ? 'Something went wrong on our side' : e.message });
    }
  }
  // static files
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`OpusVita running at http://localhost:${PORT}`));
