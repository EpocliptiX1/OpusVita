# OpusVita

Wellbeing check-in + psychologist booking for office workers (ICT course project).

## Run it

Needs Node.js 22.13 or newer (uses the built-in SQLite driver, so there is nothing to `npm install`).

```
npm start
```

Open http://localhost:3000. The database is created automatically in `data/opusvita.db` with demo data.
To start over, use **Profile → Reset demo data**, or delete the `data` folder.

## How it is built

| Layer | File | Job |
|---|---|---|
| Interface | `public/index.html`, `public/styles.css` | Screens and styling (light/dark) |
| App logic | `public/app.js`, `public/charts.js` | State, navigation, SVG charts |
| API client | `public/api.js` | Sends JSON requests over HTTP to the server |
| Server | `server.js` | REST API: validation, check-in scoring, matching, availability |
| Database | `db.js` → `data/opusvita.db` | SQLite tables: users, settings, psychologists, health_daily, checkins, bookings |

Data flow: band data (simulated) → `health_daily` → dashboard and stress alert → check-in → score and psychologist match → booking saved in SQLite.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | /api/dashboard | Today's metrics, wellbeing score, alert, upcoming session |
| GET | /api/health?days=7\|30\|60 | Daily wearable data + personal baseline |
| POST | /api/device/sync, PUT /api/device | Sync / connect / disconnect band |
| GET, PUT | /api/me, PUT /api/settings | Profile and settings |
| GET | /api/psychologists, /api/psychologists/:id/availability | Psychologists and free slots |
| GET, POST, DELETE | /api/checkins | Check-in history, submit (returns score + matches), delete history |
| GET, POST | /api/bookings | List / create sessions |
| PATCH | /api/bookings/:id | Reschedule or cancel (locked within 12 h) |
| GET | /api/export | Download all my data as JSON |
| POST | /api/reset | Restore demo data |

Rules enforced on the server: no double-booking (a unique index in SQLite), no changes within 12 h of a session, at most 3 upcoming sessions, and validated profile and settings fields.

Heart-rate, sleep, HRV, steps and stress values are simulated demo data.
