# Orbit

Orbit is a full-stack student-update dashboard. It persists accounts, profile choices, selected spaces, connectors, and reminders in a local JSON database, then serves the website and API from one Node.js process.

## Run it

From this folder, run:

```powershell
npm start
```

Then open [http://localhost:3000](http://localhost:3000). Do not open `index.html` directly—the browser must use the local server for login, reminders, and persistent data.

Use **Try demo** on the sign-in screen to load the seeded account and sample college updates.

## Make it public for any student (Vercel + Supabase)

The original local server is useful for prototyping. For a public multi-student launch, use the files in `supabase/` and do **not** use the local JSON database as production storage.

1. Create a Supabase project, open **SQL Editor**, and run [supabase/schema.sql](supabase/schema.sql).
2. In Supabase Auth, enable Email and Google. Configure the Google provider with a single OAuth web-client owned by Orbit; add your Vercel domain to its allowed redirect URLs.
3. Copy `public-config.example.js` to `public-config.js` and fill its project URL and **publishable/anon key**. Never put a service-role key in browser code.
4. Push this folder to GitHub, import it in Vercel, and deploy. Add any secret server connector keys only in Vercel environment variables—not in `public-config.js` or Git.
5. For each college, an approved administrator should add the official RSS/API/Telegram/WhatsApp Business source. Students then choose their college; they do not provide a college password.

Supabase RLS policies in the schema isolate every student’s profile, memberships, saved notices, and reminders. Public sources are college-owned and should be populated only by trusted backend jobs or college administrators.

## What is stored

The server creates `data/orbit.json` on first use. It stores:

- student profile, department, year, section, and selected societies/spaces;
- password hash (for this local prototype);
- selected connector status;
- reminders; and
- incoming update records, sorted teacher → official → society/class and then by deadline.

## API routes

| Route | Purpose |
| --- | --- |
| `POST /api/auth/register` | Create an account and session |
| `POST /api/auth/login` | Sign in |
| `POST /api/auth/demo` | Create/use the local demo user |
| `GET /api/dashboard` | Fetch the signed-in student’s ranked feed |
| `PUT /api/me` | Save profile and spaces |
| `POST /api/reminders` | Persist a deadline reminder |
| `GET/POST /api/connectors/*` | Read/create connector setup state |
| `POST /api/ai/brief` | Return a ranked daily briefing |

## Google Classroom (alongside the college website)

Classroom is a separate connector, in addition to — not instead of — the college website/RSS
option above. Both can be connected at the same time; use whichever your college actually
updates.

- It reuses the **same** Google OAuth client you already created for Gmail — you only need to
  additionally enable the **Google Classroom API** on that same Google Cloud project, and add
  `http://localhost:3000/api/oauth/classroom/callback` (and your production URL's equivalent) as
  an authorised redirect URI.
- On the Connections page there's a **Google Classroom** step with its own email field. If the
  Google account your school actually uses for Classroom is different from whichever email you
  used to sign in to Orbit, type it there first — Google will open the sign-in screen with that
  address pre-filled (you can still pick a different account on Google's own screen; this only
  sets the default).
- Connecting does **not** import everything automatically. After you authorise, a **"Choose which
  classes to follow"** picker opens, listing every active Classroom course on that Google account
  — tick only the teachers/classes you actually want. Updates are grouped by class name (not a
  generic bucket like "Hackathons & events"), each as its own tab with a **×** to stop following
  it. Press **🎓 Manage classes** (in Connections or on the Classroom page) anytime to add more
  classes or remove ones you no longer want — same idea as adding/removing Telegram chats.

## Add your own notes to Important

Besides saving messages/attachments from email, WhatsApp or Telegram, the **Important** page also
lets you add files yourself, from the one-line action row under the folder list:

- **📷 Take photo** — opens a live camera preview (works with a laptop's webcam, not just a
  phone's camera app). On a phone, a **🔄 Flip camera** button switches between front and back.
  Capture, then **Retake** or **Use this photo**.
- **📁 Add file** — picks any file from your device (works on both phone and laptop).

Either way, you're then asked to **name it** and pick a folder (or create a new one) — same
rename-and-file-into-a-folder step whether you're saving a photo, an upload, or any message/
attachment from elsewhere in the app. Files are capped at 20 MB and stored under
`data/important-media/`.

## Connecting real services

Copy `.env.example` to `.env` and keep that file outside source control. The credentials must remain on the server, never in `app.js`.

- **Google email:** this build includes the web-server OAuth redirect and callback. Create a Google Cloud OAuth **Web application**, enable Gmail API, add `http://localhost:3000/api/oauth/google/callback` as its authorised redirect URI, then place its credentials in `.env`. The app requests only `gmail.readonly` plus basic sign-in identity. After sign-in, call `POST /api/sync/gmail` to import recent mail.
- **WhatsApp:** use Meta WhatsApp Business only after the college/organisation has approved the business account and webhook. WhatsApp’s public APIs do not generally permit an app to silently read a student’s personal group messages, so Orbit should only ingest notices a group administrator explicitly forwards or posts through an approved business workflow.
- **Telegram:** create a bot with BotFather, add it to approved college channels/groups, set `TELEGRAM_BOT_TOKEN`, and call `POST /api/sync/telegram`. Bots can receive messages they are permitted to see; they cannot read a student’s private Telegram history.
- **College portal:** connect only to a college-approved API, RSS/Atom notice feed, or webhook. Set its HTTPS RSS/Atom URL as `COLLEGE_PORTAL_FEED_URL` and call `POST /api/sync/college-feed`. Do not scrape portals or store a student’s college password.

## AI answers

The AI panel and daily briefing call Google's Gemini API (free tier) and answer using only the student's synced updates as context. Get a free key at https://aistudio.google.com/apikey and add it to `.env` as `GEMINI_API_KEY` — without it the panel will say AI isn't configured instead of guessing.

## Deadline push notifications

Reminders and calendar deadlines within about an hour trigger a real browser/OS push notification, even if the tab is closed. To enable it:

1. Run `npx web-push generate-vapid-keys` once and put the two keys in `.env` as `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, plus a `VAPID_SUBJECT` (a `mailto:` address).
2. Restart the server, sign in, and press **Enable notifications** on the Settings page.

## Email reminders (1 day before a deadline)

Whenever a student saves a reminder on an update that has a deadline, Orbit emails them
about 24 hours before it's due — separate from, and independent of, the push notifications above.

1. Add SMTP credentials to `.env`: `SMTP_HOST`, `SMTP_PORT` (587 for most providers), `SMTP_USER`,
   `SMTP_PASS`, and optionally `SMTP_FROM` (defaults to `SMTP_USER`) and `SMTP_SECURE=true` if your
   provider requires an SSL connection instead of STARTTLS.
2. For Gmail, use an [app password](https://myaccount.google.com/apppasswords) as `SMTP_PASS` —
   not the account's normal login password.
3. Restart the server. Without SMTP credentials, this feature is silently skipped — nothing breaks.

The same background sweep that checks push notifications (`setInterval(checkReminders, ...)` in
`server.js`) also checks for reminders that are ~24 hours from their deadline and haven't been
emailed yet, and sends one email per reminder. Like the push sweep, this only runs on a host that
keeps one Node process alive continuously — see the Vercel note below for the serverless caveat.

For a public deployment, replace the JSON store with Postgres, use a mature password/authentication provider, encrypt OAuth tokens, use HTTPS, apply rate limits and CSRF protection, and send scheduled reminders through an approved notification service.

### Why reminders/push can stop working after deploying to Vercel

The background sweep in `server.js` (`setInterval(checkReminders, ...)`) only fires on a host that
keeps one Node process running continuously — your own machine, a VM, Railway, Render, etc.
Vercel (and other serverless hosts) start your server fresh per request and never let a timer run
in the background, so that sweep silently never runs there — nothing is broken, it just can't
fire. To cover serverless deployments too, the client now also calls `GET
/api/reminders/check-now` every couple of minutes while the dashboard tab is open (see
`startReminderPolling` in `app.js`); this rides on a normal request so it works everywhere,
and it shows an in-app toast plus a real OS notification (if you already granted permission)
even without a push subscription. For a fully "closed-tab" experience on Vercel specifically,
move `checkReminders` into a Vercel Cron Job (or a Supabase Edge Function + `pg_cron`) instead of
relying on `setInterval`.

### Secrets

Never commit or share a real `.env` file — it only exists locally/in your host's environment
variables. `public-config.js` and `public-config.example.js` are safe to share; they only ever
hold the Supabase **anon/publishable** key, which is designed to be public.