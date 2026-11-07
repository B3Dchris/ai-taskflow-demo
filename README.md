# JitsFlow

**Your no-gi game, mapped.** An off-the-mat technique database and flow chart: every position, attack chain and escape from white to black belt, plus a training log that points you at what to study next.

There are two versions, built from the same source:

| Version | Where | What it has |
|---|---|---|
| **claude.ai** | `dist/jitsflow-claude.html`, published as a claude.ai Artifact | Everything below, plus saving to your Claude account, your own video clips and photos, and "Explain in more detail" answers from Claude |
| **Website** | `web/` served by `server.js`, deployed on Render from `render.yaml` (e.g. jitsflow.com). `/` is the landing page, `/app/` is the app. | Installs to your home screen, works offline at the gym, YouTube videos can play inside the app. Progress is saved on the device. |

## What's inside

- **137 no-gi techniques** across four stages (white→blue 74, blue→purple 31, purple→brown 18, brown→black 14), each with steps, key details, common mistakes, a drill and what it chains into.
- **Flow map**: 20 positions, ranked best to worst, with attack chains ("if they defend like this, go there") and the mirrored defense view.
- **Defense & escapes**: 24 submission defenses and escapes; anything you log as tapping you links to its defense.
- **Today**: belt path, skill readiness, skill map, weekly plan, next-class mission, focus block, spaced review, weak spots and off-day solo drills.
- **Glossary**: 89 jiu-jitsu terms; tap any underlined word for its meaning.
- **Coach review list**: moves whose details vary between coaches are flagged until your coach checks them.

## Build

```bash
python3 build.py            # writes dist/jitsflow-claude.html and web/ (index.html + sw.js)
python3 tools/make_icons.py # only if you change the icon design
```

Edit the app in `src/app.html` and the landing page in `src/landing.html`. Landing-page screenshots come from `node tools/screenshots.js` (run after `build.py`, then build again). Picked YouTube videos live in `src/videos.js`; re-check them with `python3 tools/merge_videos.py`. Advanced techniques live in `src/content-*.js` (format and rules in `src/content-brief.md`).

## Test

Needs Node and Playwright with Chromium.

```bash
node tests/run.js local "iPhone 13"   # claude.ai version, saving on the device
node tests/run.js db "iPhone SE"      # claude.ai version, simulated account saving, uploads and Claude answers
node tests/web.js                     # website via server.js: headers, install, service worker, offline
node tests/importer.js                # gym website import against a fake gym site (no database or API key)
npm test                              # all of the above
DATABASE_URL=postgres://localhost/jitsflow_test node tests/api.js       # accounts API (wipes that test database)
DATABASE_URL=postgres://localhost/jitsflow_test node tests/accounts.js  # coach + student end to end in browsers
```

## Accounts and the coach dashboard (website)

When the server has a `DATABASE_URL`, the website adds:

- **Accounts:** students and coaches sign in with email and password. Progress, training logs and settings sync to the server.
- **Gyms:** a coach starts a gym and gets two codes: a student code (invite link `/app/?join=CODE`) and a coach code for assistant coaches. Codes can be replaced at any time.
- **Classes:** coaches plan classes ahead with a focus, techniques and notes. Students see the next class on Today and tap "I'm going". The coach sees who's coming with their readiness, weakest area, where they get stuck and what taps them, plus a suggested focus, and marks attendance.
- **Roster:** every student with belt and stripes, readiness, last session, attendance, monthly fee and paid/due status. Coach notes are private to coaches.
- **Import from your website (Coach › Gym):** paste the gym's website and JitsFlow reads the home page plus up to 8 pages that look like timetable, prices, coaches or contact. It pulls out the name, logo, address, phone, email, social links, weekly timetable, coaches and rates, and shows them in an editable preview. Nothing is saved until the coach taps **Save to my gym**. Students then see the timetable, rates, coaches and Call / WhatsApp / Directions buttons in Settings, and the timetable fills the Next class card when no classes are planned. **Add classes** turns the timetable into real classes for the next 1–8 weeks (duplicates are skipped) so students can RSVP. If the gym has no standard fee yet, the first monthly rate becomes it.
- **Payments:** record payments by hand, assign unmatched ones, see this month's totals. (Automatic proof-of-payment email import is the next phase.)

Without a database the site works exactly as before, saving on the device.

**Smarter import with Claude (optional):** without a key the import uses a plain read (site data, meta tags, links and simple text patterns): good for contact details, logos, list-style timetables and "R 850 per month" prices, weak on timetable grids, price cards and timetables posted as images. Add an `ANTHROPIC_API_KEY` environment variable to the `jitsflow-app` service on Render (Environment → Add) and the import also sends the pages' text (and up to two timetable or price images) to Claude, which reads those layouts. Override the model with `JF_IMPORT_MODEL`. A failed or declined Claude read falls back to the plain read. Cost is roughly one request per import; imports are limited to 12 per gym per hour.

**Import safety:** only public `http(s)` sites on ports 80/443 are fetched. Private, loopback, link-local and cloud-metadata addresses are refused, including after redirects and at connect time (so DNS tricks don't get around it). Pages are capped at 1.5 MB and 10 seconds; logos must be real PNG/JPEG/WebP/GIF/ICO files under 400 KB (SVG is refused because it can carry script) and are stored in the database and served from JitsFlow. Page text is treated as untrusted: Claude is told to ignore instructions in it, and everything goes through the coach's review.

**Security:** passwords are hashed with bcrypt; sessions are random tokens stored hashed, in HttpOnly SameSite=Lax cookies (Secure in production); every change needs a custom header that cross-site forms can't send; sign-in attempts are rate-limited; coaches only ever see their own gym. Account data is never cached by the offline service worker.

**Privacy (POPIA):** the app stores names, emails, training logs, attendance and payments. Students can delete their account and all their data in Settings. Before launch, publish a privacy notice that says who runs JitsFlow, what's stored, why, and how to ask for deletion, and get the gym's agreement for storing payment records.

## Deploy on Render (Blueprint)

`render.yaml` at the root defines one service: **`jitsflow-app`**, a Node web service in **Frankfurt** on the **Starter** plan. `server.js` serves the prebuilt app in `web/` with compression, caching rules, security headers, a fallback to the app for unknown paths, and a `/healthz` health check. It has no dependencies.

1. Sign in at [render.com](https://render.com) with GitHub. Starter and the database are paid plans, so add a payment method under **Billing** first.
2. **New → Blueprint**, pick the repository and set the branch to **Jitsflow**.
3. Render lists `jitsflow-db` (PostgreSQL, Frankfurt) and `jitsflow-app` (Web Service, Frankfurt, Starter). Click **Apply**. The app creates its tables on first start.
4. The site is live at `https://jitsflow-app.onrender.com` (or the address Render shows). Every push to the Jitsflow branch redeploys it.

To change the app: edit `src/`, run `python3 build.py`, run `npm test`, commit `web/` and push.

Run it locally with `npm start` (port 10000, or set `PORT`).

## Connect jitsflow.com

1. Buy the domain (Cloudflare Registrar, Porkbun or Namecheap).
2. In `render.yaml`, uncomment the `domains:` lines and push. (Or add it in Render under **Settings → Custom Domains**.)
3. Render shows the DNS records to create. Add them exactly as shown at your registrar.
4. Render verifies the domain and issues the HTTPS certificate automatically.

## Install on iPhone

Open the site in Safari → Share → **Add to Home Screen**. It opens full screen, like an app, and works without signal.

## Move your progress from claude.ai to the website

In the claude.ai version: **Settings → Backup → Copy backup**. On the website: **Settings → Restore from backup**, paste, **Replace my data**. Your own video clips and photos stay on claude.ai.

## YouTube videos inside the app

On the website, a technique plays a YouTube video inside the page when it has one picked in `VIDS` in `src/app.html` (technique id → YouTube video id). Without one, the "Watch on YouTube" button opens a search. claude.ai blocks embedded video, so the claude.ai version always uses the button.

## Images

The site picks these up automatically when the files exist (then run `python3 build.py`). Prompts for all of them: see the JitsFlow image prompts page.

| File | Size | Used for |
|---|---|---|
| `web/img/positions/<position id>.jpg` (20) | 1024×1024 | Flow map, technique pages and thumbnails without a video, landing-page gallery (shown once 6+ exist) |
| `web/img/hero.jpg` | 1536×1024 | Landing-page hero background |
| `web/img/belts/{blue,purple,brown,black}.jpg` | 1024×1024 | Belt stage banners; landing-page belt row (shown when all 4 exist) |

Position ids: back_top, mount_top, sc_top, fhl_top, turtle_top, ashi, standing, open_top, cg_top, hg_top, seated, bfly_bot, cg_bot, hg_bot, sc_bot, fhl_bot, turtle_bot, ashi_def, mount_bot, back_bot.

## Before charging money

Have a black belt review the content, starting with the **Coach review list** on each belt page.
