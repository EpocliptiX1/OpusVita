// SQLite database: schema, demo seed data and small helpers.
// Uses Node's built-in SQLite driver (node:sqlite, Node 22.5+), so there is nothing to npm install.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'opusvita.db');
const SLOTS = ['09:30', '11:00', '13:30', '15:00', '16:30', '18:00'];
const SESSION_MIN = 50;

// ---------- date helpers (local time, ISO yyyy-mm-dd) ----------
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const slotStart = (date, slot) => new Date(`${date}T${slot}:00`);

// deterministic random numbers so the demo data looks the same every reset
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  job_title TEXT,
  department TEXT,
  band_model TEXT,
  band_connected INTEGER NOT NULL DEFAULT 1,
  band_battery INTEGER NOT NULL DEFAULT 80,
  band_last_sync TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  notifications INTEGER NOT NULL DEFAULT 1,
  reminder_minutes INTEGER NOT NULL DEFAULT 60,
  checkin_day TEXT NOT NULL DEFAULT 'Mon',
  checkin_time TEXT NOT NULL DEFAULT '10:00',
  default_format TEXT NOT NULL DEFAULT 'video' CHECK (default_format IN ('video','person')),
  default_share INTEGER NOT NULL DEFAULT 1,
  default_calendar INTEGER NOT NULL DEFAULT 1,
  weekly_report INTEGER NOT NULL DEFAULT 1,
  anonymous_stats INTEGER NOT NULL DEFAULT 1,
  theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark'))
);
CREATE TABLE IF NOT EXISTS psychologists (
  id TEXT PRIMARY KEY,
  initials TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  focus TEXT NOT NULL,
  tags TEXT NOT NULL,          -- JSON array, used for matching
  bio TEXT,
  languages TEXT,
  years INTEGER,
  rating REAL,
  sessions_count INTEGER,
  work_days TEXT NOT NULL,     -- weekday numbers, 1 = Monday
  room TEXT,
  color TEXT
);
CREATE TABLE IF NOT EXISTS health_daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  resting_hr INTEGER, hrv INTEGER, spo2 INTEGER,
  sleep_min INTEGER, deep_min INTEGER, rem_min INTEGER, light_min INTEGER, awake_min INTEGER,
  steps INTEGER, active_min INTEGER, stress INTEGER,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  mood INTEGER NOT NULL CHECK (mood BETWEEN 0 AND 4),
  sleep INTEGER NOT NULL CHECK (sleep BETWEEN 0 AND 2),
  energy INTEGER NOT NULL CHECK (energy BETWEEN 1 AND 10),
  overtime INTEGER NOT NULL CHECK (overtime BETWEEN 0 AND 3),
  stressors TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  score REAL NOT NULL,
  level TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  psychologist_id TEXT NOT NULL REFERENCES psychologists(id),
  checkin_id INTEGER REFERENCES checkins(id) ON DELETE SET NULL,
  date TEXT NOT NULL,
  slot TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('video','person')),
  add_calendar INTEGER NOT NULL DEFAULT 1,
  share_summary INTEGER NOT NULL DEFAULT 1,
  remind INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','completed')),
  cancel_reason TEXT,
  reschedule_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- the database itself refuses double-booking a psychologist's slot
CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot
  ON bookings (psychologist_id, date, slot) WHERE status = 'booked';
`;

const PSYCHOLOGISTS = [
  { id: 'as', initials: 'AS', name: 'Dr. Aruzhan Seitkali', role: 'Clinical psychologist', focus: 'Burnout & stress',
    tags: ['Workload', 'Deadlines', 'Manager pressure', 'Low mood'], languages: 'Kazakh, Russian, English', years: 9, rating: 4.9,
    sessions_count: 412, work_days: '12345', room: 'Wellbeing room 4B, 3rd floor', color: '#dcece6',
    bio: 'Helps professionals recognise early signs of burnout and build sustainable work habits.' },
  { id: 'mo', initials: 'MO', name: 'Dr. Marat Ospanov', role: 'Counsellor', focus: 'Work–life balance',
    tags: ['Personal life', 'Commute', 'Overtime'], languages: 'Russian, English', years: 12, rating: 4.8,
    sessions_count: 538, work_days: '124', room: 'Wellbeing room 4B, 3rd floor', color: '#e7e1f2',
    bio: 'Focuses on boundaries, family pressure and getting evenings back.' },
  { id: 'dz', initials: 'DZ', name: 'Dana Zhaksylykova', role: 'CBT therapist', focus: 'Anxiety & sleep',
    tags: ['Sleep', 'Deadlines', 'Low energy'], languages: 'Kazakh, Russian', years: 6, rating: 4.9,
    sessions_count: 267, work_days: '235', room: 'Quiet room 2A, 2nd floor', color: '#e1ebf5',
    bio: 'Short, practical CBT programmes for racing thoughts and poor sleep.' },
  { id: 'ti', initials: 'TI', name: 'Timur Iskakov', role: 'Organisational psychologist', focus: 'Team & conflict',
    tags: ['Team conflict', 'Manager pressure'], languages: 'Kazakh, Russian, English', years: 8, rating: 4.7,
    sessions_count: 301, work_days: '1345', room: 'Wellbeing room 4B, 3rd floor', color: '#f6e6d6',
    bio: 'Mediation-trained; helps with difficult conversations at work.' },
];

function seed(db) {
  const r = rng(42);
  const n = (mid, spread) => Math.round(mid + (r() * 2 - 1) * spread);
  const now = new Date();

  db.prepare(`INSERT INTO users (id,name,email,job_title,department,band_model,band_connected,band_battery,band_last_sync)
              VALUES (1,'Alex Kim','alex.k@company.com','Financial analyst','Finance','Xiaomi Smart Band 8',1,72,?)`)
    .run(new Date(now - 6 * 60000).toISOString());
  // other employees exist only so psychologists' calendars have realistic taken slots
  const others = ['Dias A.', 'Madina S.', 'Ruslan T.', 'Aigerim K.', 'Yerlan B.'];
  others.forEach((name, i) => db.prepare('INSERT INTO users (id,name,email) VALUES (?,?,?)').run(i + 2, name, `user${i + 2}@company.com`));
  db.prepare('INSERT INTO settings (user_id) VALUES (1)').run();

  const ip = db.prepare(`INSERT INTO psychologists (id,initials,name,role,focus,tags,bio,languages,years,rating,sessions_count,work_days,room,color)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const p of PSYCHOLOGISTS) ip.run(p.id, p.initials, p.name, p.role, p.focus, JSON.stringify(p.tags), p.bio, p.languages, p.years, p.rating, p.sessions_count, p.work_days, p.room, p.color);

  // 60 days of wearable data. The last 6 days show a stress pattern
  // (higher resting HR, lower HRV, shorter sleep) - this is what triggers the check-in prompt.
  const ih = db.prepare(`INSERT INTO health_daily VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let ago = 59; ago >= 0; ago--) {
    const d = addDays(now, -ago);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const stressed = ago <= 5;
    const k = stressed ? (6 - ago) / 6 : 0; // ramps up towards today
    const rhr = stressed ? n(70 + k * 9, 1.5) : n(63, 2);
    const hrv = stressed ? n(46 - k * 8, 2) : n(58, 5);
    const sleep = stressed ? n(345, 15) : n(weekend ? 470 : 440, 30);
    const deep = Math.round(sleep * (stressed ? 0.11 : 0.18 + r() * 0.03));
    const rem = Math.round(sleep * (stressed ? 0.17 : 0.22 + r() * 0.02));
    const awake = Math.round(sleep * (stressed ? 0.09 : 0.04));
    let steps = stressed ? n(4600, 900) : n(weekend ? 6200 : 8900, 1800);
    if (ago === 0) steps = Math.round(steps * Math.min(1, Math.max(0.1, (now.getHours() - 7) / 14)));
    ih.run(isoDate(d), rhr, hrv, n(stressed ? 96 : 97, 1), sleep, deep, rem, sleep - deep - rem - awake, awake,
      steps, Math.round(steps / 160), stressed ? n(62 + k * 12, 3) : n(29, 7));
  }

  // earlier check-ins and a completed session, so history screens are not empty
  const ic = db.prepare(`INSERT INTO checkins (user_id,created_at,mood,sleep,energy,overtime,stressors,notes,score,level,summary) VALUES (1,?,?,?,?,?,?,?,?,?,?)`);
  ic.run(addDays(now, -35).toISOString(), 3, 2, 7, 0, '[]', null, 2, 'self-care', 'Good mood, sleeping well, energy 7/10, no overtime.');
  ic.run(addDays(now, -21).toISOString(), 2, 1, 5, 1, '["Personal life"]', null, 5.5, 'chat', 'Okay mood, fair sleep, energy 5/10, overtime 1–2 days. Main stressors: personal life.');
  ic.run(addDays(now, -14).toISOString(), 2, 1, 5, 2, '["Workload"]', null, 7, 'chat', 'Okay mood, fair sleep, energy 5/10, overtime 3–4 days. Main stressors: workload.');
  let past = addDays(now, -20); while (past.getDay() !== 2) past = addDays(past, -1);
  db.prepare(`INSERT INTO bookings (user_id,psychologist_id,checkin_id,date,slot,format,status) VALUES (1,'mo',2,?,'15:00','video','completed')`).run(isoDate(past));

  // fill psychologists' calendars with other employees' bookings
  const ib = db.prepare(`INSERT OR IGNORE INTO bookings (user_id,psychologist_id,date,slot,format) VALUES (?,?,?,?,?)`);
  for (let i = 1; i <= 21; i++) {
    const d = addDays(now, i);
    for (const p of PSYCHOLOGISTS) {
      if (!p.work_days.includes(String(d.getDay()))) continue;
      const count = Math.floor(r() * 4); // 0-3 taken slots per day
      for (let j = 0; j < count; j++) ib.run(2 + Math.floor(r() * 5), p.id, isoDate(d), SLOTS[Math.floor(r() * SLOTS.length)], r() > 0.5 ? 'video' : 'person');
    }
  }
}

function open() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    db.exec('BEGIN');
    try { seed(db); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

function reset(db) {
  db.close();
  for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) fs.rmSync(f, { force: true });
  return open();
}

module.exports = { open, reset, SLOTS, SESSION_MIN, isoDate, addDays, slotStart, rng, DB_FILE };
