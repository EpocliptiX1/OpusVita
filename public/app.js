// OpusVita front-end: screens, state and user actions. Talks to the server only through api.js.

// ---------------- constants ----------------
const MOODS = ['Very low', 'Low', 'Okay', 'Good', 'Great'];
const MOOD_COLORS = ['#b3412f', '#d9822b', '#c9a227', '#5aa47f', '#2e6b5e'];
const SLEEP = ['Poorly', 'Fair', 'Well'];
const OVERTIME = ['Not at all', '1–2 days', '3–4 days', 'Every day'];
const STRESSORS = ['Workload', 'Deadlines', 'Team conflict', 'Manager pressure', 'Personal life', 'Commute'];
const ENERGY = ['', 'Exhausted', 'Very drained', 'Drained', 'Low', 'Below average', 'Average', 'Fairly good', 'Good', 'High', 'Energised'];
const REMINDERS = { 15: '15 minutes', 30: '30 minutes', 60: '1 hour', 120: '2 hours', 1440: '1 day' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const hm = m => `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`;
// good: which direction is healthy; tol: change that still counts as "normal"
const METRICS = {
  resting_hr: { label: 'Resting HR', unit: 'bpm', fmt: v => Math.round(v), good: 'down', tol: 3,
    info: 'Your heart rate while fully at rest. A rise of 5+ bpm above your normal for several days is a common sign of stress, poor sleep or illness.' },
  hrv: { label: 'HRV', unit: 'ms', fmt: v => Math.round(v), good: 'up', tol: 4,
    info: 'Heart rate variability: the tiny changes in time between heartbeats. Higher usually means your body is recovering well; it drops under stress.' },
  sleep_min: { label: 'Sleep', unit: '', fmt: hm, good: 'up', tol: 20, info: 'Total sleep last night, measured by your band.' },
  stress: { label: 'Stress', unit: '/100', fmt: v => Math.round(v), good: 'down', tol: 8,
    info: 'Estimated by your band from heart rate and HRV during the day. 0–39 relaxed, 40–59 normal, 60+ high.' },
  steps: { label: 'Steps', unit: '', fmt: v => Math.round(v).toLocaleString('en'), good: 'up', tol: 800, info: 'Steps counted by your band today.' },
  spo2: { label: 'Blood O₂', unit: '%', fmt: v => Math.round(v), good: 'up', tol: 1, info: 'Blood oxygen saturation during sleep. 95–100% is normal.' },
};

// ---------------- state ----------------
const S = {
  dash: null, user: null, settings: null, bookings: [], checkins: [],
  checkin: { mood: null, sleep: null, energy: 5, overtime: null, stressors: [], notes: '' },
  result: null,        // last submitted check-in (with ranked psychologists)
  doctors: [], doctorId: null,
  avail: [], date: null, slot: null, format: 'video',
  opts: { add_calendar: true, share_summary: true, remind: true },
  rescheduling: null,  // booking being moved
  lastBooking: null,
  range: 7, metric: 'resting_hr', sessionTab: 'upcoming',
};

// ---------------- helpers ----------------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateObj = iso => new Date(iso + 'T00:00');
const fmtDate = (iso, o = { weekday: 'short', day: 'numeric', month: 'short' }) => dateObj(iso).toLocaleDateString('en-GB', o);
const longDate = iso => fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthShort = iso => fmtDate(iso, { month: 'short' }).slice(0, 3).toUpperCase();
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
function ago(isoTs) {
  const m = Math.round((Date.now() - new Date(isoTs)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
}
const avg = a => a.reduce((s, x) => s + x, 0) / (a.length || 1);

function toast(msg, isError) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isError);
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), isError ? 3800 : 2300);
}
function openSheet(html, onClose) {
  $('sheet').innerHTML = '<div class="grab"></div>' + html;
  $('modal').classList.add('show');
  $('modal')._onClose = onClose;
}
function closeSheet() {
  $('modal').classList.remove('show');
  if ($('modal')._onClose) $('modal')._onClose();
  $('modal')._onClose = null;
}
async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>${label}`;
  try { return await fn(); }
  catch (e) { toast(e.message, true); throw e; }
  finally { btn.disabled = false; btn.innerHTML = old; }
}
function applyTheme(theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}
const sw = (on, act, arg = '') => `<button class="sw ${on ? 'on' : ''}" role="switch" aria-checked="${on}" data-act="${act}" data-arg="${arg}"></button>`;

// ---------------- navigation ----------------
const RENDER = {};
const TABS = ['home', 'insights', 'sessions', 'profile'];
async function go(id) {
  if (TABS.includes(id)) { S.rescheduling = null; S.tab = id; }
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  document.querySelector(`#${id} .scroll`)?.scrollTo(0, 0);
  renderNav();
  try { await RENDER[id]?.(); }
  catch (e) { toast(e.message, true); }
}

// Charts are drawn after the HTML is on screen, at the real width of their container,
// so they stay crisp on a phone and on a wide desktop card. They redraw on resize.
const CHARTS = new Map();
let chartSeq = 0;
function chart(draw) {
  const id = 'c' + (++chartSeq);
  CHARTS.set(id, draw);
  return `<div class="chart-wrap" data-chart="${id}"></div>`;
}
const chartH = (w, base) => Math.round(Math.max(base, Math.min(base * 1.6, w * 0.3)));
function drawCharts() {
  for (const id of CHARTS.keys()) if (!document.querySelector(`[data-chart="${id}"]`)) CHARTS.delete(id);
  document.querySelectorAll('.screen.active [data-chart]').forEach(el => {
    const w = Math.max(220, Math.floor(el.clientWidth));
    el.innerHTML = CHARTS.get(el.dataset.chart)?.(w) || '';
  });
}
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCharts, 120); });

const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  insights: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  sessions: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
};
function renderNav() {
  const upcoming = S.dash?.upcoming ? 1 : 0;
  const label = id => id[0].toUpperCase() + id.slice(1);
  const u = S.user;
  $('sidebar').innerHTML = `
    <div class="brand"><span class="logo">${icon('heart')}</span>OpusVita</div>
    <nav class="side-nav">${Object.entries(ICONS).map(([id, path]) => `
      <button class="${S.tab === id ? 'on' : ''}" data-go="${id}"><svg viewBox="0 0 24 24">${path}</svg>${label(id)}
      ${id === 'sessions' && upcoming ? '<span class="side-badge">1</span>' : ''}</button>`).join('')}</nav>
    <button class="btn" data-act="startCheckin">Start check-in</button>
    ${u ? `<button class="side-user" data-go="profile"><span class="avatar">${esc(initials(u.name))}</span>
      <span><b>${esc(u.name)}</b><small>${esc(u.email)}</small></span></button>` : ''}`;
  document.querySelectorAll('.nav').forEach(nav => {
    nav.innerHTML = Object.entries(ICONS).map(([id, path]) => `
      <button class="${nav.dataset.tab === id ? 'on' : ''}" data-go="${id}" aria-label="${id}">
        <span class="ic"><svg viewBox="0 0 24 24">${path}</svg></span>${id[0].toUpperCase() + id.slice(1)}
        ${id === 'sessions' && upcoming ? '<span class="badge">1</span>' : ''}
      </button>`).join('');
  });
}

// ---------------- HOME ----------------
function delta(key, today, base) {
  const m = METRICS[key], d = today - base;
  if (Math.abs(d) <= m.tol) return '<span class="delta flat">Normal</span>';
  const better = (d > 0) === (m.good === 'up');
  const txt = key === 'sleep_min' ? `${d > 0 ? '+' : '−'}${hm(Math.abs(d))}` : key === 'steps' ? `${Math.round((d / base) * 100)}%` : `${d > 0 ? '+' : ''}${Math.round(d)}`;
  return `<span class="delta ${better ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${txt}</span>`;
}

// psychologist list with a quick "Book" button (home + sessions)
function teamGrid(team) {
  return `<div class="team-grid">${team.map(d => `
        <div class="team-item">
          <div class="avatar dark-text" style="background:${d.color}">${d.initials}</div>
          <div style="min-width:0;flex:1"><h3 style="font-size:15px">${esc(d.name)}</h3>
            <p class="muted small">${esc(d.focus)} · ${icon('star', 'inline star')} ${d.rating}</p>
            <p class="small" style="color:var(--green-ink);font-weight:600;margin-top:2px">${d.next_free ? `Next: ${fmtDate(d.next_free.date)}, ${d.next_free.time}` : 'Fully booked'}</p></div>
          <button class="btn sm secondary" data-act="bookAgain" data-arg="${d.id}">Book</button>
        </div>`).join('')}</div>`;
}

RENDER.home = async () => {
  const [dash, team] = await Promise.all([api.dashboard(), api.psychologists()]);
  S.dash = dash; S.team = team;
  const { user, today, baseline: b, last7, wellbeing: w, alert, upcoming, intraday } = dash;
  S.user = user; S.settings = dash.settings; applyTheme(S.settings.theme);
  const h = new Date().getHours();
  const greet = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const cls = w.score >= 75 ? 'ok' : w.score >= 55 ? 'warn' : 'bad';
  const partNames = { sleep: 'Sleep', recovery: 'Recovery', heart: 'Heart', calm: 'Calm' };
  const days = last7.map(r => fmtDate(r.date, { weekday: 'narrow' }));
  const hrMax = Math.max(...intraday.map(p => p.bpm)), hrMin = Math.min(...intraday.map(p => p.bpm));
  const todayLong = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // last night's sleep: band reports wake-up at 07:05, bedtime is worked back from total time in bed
  const inBed = today.sleep_min + today.awake_min;
  const bedMin = (7 * 60 + 5 - inBed + 1440) % 1440;
  const clock = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const stages = [['deep', 'Deep'], ['rem', 'REM'], ['light', 'Light'], ['awake', 'Awake']];

  // this week's daily averages (today's partial steps left out)
  const wk = {
    sleep: avg(last7.map(r => r.sleep_min)), rhr: avg(last7.map(r => r.resting_hr)),
    steps: avg(last7.slice(0, -1).map(r => r.steps)), active: avg(last7.slice(0, -1).map(r => r.active_min)),
  };

  $('homeBody').innerHTML = `
    <div class="hello">
      <div><p class="eyebrow">${todayLong}</p><h1>${greet}, ${esc(user.name.split(' ')[0])}</h1>
        <div class="sync">${user.band_connected
          ? `<span class="dot"></span>Band 8 synced · ${ago(user.band_last_sync)} · <button data-act="sync">${icon('arrow-path', 'inline')} Sync now</button>`
          : `<span class="dot off"></span>Band disconnected · <button data-go="profile">Reconnect</button>`}</div></div>
      <button class="avatar" data-go="profile" aria-label="Profile">${esc(initials(user.name))}</button>
    </div>

    <div class="home-grid">
    ${alert ? `<div class="alert a-alert">
      <span class="pill">WELLBEING CHECK</span>
      <h2>Your stress signals have been higher than usual</h2>
      <p class="muted">Your resting heart rate has stayed above your normal level for ${alert.elevated_days} days, and you've averaged ${hm(alert.avg_sleep)} of sleep. A 2-minute check-in helps us find the right support.</p>
      <button class="btn" data-act="startCheckin">Start 2-min check-in</button>
      <button class="link" style="width:100%;margin-top:4px" data-act="remindTonight">Remind me tonight</button>
    </div>` : ''}

    <div class="stack a-side">
    ${upcoming ? `<div class="card" style="border:2px solid var(--green)">
      <div class="session"><div class="cal"><small>${monthShort(upcoming.date)}</small><b>${dateObj(upcoming.date).getDate()}</b></div>
      <div style="flex:1"><span class="status">UPCOMING SESSION</span>
        <h3 style="margin-top:6px">${fmtDate(upcoming.date)} · ${upcoming.slot}</h3>
        <p class="muted">${esc(upcoming.psychologist.name)} · ${upcoming.format === 'video' ? 'Video call' : 'In person'}</p>
        <button class="link" style="padding:6px 0 0" data-go="sessions">Manage session ${icon('arrow-right', 'inline')}</button></div></div></div>` : ''}

    <div class="card tip-card">
      <div class="ico">${icon('sparkles')}</div>
      <div style="flex:1"><h3>1-minute breathing reset</h3><p class="muted">Slow breathing lowers heart rate within minutes.</p></div>
      <button class="btn sm secondary" data-act="breathe">Start</button>
    </div>

    <div class="card reminders">
      <div class="row" style="margin-bottom:6px"><h3>Reminders</h3><button class="link" style="padding:0" data-go="profile">Edit</button></div>
      <div class="rem-row">${icon('calendar-days')}<span>Weekly check-in<small>${S.settings.notifications ? `Every ${S.settings.checkin_day} at ${S.settings.checkin_time}` : 'Notifications are off'}</small></span></div>
      <div class="rem-row">${icon('heart')}<span>Session reminder<small>${REMINDERS[S.settings.reminder_minutes]} before each session</small></span></div>
      <div class="rem-row">${icon('battery-50')}<span>Band battery<small>${user.band_battery}% · ${user.band_battery < 20 ? 'charge soon' : 'about ' + Math.round(user.band_battery / 9) + ' days left'}</small></span></div>
    </div>
    </div>

    <div class="card score-wrap a-score">
      <div class="score-card">
        <div>${Charts.ring(w.score)}</div>
        <div style="flex:1">
          <span class="score-label ${cls}">${w.label}</span>
          <h3 style="margin-bottom:10px">Wellbeing score <button class="tip" data-act="info" data-arg="score">?</button></h3>
          <div class="parts">${Object.entries(w.parts).map(([k, v]) => `
            <div class="part">${partNames[k]}<span class="track"><i class="${v < 60 ? 'low' : ''}" style="width:${v}%"></i></span><b>${v}</b></div>`).join('')}</div>
        </div>
      </div>
    </div>

    <div class="a-metrics">
    <div class="row metrics-head"><h3>Today</h3><span class="muted small">vs. your normal</span></div>
    <div class="metrics">${Object.entries(METRICS).map(([k, m]) => `
      <button class="metric" data-act="openMetric" data-arg="${k}">
        <div class="k">${m.label}${k === 'steps' ? ' so far' : ''}</div>
        <div class="v">${m.fmt(today[k])}<small> ${m.unit}</small></div>
        ${k === 'steps' ? '<span class="delta flat">Goal 8,000</span>' : delta(k, today[k], b[k])}
      </button>`).join('')}</div>
    </div>

    <div class="card a-rhr">
      <div class="row"><h3>Resting heart rate</h3><b style="color:var(--amber-ink);font-size:22px">${today.resting_hr} bpm</b></div>
      <p class="muted">Last 7 days vs. your normal</p>
      ${chart(w => Charts.bars(last7.map(r => r.resting_hr), { width: w, height: chartH(w, 120), labels: days, baseline: b.resting_hr, fmt: v => v + ' bpm' }))}
      <div class="legend"><span><span class="dash"></span>Your normal: ${b.resting_hr} bpm <button class="tip" data-act="info" data-arg="baseline">?</button></span>
        <span><span class="sw-dot" style="background:var(--amber)"></span>Above normal</span></div>
    </div>

    <div class="card a-hr">
      <div class="row"><h3>Heart rate today</h3><span class="muted small">${hrMin}–${hrMax} bpm</span></div>
      ${chart(w => Charts.line(intraday.map(p => p.bpm), { width: w - 8, height: chartH(w, 110), labels: intraday.map(p => p.t), labelEvery: Math.ceil(intraday.length / (w > 500 ? 8 : 5)), dots: false, fmt: v => v + ' bpm' }))}
      <p class="muted small">Peaks during 13:00–19:00 match your meeting-heavy afternoons.</p>
    </div>

    <div class="card a-sleep">
      <div class="row"><h3>Last night</h3><button class="link" style="padding:0" data-act="openMetric" data-arg="sleep_min">Details ${icon('arrow-right', 'inline')}</button></div>
      <div class="sleep-big">${hm(today.sleep_min)}<span class="muted small"> asleep · ${clock(bedMin)} – 07:05</span></div>
      <div class="stage-bar">${stages.map(([k]) => `<i style="flex:${today[k + '_min']};background:var(--${k})"></i>`).join('')}</div>
      <div class="stage-list">${stages.map(([k, l]) => `<div><span class="sw-dot" style="background:var(--${k})"></span>${l}<b>${hm(today[k + '_min'])}</b></div>`).join('')}</div>
    </div>

    <div class="card a-week">
      <div class="row"><h3>This week</h3><span class="muted small">daily average</span></div>
      <div class="week-grid">
        <div><span>${icon('moon', 'inline')} Sleep</span><b>${hm(wk.sleep)}</b><small class="${wk.sleep < b.sleep_min - 20 ? 'bad' : 'good'}">normal ${hm(b.sleep_min)}</small></div>
        <div><span>${icon('heart', 'inline')} Resting HR</span><b>${Math.round(wk.rhr)} bpm</b><small class="${wk.rhr > b.resting_hr + 3 ? 'bad' : 'good'}">normal ${b.resting_hr} bpm</small></div>
        <div><span>${icon('bolt', 'inline')} Steps</span><b>${Math.round(wk.steps).toLocaleString('en')}</b><small class="${wk.steps < b.steps * 0.8 ? 'bad' : 'good'}">normal ${b.steps.toLocaleString('en')}</small></div>
        <div><span>${icon('sparkles', 'inline')} Active</span><b>${Math.round(wk.active)} min</b><small class="${wk.active < 30 ? 'bad' : 'good'}">goal 30 min</small></div>
      </div>
    </div>

    <div class="card a-team">
      <div class="row" style="margin-bottom:12px"><h3>Your care team</h3><span class="muted small">Free for employees · confidential</span></div>
      ${teamGrid(team)}
    </div>
    </div>

    <div class="privacy">${icon('lock-closed', 'lead')}Your manager never sees your health data or answers.</div>`;
  renderNav();
  drawCharts();
};

// ---------------- INSIGHTS ----------------
function observations(days, b) {
  const out = [];
  const recent = days.slice(-5);
  const rhr = avg(recent.map(d => d.resting_hr));
  if (rhr - b.resting_hr >= 5) out.push(['heart', `Your resting heart rate averaged <b>${Math.round(rhr)} bpm</b> over the last 5 days — <b>${Math.round(rhr - b.resting_hr)} bpm above</b> your normal. This often happens with stress, poor sleep or getting ill.`]);
  const sl = avg(days.slice(-7).map(d => d.sleep_min));
  if (b.sleep_min - sl > 30) out.push(['moon', `You've slept <b>${hm(sl)}</b> a night this week, about <b>${Math.round(b.sleep_min - sl)} min less</b> than usual. Adults need 7–9 hours.`]);
  const deep = avg(recent.map(d => d.deep_min / d.sleep_min));
  if (deep < 0.14) out.push(['battery-50', `Deep sleep is only <b>${Math.round(deep * 100)}%</b> of your night (normally ~18%). Deep sleep is when your body recovers from stress.`]);
  const hrv = avg(recent.map(d => d.hrv));
  if (b.hrv - hrv > 6) out.push(['arrow-trending-down', `Your HRV dropped from <b>${b.hrv} ms</b> to <b>${Math.round(hrv)} ms</b>, which suggests your body is not fully recovering.`]);
  const st = avg(recent.slice(0, -1).map(d => d.steps));
  if (st < b.steps * 0.7) out.push(['bolt', `You're moving less: <b>${Math.round(st).toLocaleString('en')}</b> steps a day vs. ${b.steps.toLocaleString('en')} normally. A 10-minute walk at lunch can help.`]);
  if (!out.length) out.push(['check-circle', 'Everything looks close to your normal. Keep it up!']);
  return out;
}

RENDER.insights = async () => {
  $('rangeSeg').innerHTML = [7, 30, 60].map(r => `<button class="${S.range === r ? 'sel' : ''}" data-act="range" data-arg="${r}">${r} days</button>`).join('');
  const [{ days, baseline: b }, checkins] = await Promise.all([api.health(S.range), api.checkins()]);
  S.checkins = checkins;
  const m = METRICS[S.metric];
  const vals = days.map(d => d[S.metric]);
  const labels = days.map(d => S.range === 7 ? fmtDate(d.date, { weekday: 'short' }) : fmtDate(d.date, { day: 'numeric', month: 'short' }));
  const every = S.range === 7 ? 1 : S.range === 30 ? 7 : 14;
  const mainChart = w => S.range === 7
    ? Charts.bars(vals, { width: w, height: chartH(w, 130), labels, baseline: b[S.metric], fmt: v => m.fmt(v) + ' ' + m.unit, zero: S.metric === 'steps' })
    : Charts.line(vals, { width: w - 8, height: chartH(w, 130), labels, baseline: b[S.metric], labelEvery: w > 600 ? Math.ceil(every / 2) : every, fmt: v => m.fmt(v) + ' ' + m.unit });
  const sleepDays = days.slice(-Math.min(days.length, 30));
  const moods = [...checkins].reverse();

  $('insightsBody').innerHTML = `
    <div class="chips scroll-x" style="margin:16px 0 12px">${Object.entries(METRICS).map(([k, x]) =>
      `<button class="chip ${S.metric === k ? 'sel' : ''}" data-act="metric" data-arg="${k}">${x.label}</button>`).join('')}</div>
    <div class="grid2">
    <div class="card span-2">
      <div class="row"><h3>${m.label}</h3><button class="tip" data-act="info" data-arg="${S.metric}">?</button></div>
      ${chart(mainChart)}
      <div class="legend"><span><span class="dash"></span>Your normal</span>${S.range === 7 ? '<span><span class="sw-dot" style="background:var(--amber)"></span>Above normal</span>' : ''}</div>
      <div class="stat-row">
        <div><div class="k">Average</div><div class="v">${m.fmt(avg(vals))} ${m.unit}</div></div>
        <div><div class="k">Your normal</div><div class="v">${m.fmt(b[S.metric])} ${m.unit}</div></div>
        <div><div class="k">Latest</div><div class="v">${m.fmt(vals[vals.length - 1])} ${m.unit}</div></div>
      </div>
    </div>

    <div><div class="section-title">What we noticed</div>
    <div class="card">${observations(days, b).map(([i, t]) => `<div class="insight"><span class="ico">${icon(i)}</span><span>${t}</span></div>`).join('')}</div></div>

    <div><div class="section-title">Sleep stages</div>
    <div class="card">
      ${chart(w => Charts.stacked(sleepDays.map(d => ({ deep: d.deep_min, rem: d.rem_min, light: d.light_min, awake: d.awake_min })),
        { width: w, height: chartH(w, 140), labels: sleepDays.map(d => S.range === 7 ? fmtDate(d.date, { weekday: 'narrow' }) : String(dateObj(d.date).getDate())) }))}
      <div class="legend">${['deep', 'rem', 'light', 'awake'].map(k => `<span><span class="sw-dot" style="background:var(--${k})"></span>${k === 'rem' ? 'REM' : k[0].toUpperCase() + k.slice(1)}</span>`).join('')}</div>
    </div></div>

    <div class="span-2"><div class="section-title">Mood from check-ins</div>
    <div class="card mood-card">
      ${moods.length >= 2 ? chart(w => Charts.line(moods.map(c => c.mood + 1), { width: w - 8, height: 110, labels: moods.map(c => new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })), fmt: v => MOODS[v - 1] })) : ''}
      <div class="history-list">
      ${checkins.length ? checkins.slice(0, 6).map(c => `
        <div class="history"><div class="mood-dot" style="background:${MOOD_COLORS[c.mood]}">${c.mood + 1}</div>
          <div style="flex:1"><h3 style="font-size:15px">${MOODS[c.mood]} · energy ${c.energy}/10</h3>
          <p class="muted small">${new Date(c.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}${c.stressors.length ? ' · ' + esc(c.stressors.join(', ')) : ''}</p></div></div>`).join('')
      : `<div class="empty"><p class="muted" style="margin-bottom:14px">No check-ins yet.</p><button class="btn sm" data-act="startCheckin">Do a check-in</button></div>`}
      </div>
    </div></div>
    </div>`;
  renderNav();
  drawCharts();
};

// ---------------- SESSIONS ----------------
function sessionCard(b) {
  const past = b.status !== 'booked';
  return `<div class="card" style="${b.status === 'cancelled' ? 'opacity:.65' : ''}">
    <div class="session"><div class="cal"><small>${monthShort(b.date)}</small><b>${dateObj(b.date).getDate()}</b></div>
    <div style="flex:1;min-width:0">
      <span class="status ${b.status}">${b.status === 'booked' ? 'UPCOMING' : b.status.toUpperCase()}</span>
      <h3 style="margin-top:6px">${fmtDate(b.date)} · ${b.slot}–${b.end}</h3>
      <p class="muted">${esc(b.psychologist.name)}</p>
      <p class="muted small">${b.format === 'video' ? icon('video-camera', 'inline') + ' Video call · Google Meet' : icon('map-pin', 'inline') + ' ' + esc(b.psychologist.room)}</p>
      ${b.cancel_reason ? `<p class="muted small">Reason: ${esc(b.cancel_reason)}</p>` : ''}
    </div></div>
    ${past ? (b.status === 'completed' ? `<div class="actions"><button data-act="bookAgain" data-arg="${b.psychologist.id}">Book again</button></div>` : '') : `
      <div class="actions"><button data-act="reschedule" data-arg="${b.id}" ${b.can_change ? '' : 'disabled'}>Reschedule</button>
      <button class="danger" data-act="askCancel" data-arg="${b.id}" ${b.can_change ? '' : 'disabled'}>Cancel</button></div>
      ${b.can_change ? '' : `<p class="lock-note">Starts in ${b.hours_left} h — changes are locked 12 h before. Contact your psychologist.</p>`}`}
  </div>`;
}
RENDER.sessions = async () => {
  S.bookings = await api.bookings();
  const up = S.bookings.filter(b => b.status === 'booked');
  const past = S.bookings.filter(b => b.status !== 'booked').reverse();
  $('sessionSeg').innerHTML = `<button class="${S.sessionTab === 'upcoming' ? 'sel' : ''}" data-act="sessionTab" data-arg="upcoming">Upcoming (${up.length})</button>
    <button class="${S.sessionTab === 'past' ? 'sel' : ''}" data-act="sessionTab" data-arg="past">Past (${past.length})</button>`;
  const list = S.sessionTab === 'upcoming' ? up : past;
  $('sessionList').innerHTML = list.length ? list.map(sessionCard).join('') : `
    <div class="empty"><p class="big">${icon('calendar-days')}</p><h3 style="margin:10px 0 6px">${S.sessionTab === 'upcoming' ? 'No upcoming sessions' : 'No past sessions'}</h3>
    <p class="muted" style="margin-bottom:18px">Take a 2-minute check-in and we'll suggest the right support.</p>
    <button class="btn" data-act="startCheckin">Start check-in</button></div>`;
  if (!S.team) S.team = await api.psychologists();
  $('sessionTeam').innerHTML = `<div class="section-title">Book directly</div>
    <div class="card"><p class="muted" style="margin-bottom:12px">Already know who you'd like to talk to? Sessions are free and confidential.</p>${teamGrid(S.team)}</div>`;
  if (!S.dash) S.dash = await api.dashboard();
  S.dash.upcoming = up[0] || null;
  renderNav();
};

// ---------------- PROFILE ----------------
RENDER.profile = async () => {
  const [{ user, settings }, bookings, checkins] = await Promise.all([api.me(), api.bookings(), api.checkins()]);
  S.user = user; S.settings = settings; S.bookings = bookings; S.checkins = checkins;
  const s = settings;
  const done = bookings.filter(b => b.status === 'completed').length;
  const opt = (val, cur, label = val) => `<option value="${val}" ${String(val) === String(cur) ? 'selected' : ''}>${label}</option>`;
  const row = (title, sub, ctrl) => `<div class="toggle-row"><div><h3>${title}</h3>${sub ? `<p class="muted">${sub}</p>` : ''}</div>${ctrl}</div>`;

  $('profileBody').innerHTML = `
    <h1 style="margin-bottom:16px">Profile</h1>
    <div class="profile-cols"><div>
    <div class="card">
      <div class="profile-head">
        <div class="avatar lg">${esc(initials(user.name))}</div>
        <div style="flex:1;min-width:0"><h2 style="margin:0">${esc(user.name)}</h2>
          <p class="muted">${esc([user.job_title, user.department].filter(Boolean).join(' · '))}</p>
          <p class="muted small">${esc(user.email)}</p></div>
      </div>
      <button class="btn secondary" style="margin-top:14px" data-act="editProfile">Edit profile</button>
      <div class="stats3"><div><b>${checkins.length}</b><span>Check-ins</span></div><div><b>${done}</b><span>Sessions done</span></div>
        <div><b>${bookings.filter(b => b.status === 'booked').length}</b><span>Upcoming</span></div></div>
    </div>

    <div class="section-title">Wearable</div>
    <div class="card">
      <div class="row"><div><h3>${esc(user.band_model)}</h3>
        <p class="muted small"><span class="dot ${user.band_connected ? '' : 'off'}" style="display:inline-block"></span>
        ${user.band_connected ? `Connected via Bluetooth · synced ${ago(user.band_last_sync)}` : 'Disconnected'}</p></div>
        <div class="row" style="gap:6px"><span class="small muted">${user.band_battery}%</span><span class="battery"><i style="width:${user.band_battery}%"></i></span></div></div>
      <div class="actions">${user.band_connected ? `<button data-act="sync">${icon('arrow-path', 'inline')} Sync now</button>` : ''}
        <button class="${user.band_connected ? 'danger' : ''}" data-act="toggleDevice">${user.band_connected ? 'Disconnect' : 'Connect band'}</button></div>
    </div>

    <div class="section-title">Appearance</div>
    <div class="seg">${['system', 'light', 'dark'].map(t => `<button class="${s.theme === t ? 'sel' : ''}" data-act="theme" data-arg="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>

    <div class="section-title">Demo</div>
    <div class="settings-group">
      <button class="menu-row" data-act="askReset">Reset demo data <span class="chev">${icon('arrow-uturn-left')}</span></button>
      <button class="menu-row" data-act="signOut">Sign out <span class="chev">${icon('chevron-right')}</span></button>
    </div>
    </div><div>

    <div class="section-title first">Notifications</div>
    <div class="settings-group">
      ${row('Push notifications', 'Session reminders and check-in prompts', sw(s.notifications, 'setting', 'notifications'))}
      ${row('Remind me before a session', '', `<select class="compact" data-setting="reminder_minutes" ${s.notifications ? '' : 'disabled'}>${Object.entries(REMINDERS).map(([v, l]) => opt(v, s.reminder_minutes, l)).join('')}</select>`)}
      ${row('Weekly check-in reminder', '', `<div class="row" style="gap:6px"><select class="compact" data-setting="checkin_day" ${s.notifications ? '' : 'disabled'}>${WEEKDAYS.map(d => opt(d, s.checkin_day)).join('')}</select>
        <input type="time" class="compact" data-setting="checkin_time" value="${s.checkin_time}" ${s.notifications ? '' : 'disabled'}></div>`)}
      ${row('Weekly wellbeing email', 'A private summary every Monday', sw(s.weekly_report, 'setting', 'weekly_report'))}
    </div>

    <div class="section-title">Booking defaults</div>
    <div class="settings-group">
      ${row('Preferred format', '', `<select class="compact" data-setting="default_format">${opt('video', s.default_format, 'Video call')}${opt('person', s.default_format, 'In person')}</select>`)}
      ${row('Share check-in summary', 'With your psychologist only', sw(s.default_share, 'setting', 'default_share'))}
      ${row('Add sessions to calendar', 'Shows as "Personal appointment"', sw(s.default_calendar, 'setting', 'default_calendar'))}
    </div>

    <div class="section-title">Privacy &amp; data</div>
    <div class="settings-group">
      ${row('Anonymous team statistics', 'HR sees only totals for groups of 10+', sw(s.anonymous_stats, 'setting', 'anonymous_stats'))}
      <button class="menu-row" data-act="info" data-arg="hr">What can HR and my manager see? <span class="chev">${icon('chevron-right')}</span></button>
      <a class="menu-row" href="/api/export" download style="color:inherit;text-decoration:none">Download my data (JSON) <span class="chev">${icon('arrow-down-tray')}</span></a>
      <button class="menu-row" data-act="askDeleteCheckins" style="color:var(--danger)">Delete check-in history <span class="chev">${icon('chevron-right')}</span></button>
    </div>

    </div></div>
    <p class="muted small" style="text-align:center;margin-top:18px">OpusVita v1.0 · data stored in SQLite on the server</p>`;
  renderNav();
};

async function saveSettings(patch) {
  try {
    S.settings = await api.updateSettings(patch);
    applyTheme(S.settings.theme);
    toast('Saved');
  } catch (e) { toast(e.message, true); }
  if ($('profile').classList.contains('active')) RENDER.profile();
}

// ---------------- CHECK-IN ----------------
RENDER.q1 = () => {
  const c = S.checkin;
  $('mood').innerHTML = MOODS.map((m, i) => `<button class="${c.mood === i ? 'sel' : ''}" data-act="mood" data-arg="${i}" aria-pressed="${c.mood === i}"><span class="c">${i + 1}</span>${m}</button>`).join('');
  $('sleep').innerHTML = SLEEP.map((s, i) => `<button class="${c.sleep === i ? 'sel' : ''}" data-act="sleep" data-arg="${i}">${s}</button>`).join('');
  $('energy').value = c.energy;
  $('energyVal').textContent = `${c.energy}/10 · ${ENERGY[c.energy]}`;
  const ok = c.mood !== null && c.sleep !== null;
  $('q1next').disabled = !ok;
  $('q1next').textContent = ok ? 'Next' : 'Answer both questions to continue';
};
RENDER.q2 = () => {
  const c = S.checkin;
  $('overtime').innerHTML = OVERTIME.map((o, i) => `<button class="opt ${c.overtime === i ? 'sel' : ''}" data-act="overtime" data-arg="${i}">${o}<span class="radio"></span></button>`).join('');
  $('stress').innerHTML = STRESSORS.map(s => `<button class="chip check ${c.stressors.includes(s) ? 'sel' : ''}" data-act="stressor" data-arg="${s}">${s}</button>`).join('');
  $('notes').value = c.notes;
  $('q2next').disabled = c.overtime === null;
  $('q2next').textContent = c.overtime === null ? 'Choose an overtime option' : 'See support options';
};
$('energy').addEventListener('input', e => { S.checkin.energy = +e.target.value; RENDER.q1(); });
$('notes').addEventListener('input', e => { S.checkin.notes = e.target.value; });
$('q1next').addEventListener('click', () => go('q2'));
$('q2next').addEventListener('click', e => busy(e.currentTarget, 'Analysing…', async () => {
  S.result = await api.submitCheckin(S.checkin);
  S.doctors = S.result.matches;
  S.doctorId = S.doctors[0].id;
  S.date = S.slot = null;
  useDefaults();
  go('plan');
}).catch(() => {}));

function useDefaults() {
  const s = S.settings || {};
  S.format = s.default_format || 'video';
  S.opts = { add_calendar: s.default_calendar ?? true, share_summary: s.default_share ?? true, remind: s.notifications ?? true };
}

// ---------------- PLAN ----------------
RENDER.plan = () => {
  const r = S.result;
  const titles = {
    session: ['We recommend a 1:1 session with a psychologist', 'Based on your check-in and your band data.'],
    chat: ['A short chat with a psychologist could help', 'Your answers show some strain. Talking early helps stop it from building up.'],
    'self-care': ["You seem to be coping well", 'Here are some ideas to keep it that way. You can still talk to someone any time.'],
  };
  const [t, sub] = titles[r.level];
  const today = S.dash?.today;
  $('planBody').innerHTML = `
    <h2>${t}</h2><p class="muted">${sub}</p>
    <div class="summary">
      <div class="row" style="margin-bottom:8px"><b style="font-size:14px">Summary for your psychologist</b><span class="ai">AI</span></div>
      <p>${esc(r.summary)}</p>
      ${r.notes ? `<p class="muted small" style="margin-top:6px">Your note: “${esc(r.notes)}”</p>` : ''}
      ${today ? `<div class="signals"><span>${icon('heart', 'inline')} ${today.resting_hr} bpm resting</span><span>${icon('moon', 'inline')} ${hm(today.sleep_min)} last night</span><span>${icon('arrow-trending-up', 'inline')} Stress ${today.stress}/100</span></div>` : ''}
      <button class="link" style="padding:10px 0 0" data-go="q1">Edit answers</button>
    </div>
    ${r.level === 'self-care' ? `<div class="card"><h3 style="margin-bottom:4px">Try this week</h3><ul class="selfcare">
      <li>${icon('bolt')}<span>A 10-minute walk after lunch</span></li><li>${icon('bell-slash')}<span>No work messages after 20:00</span></li><li>${icon('sparkles')}<span>1-minute breathing reset when stress spikes</span></li></ul></div>` : ''}
    <h3 style="margin-bottom:12px">Choose a psychologist</h3>
    ${S.doctors.map((d, i) => `<div class="doc ${S.doctorId === d.id ? 'sel' : ''}" role="button" tabindex="0" data-act="pickDoctor" data-arg="${d.id}">
      <div class="avatar dark-text" style="background:${d.color}">${d.initials}</div>
      <div class="info">${i === 0 && d.match > 0 ? '<span class="best">BEST MATCH</span><br>' : ''}
        <h3>${esc(d.name)}</h3><p class="muted">${esc(d.role)} · ${esc(d.focus)}</p>
        <div class="next">${d.next_free ? `Next free: ${fmtDate(d.next_free.date)}, ${d.next_free.time}` : 'Fully booked'}</div>
        <span class="more" data-act="doctorInfo" data-arg="${d.id}">${icon('star', 'inline star')} ${d.rating} · View profile</span></div>
      <span class="radio"></span></div>`).join('')}`;
};
$('planNext').addEventListener('click', () => go('time'));

// ---------------- TIME ----------------
RENDER.time = async () => {
  const d = S.doctors.find(x => x.id === S.doctorId);
  $('timeTitle').textContent = S.rescheduling ? 'Reschedule session' : 'Pick a time';
  $('timeDoc').textContent = d.name;
  $('timeBody').innerHTML = '<div class="loading" style="padding:60px"><span class="spinner"></span></div>';
  S.avail = await api.availability(d.id, S.rescheduling?.id);
  if (!S.avail.some(x => x.date === S.date && x.free)) S.date = (S.avail.find(x => x.free) || {}).date || null;
  renderTimeBody();
};
function renderTimeBody() {
  const day = S.avail.find(x => x.date === S.date);
  const month = S.date ? dateObj(S.date).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '';
  $('timeBody').innerHTML = `
    <h3 style="margin-bottom:12px">${month}</h3>
    <div class="dates">${S.avail.map(x => `<button class="date ${S.date === x.date ? 'sel' : ''}" ${x.free ? '' : 'disabled'} data-act="pickDate" data-arg="${x.date}">
      ${fmtDate(x.date, { weekday: 'short' })}<b>${dateObj(x.date).getDate()}</b><span class="free">${x.free ? x.free + ' free' : 'Full'}</span></button>`).join('')}</div>
    ${day ? `<div class="q">Available on <span style="color:var(--green-ink)">${fmtDate(day.date)}</span></div>
    <div class="slots">${day.slots.map(s => `<button class="slot ${S.slot === s.time ? 'sel' : ''}" ${s.available ? '' : 'disabled aria-label="' + s.time + ' taken"'} data-act="pickSlot" data-arg="${s.time}">${s.time}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:8px">Sessions last 50 minutes. Crossed-out times are taken.</p>` : '<p class="muted" style="margin-top:20px">No free times in the next weeks.</p>'}
    <div class="q">Session format</div>
    ${[['video', 'video-camera', 'Video call', 'Private Google Meet link'], ['person', 'map-pin', 'In person', S.doctors.find(x => x.id === S.doctorId).room]]
      .map(([k, ic, t, s]) => `<button class="opt ${S.format === k ? 'sel' : ''}" data-act="pickFormat" data-arg="${k}"><span class="fmt"><span class="sq">${icon(ic)}</span><span><b style="font-weight:600">${t}</b><div class="sub">${esc(s)}</div></span></span><span class="radio"></span></button>`).join('')}`;
  $('timeNext').disabled = !S.slot;
  $('timeNext').textContent = S.slot ? 'Review booking' : 'Pick a time slot';
}
$('timeNext').addEventListener('click', () => go('review'));
$('timeBack').addEventListener('click', () => go(S.rescheduling ? 'sessions' : 'plan'));

// ---------------- REVIEW + CONFIRM ----------------
RENDER.review = () => {
  const d = S.doctors.find(x => x.id === S.doctorId);
  const end = (() => { const [h, m] = S.slot.split(':').map(Number); const t = h * 60 + m + 50; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; })();
  const remindLabel = REMINDERS[S.settings?.reminder_minutes || 60];
  const notifOff = S.settings && !S.settings.notifications;
  $('reviewBody').innerHTML = `
    <div class="card">
      <div class="session" style="align-items:center;padding-bottom:14px;margin-bottom:6px;border-bottom:1px solid var(--line)">
        <div class="avatar dark-text" style="background:${d.color}">${d.initials}</div><div><h3>${esc(d.name)}</h3><p class="muted">${esc(d.role)}</p></div></div>
      ${S.rescheduling ? `<div class="kv"><span>Was</span><b style="text-decoration:line-through;color:var(--muted)">${fmtDate(S.rescheduling.date)} · ${S.rescheduling.slot}</b></div>` : ''}
      <div class="kv"><span>Date</span><b>${longDate(S.date)}</b></div>
      <div class="kv"><span>Time</span><b>${S.slot} – ${end}</b></div>
      <div class="kv"><span>Format</span><b>${S.format === 'video' ? 'Video call · Google Meet' : esc(d.room)}</b></div>
      <div class="kv"><span>Cost</span><b>Covered by employer</b></div>
    </div>
    <div class="card" style="padding:4px 18px">
      <div class="toggle-row"><div><h3>Add to Google Calendar</h3><p class="muted">Shows as "Personal appointment"</p></div>${sw(S.opts.add_calendar, 'opt', 'add_calendar')}</div>
      ${S.result ? `<div class="toggle-row"><div><h3>Share check-in summary</h3><p class="muted">Only your psychologist can read it</p></div>${sw(S.opts.share_summary, 'opt', 'share_summary')}</div>` : ''}
      <div class="toggle-row"><div><h3>Remind me ${remindLabel} before</h3><p class="muted">${notifOff ? 'Notifications are off in Profile' : 'Push notification'}</p></div>${sw(S.opts.remind && !notifOff, 'opt', 'remind')}</div>
    </div>
    <div class="note">${icon('lock-closed', 'lead')}<span>HR is only told that support was arranged — never your answers, health data, or what you discuss.</span></div>`;
  $('confirmBtn').textContent = S.rescheduling ? 'Confirm new time' : 'Confirm booking';
};
$('confirmBtn').addEventListener('click', e => busy(e.currentTarget, 'Booking…', async () => {
  const payload = { date: S.date, slot: S.slot, format: S.format, ...S.opts, remind: S.opts.remind && !!S.settings?.notifications };
  try {
    S.lastBooking = S.rescheduling
      ? await api.updateBooking(S.rescheduling.id, payload)
      : await api.book({ ...payload, psychologist_id: S.doctorId, checkin_id: S.result?.id });
  } catch (err) {
    if (err.status === 409) { S.slot = null; setTimeout(() => go('time'), 400); }
    throw err;
  }
  const wasReschedule = !!S.rescheduling;
  S.rescheduling = null;
  S.checkin = { mood: null, sleep: null, energy: 5, overtime: null, stressors: [], notes: '' };
  renderSuccess(S.lastBooking, wasReschedule);
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'success'));
}).catch(() => {}));

function renderSuccess(b, wasReschedule) {
  const remind = REMINDERS[S.settings?.reminder_minutes || 60];
  $('successBody').innerHTML = `
    <div class="done-check"><div>${icon('check')}</div></div>
    <h1>${wasReschedule ? 'Session moved' : "You're booked in"}</h1>
    <p style="font-weight:600;margin-top:10px">${fmtDate(b.date)} · ${b.slot}</p>
    <p class="muted">with ${esc(b.psychologist.name)}</p>
    <div class="card" style="text-align:left;margin-top:22px">
      <div class="session"><div class="cal"><small>${monthShort(b.date)}</small><b>${dateObj(b.date).getDate()}</b></div><div>
        <h3>${b.add_calendar ? (wasReschedule ? 'Calendar invite updated' : 'Calendar invite sent') : 'Not added to calendar'}</h3>
        <p class="muted">${b.add_calendar ? esc(S.user?.email || '') + ' · Personal appointment' : 'You can turn this on in Profile'}</p></div></div>
      <p class="muted small" style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">${b.remind ? `You'll get a reminder ${remind} before your session.` : 'No reminder set.'}</p>
    </div>
    <div class="card" style="text-align:left"><h3 style="margin-bottom:8px">Before your session</h3><ul class="list">
      <li>${b.format === 'video' ? 'Find a quiet, private space' : esc(b.psychologist.room)}</li>
      <li>${b.share_summary && b.checkin_id ? 'Your check-in summary has been shared' : 'Your check-in summary was not shared'}</li>
      <li>Reschedule up to 12 hours before</li></ul></div>`;
}

// ---------------- sheets ----------------
const INFO = {
  score: ['Wellbeing score', 'A 0–100 score from last night\'s sleep (30%), recovery/HRV (25%), resting heart rate vs. your normal (20%) and daytime stress (25%). 75+ is balanced, 55–74 under strain, below 55 overloaded.'],
  baseline: ['What is "your normal"?', 'Your normal (baseline) is your own average over the 30 days before this week. We compare you to yourself, not to other people.'],
  hr: ['What can HR and my manager see?', '<b>HR sees:</b> that a session was arranged (no name of the psychologist, no date), and anonymous team totals if you allow it.<br><br><b>Your manager sees:</b> nothing.<br><br><b>Your psychologist sees:</b> your check-in summary, only if you choose to share it.<br><br>Your heart rate, sleep and answers never leave OpusVita.'],
};
function infoSheet(key) {
  const [t, body] = INFO[key] || [METRICS[key].label, METRICS[key].info];
  openSheet(`<h2>${t}</h2><p class="muted" style="font-size:15px;margin-bottom:20px">${body}</p><button class="btn" data-act="close">Got it</button>`);
}
function doctorSheet(id) {
  const d = S.doctors.find(x => x.id === id);
  openSheet(`<div class="profile-head" style="margin-bottom:14px"><div class="avatar lg dark-text" style="background:${d.color}">${d.initials}</div>
    <div><h2 style="margin:0">${esc(d.name)}</h2><p class="muted">${esc(d.role)} · ${esc(d.focus)}</p></div></div>
    <p style="line-height:1.5;margin-bottom:12px">${esc(d.bio)}</p>
    <div class="stats3" style="margin-bottom:12px"><div><b>${icon('star', 'inline star')} ${d.rating}</b><span>Rating</span></div><div><b>${d.years}</b><span>Years</span></div><div><b>${d.sessions_count}</b><span>Sessions</span></div></div>
    <div class="kv"><span>Languages</span><b>${esc(d.languages)}</b></div>
    <div class="kv"><span>Helps with</span><b>${esc(d.tags.join(', '))}</b></div>
    <div class="kv"><span>Location</span><b>${esc(d.room)}</b></div>
    <button class="btn" style="margin-top:16px" data-act="chooseDoctor" data-arg="${d.id}">Choose ${esc(d.name.split(' ').slice(-2).join(' '))}</button>`);
}
function editProfileSheet() {
  const u = S.user;
  openSheet(`<h2>Edit profile</h2>
    <form id="profileForm" novalidate>
      <label class="field" for="pf-name">Full name</label><input class="input" id="pf-name" name="name" value="${esc(u.name)}" required autocomplete="name">
      <label class="field" for="pf-email">Work email</label><input class="input" id="pf-email" name="email" type="email" value="${esc(u.email)}" required autocomplete="email">
      <label class="field" for="pf-job">Job title</label><input class="input" id="pf-job" name="job_title" value="${esc(u.job_title)}">
      <label class="field" for="pf-dept">Department</label>
      <select id="pf-dept" name="department">${['Finance', 'Marketing', 'Sales', 'IT', 'HR', 'Operations', 'Legal'].map(d => `<option ${d === u.department ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <p class="error" id="pf-error"></p>
      <button class="btn" type="submit" style="margin-top:6px">Save changes</button>
      <button class="link" type="button" style="width:100%" data-act="close">Cancel</button>
    </form>`);
  $('profileForm').addEventListener('submit', e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    busy(e.target.querySelector('[type=submit]'), 'Saving…', async () => {
      try { S.user = await api.updateMe(data); }
      catch (err) { $('pf-error').textContent = err.message; throw err; }
      closeSheet(); toast('Profile updated'); RENDER.profile();
    }).catch(() => {});
  });
}
function cancelSheet(id) {
  const b = S.bookings.find(x => x.id === id);
  const reasons = ['Schedule conflict', 'Feeling better', 'Prefer another psychologist', 'Other'];
  let picked = null;
  const draw = () => openSheet(`<h2>Cancel this session?</h2>
    <p class="muted" style="margin-bottom:14px">${fmtDate(b.date)} at ${b.slot} with ${esc(b.psychologist.name)}. Your psychologist will be notified. HR is not told.</p>
    <p style="font-weight:600;margin-bottom:10px">Why are you cancelling? <span class="muted">(optional)</span></p>
    ${reasons.map(r => `<button class="opt ${picked === r ? 'sel' : ''}" style="padding:12px 16px;font-size:15px" data-act="cancelReason" data-arg="${r}">${r}<span class="radio"></span></button>`).join('')}
    <button class="btn danger" style="margin-top:6px" data-act="confirmCancel" data-arg="${id}">Yes, cancel session</button>
    <button class="link" style="width:100%" data-act="close">Keep session</button>`);
  S._cancel = { set: r => { picked = r; draw(); }, get: () => picked };
  draw();
}
function confirmSheet(title, text, btnLabel, act) {
  openSheet(`<h2>${title}</h2><p class="muted" style="margin-bottom:20px">${text}</p>
    <button class="btn danger" data-act="${act}">${btnLabel}</button><button class="link" style="width:100%" data-act="close">Cancel</button>`);
}
function breatheSheet() {
  let i = 0, timer;
  openSheet(`<h2 style="text-align:center">Breathe with the circle</h2><p class="muted" style="text-align:center">In for 4 · hold for 4 · out for 4</p>
    <div class="breath"><i id="bc"></i><span id="bt">Ready</span></div>
    <p class="muted" style="text-align:center;margin-bottom:16px" id="bl">60 s left</p>
    <button class="btn secondary" data-act="close">Done</button>`, () => clearInterval(timer));
  const phases = [['Breathe in', 1], ['Hold', 1], ['Breathe out', 0.55]];
  const tick = () => {
    const [label, scale] = phases[i % 3];
    if (!$('bt')) return clearInterval(timer);
    $('bt').textContent = label;
    $('bc').style.transform = `scale(${scale})`;
    $('bl').textContent = `${Math.max(0, 60 - i * 4)} s left`;
    if (++i > 15) { clearInterval(timer); $('bt').textContent = 'Well done'; $('bl').textContent = 'Notice how you feel now.'; }
  };
  setTimeout(tick, 300);
  timer = setInterval(tick, 4000);
}

// ---------------- actions (event delegation) ----------------
const ACT = {
  close: closeSheet,
  info: infoSheet,
  sync: async (_, el) => {
    el.innerHTML = '<span class="spinner"></span> Syncing…';
    try { await api.sync(); await new Promise(r => setTimeout(r, 500)); toast('Band synced'); }
    catch (e) { toast(e.message, true); }
    const cur = document.querySelector('.screen.active').id;
    RENDER[cur]?.();
  },
  toggleDevice: async () => {
    if (S.user.band_connected) return toast('Did you think something would happen? No.');
    try { await api.setDevice(!S.user.band_connected); toast(S.user.band_connected ? 'Band disconnected' : 'Band connected'); RENDER.profile(); }
    catch (e) { toast(e.message, true); }
  },
  startCheckin: () => { S.checkin = { mood: null, sleep: null, energy: 5, overtime: null, stressors: [], notes: '' }; go('q1'); },
  remindTonight: () => S.settings?.notifications ? toast('We\'ll remind you tonight at 20:00') : toast('Turn on notifications in Profile first', true),
  breathe: breatheSheet,
  openMetric: k => { S.metric = k; go('insights'); },
  range: r => { S.range = +r; RENDER.insights(); },
  metric: k => { S.metric = k; RENDER.insights(); },
  mood: i => { S.checkin.mood = +i; RENDER.q1(); },
  sleep: i => { S.checkin.sleep = +i; RENDER.q1(); },
  overtime: i => { S.checkin.overtime = +i; RENDER.q2(); },
  stressor: s => { const a = S.checkin.stressors, i = a.indexOf(s); i < 0 ? a.push(s) : a.splice(i, 1); RENDER.q2(); },
  pickDoctor: id => { if (S.doctorId !== id) { S.doctorId = id; S.date = S.slot = null; } RENDER.plan(); },
  doctorInfo: (id, el, e) => { e.stopPropagation(); doctorSheet(id); },
  chooseDoctor: id => { closeSheet(); ACT.pickDoctor(id); },
  pickDate: d => { S.date = d; S.slot = null; renderTimeBody(); },
  pickSlot: t => { S.slot = t; renderTimeBody(); },
  pickFormat: f => { S.format = f; renderTimeBody(); },
  opt: k => { S.opts[k] = !S.opts[k]; RENDER.review(); },
  sessionTab: t => { S.sessionTab = t; RENDER.sessions(); },
  reschedule: async id => {
    const b = S.bookings.find(x => x.id === +id);
    if (!S.doctors.length) S.doctors = await api.psychologists();
    Object.assign(S, { rescheduling: b, doctorId: b.psychologist_id, date: b.date, slot: null, format: b.format, result: null,
      opts: { add_calendar: b.add_calendar, share_summary: b.share_summary, remind: b.remind } });
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'time'));
    RENDER.time().catch(e => toast(e.message, true));
  },
  bookAgain: async id => {
    S.doctors = await api.psychologists();
    Object.assign(S, { doctorId: id, date: null, slot: null, result: null, rescheduling: null });
    useDefaults();
    go('time');
  },
  askCancel: id => cancelSheet(+id),
  cancelReason: r => S._cancel.set(r),
  confirmCancel: (id, el) => busy(el, 'Cancelling…', async () => {
    await api.updateBooking(+id, { status: 'cancelled', reason: S._cancel.get() });
    closeSheet(); toast('Session cancelled'); RENDER.sessions();
  }).catch(() => {}),
  editProfile: editProfileSheet,
  setting: k => saveSettings({ [k]: !S.settings[k] }),
  theme: t => saveSettings({ theme: t }),
  askDeleteCheckins: () => confirmSheet('Delete check-in history?', 'All your check-in answers will be permanently deleted. Booked sessions stay, but psychologists will no longer see the summaries.', 'Delete history', 'deleteCheckins'),
  deleteCheckins: (_, el) => busy(el, 'Deleting…', async () => { await api.deleteCheckins(); closeSheet(); toast('Check-in history deleted'); RENDER.profile(); }).catch(() => {}),
  askReset: () => confirmSheet('Reset demo data?', 'This restores the original demo database: bookings, check-ins, profile and settings.', 'Reset everything', 'reset'),
  reset: (_, el) => busy(el, 'Resetting…', async () => { await api.reset(); closeSheet(); S.result = null; toast('Demo data restored'); go('home'); }).catch(() => {}),
  signOut: () => toast('Sign-in arrives with the security update (Week 7)'),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act], [data-go]');
  if (!el || el.disabled) return;
  if (el.dataset.go) return go(el.dataset.go);
  ACT[el.dataset.act]?.(el.dataset.arg, el, e);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role=button][data-act]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.setting;
  if (k) saveSettings({ [k]: k === 'reminder_minutes' ? +e.target.value : e.target.value });
});
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeSheet(); });

go('home');
