# Newer timezone data for Node (tz 2026e)

**Why.** British Columbia switched to permanent UTC−7 on 2026-11-01 (IANA tz 2026c and later: `America/Vancouver` stays at −07:00, abbreviated MST). Homebrew's Node uses ICU 78 with tz **2026a**, which still has Vancouver falling back to UTC−8. Without this folder, n8n's Sunday 20:00 audit fires at 21:00 real time, "today" is off by an hour around midnight, and n8n disagrees with Vercel (newer data) about every November timestamp.

**What.** These four files hold ICU's timezone data. They were extracted from the ICU 79.1 data already on this Mac (`brew` package `icu4c@79`, tz 2026e) by `scripts/update-icu-tz.mjs`:
- `zoneinfo64.res`
- `metaZones.res`
- `timezoneTypes.res`
- `windowsZones.res`

ICU loads them instead of its built-in timezone data when the env var `ICU_TIMEZONE_FILES_DIR` points here. The `.res` format works across ICU ≥ 4.4.

**How it's used.**
- **n8n:** start it with `n8n/icu-tz/bin` first on `PATH`. The preview servers `leftover-n8n`, `leftover-n8n-fresh` and `leftover-dashboard` do this. The `bin/node` wrapper sets `ICU_TIMEZONE_FILES_DIR` and runs the real `node`. A plain env var isn't enough, because n8n's Code-node task runner gets `PATH` but no other variables.
- **Tests:** `npm test` sets `ICU_TIMEZONE_FILES_DIR=n8n/icu-tz`. `lib/week.test.mjs` fails if the data is older than 2026c.
- **Refresh** after a future tz release (`brew upgrade icu4c`), then commit the result: `node scripts/update-icu-tz.mjs`.
