# JitsFlow

**Your no-gi game, mapped.** An off-the-mat technique database and flow chart: every position, attack chain and escape from white to black belt, plus a training log that points you at what to study next.

There are two versions, built from the same source:

| Version | Where | What it has |
|---|---|---|
| **claude.ai** | `dist/jitsflow-claude.html`, published as a claude.ai Artifact | Everything below, plus saving to your Claude account, your own video clips and photos, and "Explain in more detail" answers from Claude |
| **Website** | `web/` served by `server.js`, deployed on Render from `render.yaml` (e.g. jitsflow.com). `/` is the landing page, `/app/` is the app. | Installs to your home screen, works offline at the gym, YouTube videos can play inside the app. Progress is saved on the device. |

## What's inside

- **137 no-gi techniques** across four stages (white→blue 74, blue→purple 31, purple→brown 18, brown→black 14), each with steps, key details, common mistakes, a drill and what it chains into.
- **Flow map** (Learn › Map): 20 positions, ranked best to worst, with attack chains ("if they defend like this, go there") and the mirrored defense view.
- **Defense & escapes**: 24 submission defenses and escapes; anything you log as tapping you links to its defense.
- **Home**: next class, fees due, spaced review, next-class mission, weak spots, weekly plan, focus block and off-day solo drills. Belt path and skill readiness live in Learn › Belt.
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
npm run test:db                       # all database suites: API, bookings, competitions, booking races, booking screens, accounts
npm run test:stress                   # whole site: access rules, bad input, sign-in limits, 150 students at once, every public page and link;
                                      # then every screen for visitor/student/coach/coach-study on 5 screen sizes in light and dark, plus swipes
```

## Accounts and the coach dashboard (website)

**Navigation.** A new visitor first picks how they use JitsFlow: **I train at a gym** (gym code, then sign up), **I run a gym** (start-gym sign-up) or **Just me** (the study setup questions), with Sign in below. Invite links (`?join=`, `?claim=`), `?start=1`, `?signin` and password-reset links skip that screen. Students get **Home** (next class, fees due, today's study), **Classes** (booking; hidden without a gym), **Learn** (Moves · Map · Belt), **Journal** (the training log) and **Me** (account, fees and payments, gym, invites, settings). Coaches running their gym get **Home** (today's classes, what needs attention, quick actions), **Schedule** (calendar and privates), **Members** (roster and insights, with Competitions behind a switch), **Money** (head coach only) and **Gym** (profile, website import, invites, account, appearance). Gym › **My training** switches a coach to the study tabs; **Manage <gym>** at the top of Home switches back. The round initials button in the header opens Me (students) or Gym (coaches). Each tab shows a one-line tip on its first 3 visits (or until closed), remembered per person on each phone. Old addresses still work: `#today`, `#learn`, `#flow`, `#log`, `#settings`, `#book`, `#coach-today`, `#coach-classes`, `#coach-students` and `#coach-comps` open the new places. Rows of classes, training-log sessions, payments and competitions can be swiped right to edit and left to delete (delete always asks first).

When the server has a `DATABASE_URL`, the website adds:

- **Accounts:** students and coaches sign in with email and password. Progress, training logs and settings sync to the server.
- **Gyms:** a coach starts a gym and gets two codes: a student code (invite link `/app/?join=CODE`) and a coach code for assistant coaches. Codes can be replaced at any time.
- **Classes:** coaches plan classes ahead with a focus, techniques and notes. Students see the next class on Home and tap "I'm going". The coach sees who's coming with their readiness, weakest area, where they get stuck and what taps them, plus a suggested focus, and marks attendance.
- **Roster:** every student with belt and stripes, readiness, last session, attendance, monthly fee and paid/due status. Coach notes are private to coaches.
- **Import from your website (Coach › Gym):** paste the gym's website and JitsFlow crawls the whole site (every linked page on the same address plus its sitemap.xml, up to 30 pages, most relevant first, skipping shop and checkout pages). It pulls out the name, logo, address, phone, email, social links, weekly timetable, coaches and rates, and shows them in an editable preview. Nothing is saved until the coach taps **Save to my gym**. Students then see the timetable, rates, coaches and Call / WhatsApp / Directions buttons in Me, and the timetable fills the Next class card when no classes are planned. **Add classes** turns the timetable into real classes for the next 1–8 weeks (duplicates are skipped) so students can RSVP. If the gym has no standard fee yet, the first monthly rate becomes it.
- **Outreach (JitsFlow team, `JF_ADMIN_EMAILS`):** paste gym websites; each is read and **built as a real gym nobody owns yet** (timetable and 8 weeks of classes, plans from its prices, coaches, logo, colour). The email's button opens `/app/?gym=<token>`: the real app as that gym's head coach would see it, read only (the token is sent as `x-jf-preview`; the server allows only the head coach's read screens for that one gym and answers every change with "Claim your gym first"). Claiming is the normal sign-up (or sign-in) and is first come; the team can unclaim or reassign from the gym's Outreach page. The free months start at the claim. Unclaimed gyms have no working codes, no jobs, aren't counted as gyms, and are deleted on opt-out, on "Not my gym", or 60 days after building if their link wasn't opened in the last 14 days.
- **Beta ("founding gyms"):** head coaches apply from the Gym tab (or when claiming). The team accepts in the dashboard's Beta section (default: free for 6 months, then R49/month while in the beta), switches feature flags on per gym (read by the app as `gym.features`), and reads feedback (text and a screenshot, also emailed to the team). Past the free months with no card, nothing locks: the head coach just sees a calm "keep JitsFlow for R99/month" line.
- **Booking:** classes can have a spot limit. When full, students join a waitlist; when someone cancels, the first person waiting gets the spot and an email. Two people tapping the last spot at once can't both get it. Students check themselves in from 45 minutes before class; coaches can check in everyone booked in one tap. Cancelling a class emails everyone booked.
- **Who's booked:** students see the first name, last initial and belt of everyone booked on a group class (the gym can switch this off in Coach › Gym). Private lessons are never listed to other students.
- **Private lessons:** coaches post bookable slots (Coach › Classes › + Private slots) with a price and 1–3 places; a booked slot disappears for everyone else.
- **Memberships:** plans with a price, period and optional classes-per-week limit (Coach › Gym, or "Use my website prices"). Each student gets a plan and a status (active, trial, paused, cancelled). Weekly limits and paused/cancelled status are enforced at booking. Students see their plan, bookings used this week, visits this month and streak in their Classes tab.
- **Insights (Members › Insights):** active members, visits per week (12-week chart), visits per member, 90-day retention; students grouped as regular, occasional, at risk (stopped or halved in the last 4 weeks), new and not training; busy and quiet class times; who might be ready for a promotion review (classes since their last belt/stripe change plus technique readiness); unpaid members; revenue against what plans should bring in. A "visit" is a check-in, or a booking for a class where nobody was checked in, so it works even if the coach never takes attendance. One tap emails at-risk, unpaid or new members (replies go to the coach).
- **Payments:** record payments by hand, assign unmatched ones, see this month's totals. (Automatic proof-of-payment email import is the next phase.)
- **Head coach:** each gym has one. Whoever starts the gym is it (gyms from before this: the earliest coach in the gym), and they can hand the role to another active coach in Coach › Gym. Only the head coach sees and changes money: the Money tab, fees, plans and payment history on student pages, recording and checking payments, bank details, PayFast, membership plans, private-lesson packs, the access fee and the JitsFlow plan. The server enforces it (403 on every money route; other coaches get the roster and student pages without money fields). Payment emails (bank or PayFast details changed, a proof of payment to check, a card payment in) go to the head coach only; coach removals still go to every coach. The head coach can't be removed, marked inactive, delete their account or move gym until they hand over. A gym left with no active head coach gets one by itself: the longest-standing active coach.
- **Private lesson packs:** the head coach sets up packs in Money › Setup (name, lessons, price, optional expiry in months). Students buy one on their Pay sheet (by card through PayFast, or by EFT with a proof the head coach confirms), or the head coach records it. A confirmed pack payment adds its lessons; it doesn't count toward monthly fees. Each private a student is checked into, or is still booked on when it starts, uses one (booked privates still to come hold one, so "privates left" is what's free to book). A private with no lesson left for it is owed at the slot's price, in its month, as a one-off on their fees. Students see "N privates left" on their fees card and on private slots; coaches see it on the roster, the student page (with the ledger) and a private lesson's bookings.
- **Access fee:** Money › Setup › "Access fee for private-only clients" (0 = off). A student with no active plan and no personal fee who books or attends a private in a month owes the access fee that month (instead of the gym's standard fee). It's added on the Money page, in reminders and on their Pay sheet, labelled "Access fee". Members with an active plan don't pay it.
- **Private lesson prices by membership:** Money › Setup › Private lessons. Each plan can have a private lesson price (on the plan form), and the gym can have one for clients without a membership (no active plan and no monthly fee of their own or the gym's standard fee: the same clients who pay the access fee). What a private costs: a pack lesson if they have one left; else their active (or trial) plan's private price; else, without a membership, the gym's price for them; else the slot's own price (so gyms that set none of this see no change). The price is locked in on the booking when they book, are moved off the waitlist, or the coach adds them; changing prices later doesn't change privates already booked (bookings at the slot's own price follow the slot's price). Older bookings with no price on them cost the slot's price, as before tiers. A group class made into a private locks in the price for the people already on it. Private-lesson prices on the imported website aren't offered as membership plans. Students see their own price on private slots and when booking ("R900 for you · Full membership", or "Uses 1 of your 3 privates"); the head coach sees each booking's amount on the private. Prices on the gym's imported website that mention private, 1-on-1, one on one or PT are offered as one-tap prices.

Without a database the site works exactly as before, saving on the device.

**Email (Resend):** with `RESEND_API_KEY` set, JitsFlow sends a welcome email on sign-up (coaches get their invite link), **Forgot your password?** links that work once and expire after an hour (a reset signs the account out everywhere else), and **Invite by email** from Coach › Gym (up to 30 at a time, 100 a day per gym; people already in the gym are skipped). Mail comes from `JitsFlow <no-reply@jitsflow.com>` with replies to `hello@jitsflow.com` (change with `MAIL_FROM` / `MAIL_REPLY_TO`). Links always use `APP_URL`, never the request's Host header. `GET /api/status` shows whether email and the Claude import are switched on. Setup: verify jitsflow.com in Resend (region eu-west-1), add its DNS records in Cloudflare, create a sending-only API key and add it to the `jitsflow-app` environment on Render. Incoming mail to hello@ is handled by Cloudflare Email Routing.

**Smarter import with Claude (optional):** without a key the import uses a plain read (site data, meta tags, links and simple text patterns): good for contact details, logos, list-style timetables and "R 850 per month" prices, weak on timetable grids, price cards and timetables posted as images. Add an `ANTHROPIC_API_KEY` environment variable to the `jitsflow-app` service on Render (Environment → Add) and the import also sends the pages' text (and up to two timetable or price images) to Claude, which reads those layouts. Override the model with `JF_IMPORT_MODEL`. A failed or declined Claude read falls back to the plain read. Cost is roughly one request per import; imports are limited to 12 per gym per hour.

**Import safety:** only public `http(s)` sites on ports 80/443 are fetched. Private, loopback, link-local and cloud-metadata addresses are refused, including after redirects and at connect time (so DNS tricks don't get around it). Pages are capped at 1.5 MB and 10 seconds; logos must be real PNG/JPEG/WebP/GIF/ICO files under 400 KB (SVG is refused because it can carry script) and are stored in the database and served from JitsFlow. Page text is treated as untrusted: Claude is told to ignore instructions in it, and everything goes through the coach's review.

**Security:** passwords are hashed with bcrypt; sessions are random tokens stored hashed, in HttpOnly SameSite=Lax cookies (Secure in production); every change needs a custom header that cross-site forms can't send; sign-in attempts are rate-limited; coaches only ever see their own gym. Account data is never cached by the offline service worker.

**Privacy (POPIA):** the app stores names, emails, training logs, attendance and payments. Students can delete their account and all their data in Me. Before launch, publish a privacy notice that says who runs JitsFlow, what's stored, why, and how to ask for deletion, and get the gym's agreement for storing payment records.

## Search and sharing (SEO)

`python3 build.py` also runs `tools/seo.js` (needs Playwright), which turns the app's content into plain pages search engines can read and people can share:

- `/techniques/` and a page per technique (steps, details, mistakes, drill, video, what comes next, how to defend it), `/positions/` and a page per position, `/belts/<belt>/`, `/glossary/`, `/privacy/` and a 404 page.
- Each page has a title and description written for search, a canonical address, structured data (HowTo, BreadcrumbList, ItemList, DefinedTermSet, FAQPage on the home page), and its own 1200×630 share card in `web/og/` so links look good in WhatsApp, Instagram and X. Cards are only redrawn when their text changes (`tools/og-manifest.json`).
- `sitemap.xml` and `robots.txt`. Unknown addresses now return a real 404, and `/techniques/x` redirects to `/techniques/x/`, so every page has one address.
- "Open in JitsFlow" on a technique page opens `/app/?t=<id>`, which opens that technique in the app. "Send to a training partner" shares the page on WhatsApp (or the phone's share sheet).

After deploying: add jitsflow.com to [Google Search Console](https://search.google.com/search-console) (Domain property, verify with the TXT record in Cloudflare) and submit `https://www.jitsflow.com/sitemap.xml`.

## Analytics

Set `GA_ID` (your Google Analytics 4 measurement ID, `G-…`) on the `jitsflow-app` service. The server then adds `analytics.js` to every page. Nothing is sent to Google until the visitor taps **Allow** on the consent card (Consent Mode v2, ads storage always denied); the choice is remembered and can be changed from **Cookie settings** in the footer. Events: page views (including app tabs), `sign_up`, `login`, `share` (invite link copied or emailed, technique pages shared), `select_content` (technique opened), `log_session`, `rsvp`, `gym_import`, `video_start`, `open_app`. Without `GA_ID` nothing is added.

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
