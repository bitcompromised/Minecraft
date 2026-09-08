# mineflayer-web

Run Minecraft bots from a browser.

A multi-user control panel built on [mineflayer](https://github.com/PrismarineJS/mineflayer):
each account manages its own bot identities, servers and proxies, watches any
running bot in a real 3D view, talks through its chat, and extends it with
sandboxed automation modules bought and sold in a built-in marketplace. Around
that sits a forum, private messaging, and a full moderation panel.

Nothing to install for users — one Node process, one MongoDB, a browser.

---

## Contents

- [What it does](#what-it-does)
- [Pages](#pages)
- [Setup](#setup)
- [First steps](#first-steps)
- [Modules](#modules)
- [Roles, tiers and moderation](#roles-tiers-and-moderation)
- [Admin settings](#admin-settings)
- [How it fits together](#how-it-fits-together)
- [Project layout](#project-layout)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)

---

## What it does

**Bots**

- Save a Minecraft identity (Microsoft, Mojang or offline) once, then start it
  on any saved server. One identity can run on several servers at the same
  time, each connection with its own status, logs, modules and chat.
- Every connection runs in **its own child process**, so a crash takes down one
  bot rather than the server.
- Optional SOCKS5 / SOCKS4 / HTTP-CONNECT proxy per connection.
- Per-tier limits on how many connections a user may run at once.

**Watching and controlling**

- A real 3D first-person view (via
  [prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer)) with
  WASD + mouse-look, block breaking and placing, container UI, inventory
  drag-and-drop, health/food bars and a player list.
- **Hold** the left button to keep breaking: one press breaks the block under
  the crosshair and moves straight on to the next, and aiming elsewhere
  mid-swing switches target — the same as holding the button in the game.
  Digging never re-aims the bot, and clicks carry the aim they were made with,
  so what breaks is what the crosshair was on.
- The viewer is **started on demand** — it is the most expensive thing a
  connection does, and most connections are never watched.
- The viewer is served **through the panel's own origin**, at
  `/viewer/<profile>/<server>/`, rather than from its own port. It works over
  HTTPS and behind a reverse proxy with no second port opened, and every
  request is checked against the session that made it.
- A per-connection chat console on the client page: read the server's chat live
  and send messages as the bot without loading the 3D view at all.
- Both chat boxes - the 3D view's and the per-connection console on the client
  page - **complete module commands as you type**, from what the loaded modules
  declare (see [Declaring commands](#declaring-commands)). A declared command is
  handled by the module rather than sent to the server.
- Chat logs stay put while you read them: a new message only pulls the view
  down if you were already at the bottom.
- Full colour support for Minecraft's legacy `§` formatting in chat, item names
  and player names — rendered server-side to escaped HTML. Item **lore** is
  shown in tooltips the same way, including the JSON chat components 1.13+
  servers store names and lore as.
- **Who this bot has seen**: every player met on a server, with first-seen and
  last-seen times, kept in the database across restarts — searchable per
  connection, downloadable as CSV, and clearable.

**Marketplace**

- Write a module directly in the browser, in a code editor prefilled with a
  working skeleton. No files to prepare.
- Uploads are **compiled and checked before they are accepted** — a file that
  cannot parse, or that never exports an `onLoad`, is rejected with the reason
  shown in the upload dialog, with your code still in it.
- Buy and sell for credits; authors receive a configurable share of each sale.
- Versioning with a changelog, reviewable diffs, revert-to-any-version, ratings
  and reviews, per-module discussion, bug reports, and abuse reporting.
- Three free **demo modules** ship with the server. Anyone can read their full
  source without owning them — they are the fastest reference for the sandbox
  API.

**Community**

- Forum with sections, pinning, locking, threaded replies and reporting.
- Private messaging between users.
- In-app notifications for replies, module sales, pauses and warnings.
- Public user profiles with avatar, bio, threads, comments and modules.

**Moderation**

- Warnings that quote the exact thread, post or module they are about, with
  automatic pause and ban thresholds.
- Report queues for both modules and forum content.
- Full admin audit log of every staff action.
- Server monitoring: CPU, memory, disk, per-bot resource usage, credit totals
  and module sales.

---

## Pages

| Route | What it is |
|---|---|
| `/` | Public showcase page. Signed-in visitors are redirected to `/hub`. |
| `/hub` | Home — the forum and marketplace side by side, plus your stats. |
| `/forum` | Discussion, reviews, bug reports, and a staff-only section. |
| `/marketplace` | Browse, buy and publish modules. Demos pinned to the top. |
| `/client` | Everything to do with running bots, in four tabs. |
| `/play` | The 3D viewer. |
| `/messages` | Private messages. |
| `/settings` | Profile, account, invites and your warnings. |
| `/admin` | Staff panel — collapsed sections, opened as needed. |
| `/admin/monitoring` | Live server and bot resource stats. |

The old `/panel`, `/bots`, `/bot-profiles` and `/invites` URLs redirect to their
current homes.

---

## Setup

### 1. Node.js

Node 18 or newer. Install the LTS build from [nodejs.org](https://nodejs.org/),
open a **new** terminal, and check:

```bash
node --version
```

### 2. MongoDB

All application data lives in MongoDB. The only things on disk are uploaded
module source files, avatars and module media.

- **Windows:** `winget install --id MongoDB.Server --source winget` installs it
  as a service that starts on boot.
- **Anything else:** follow
  [MongoDB's install docs](https://www.mongodb.com/docs/manual/administration/install-community/),
  or point `MONGODB_URI` at a MongoDB you already have — local, remote or Atlas.

The app connects to `mongodb://127.0.0.1:27017` and uses a database named
`mineflayer_web`, both created automatically on first connect.

### 3. Dependencies

```bash
npm install
```

### 4. Configuration (optional)

```bash
cp .env.example .env
```

The defaults work against a local MongoDB. `WEB_PORT` and `MONGODB_URI` are the
two people usually change. Everything else — accounts, servers, proxies,
credits, quotas, tiers, bot limits — is configured through the web UI, not here.

### 5. Run

```bash
npm start
```

Every start prints a freshly generated admin password:

```
================================================================
 Admin login for this session (regenerated on every restart):
   username: admin
   password: <random>
================================================================
```

> The admin password is **regenerated on every start**, so there is no
> persistent guessable admin password sitting around. Ordinary user sessions
> are stored in MongoDB and survive restarts; only the admin has to fetch a new
> password from the terminal each time. Set `ADMIN_USERNAME` in `.env` to rename
> the account.

Open **http://localhost:3000** and sign in.

For development, `npm run dev` runs the same thing under nodemon.

---

## First steps

**Invite someone.** Settings → Invites → *Generate link*. Each link works once
and counts against your quota. An admin can open registration to anyone without
an invite (Admin → Website settings → *Allow sign-up without an invite code*).

**Add a server.** Client → Servers → *New server*. Name, host, port, and
optionally a pinned version. This is a saved destination, not a bot.

**Add a proxy** (optional). Client → Proxies → *New proxy*.

**Create a bot identity.** Client → Profiles → *New profile*. Pick the auth
type; for Microsoft accounts, a device-code sign-in prompt appears on the
connection itself the first time you start it.

**Start it.** Client → Running bots → *Spawn a bot*. Pick a profile, a server
and optionally a proxy.

**Watch it.** *Watch in 3D* on the connection, or open its chat console to read
and send chat without the viewer.

---

## Modules

A module is a single CommonJS file that exports lifecycle hooks:

```js
module.exports = {
  name: 'My Module',

  async onLoad(bot, api) {
    api.log('My Module loaded.')

    this.onChat = async (username, message) => {
      if (username === await bot.username) return
      // ...
    }
    api.on('chat', this.onChat)
  },

  async onUnload(bot, api) {
    api.off('chat', this.onChat)
  },
}
```

Three things surprise people:

- **`bot` is a proxy, not the real object.** Every property read and method call
  crosses a thread boundary, so *everything* on it is a Promise — write
  `await bot.entity.position`, not `bot.entity.position`. Rich values (Vec3,
  Block, Entity) arrive as plain data without their methods.
- **Subscribe with `api.on`, not `bot.on`.** Listener functions cannot cross
  into the sandbox. Note that the bot's own chat never comes back as a `chat`
  event — what you type into a bot's chat box is delivered to its modules as a
  `chat` from `@panel`, and a `/` command typed in game reaches them as a
  `whisper`.
- **Pass positions as plain `{x, y, z}`.** They are rebuilt into a real Vec3 on
  the far side before mineflayer sees them, so `bot.blockAt(pos)` and
  `bot.lookAt(point)` work — but a function never survives the crossing, so
  `bot.findBlocks({ matching })` has to take block ids rather than a matcher.

`api.log(message)` posts a line into the bot's chat log. Anything sent to
`console.*` is captured into that connection's log too.

### Declaring commands

A module can export a `commands` array describing the chat commands it answers
to. It is read straight after `onLoad` returns:

```js
module.exports = {
  name: 'Auto Announcer',
  commands: [{
    name: 'announce',
    aliases: ['ann'],
    usage: '/announce',
    description: 'Repeat a line on a timer.',
    subcommands: [
      { name: 'add', usage: '/announce add <text>', description: 'Add a line.' },
    ],
  }],
  async onLoad(bot, api) { /* ... */ },
}
```

The chat box on the Play page completes against it — command names, then
subcommands, each with its description — and the bot uses it to tell a module
command from a server one, so a declared command is handled by the module
instead of being sent on and answered with "Unknown command". Declaring is not
implementing: the command still arrives in your own `chat`/`whisper` listener.

The full contract is documented in-app at **`/marketplace/api`**, and the three
demo modules are readable by anyone from the marketplace.

### Publishing

Write the module in the code box on the marketplace upload form. Before it is
accepted the server:

1. Rejects ES module syntax (`export` / `import`) with an explanation, since
   modules are loaded with `require()`.
2. **Compiles** the source the way Node compiles a CommonJS module. Compiling
   is not running — nothing in the file executes, which matters because at that
   point nobody has reviewed it.
3. Checks statically that it exports an `onLoad`.

Every problem found is listed at once, in the dialog, with your code intact. An
accepted module sits in **pending** until an admin or mod reads the source and
approves it.

Updates work the same way: the code box opens pre-loaded with the version that
is live now, and the update is reviewed (with a line-by-line diff) before it
replaces what your users are running.

### How module files are stored

Accepted source is written to `data/modules/` with a self-describing name:

```
alice-vein-miner-v1.2.0-3f9c2a7b.js
└─┬─┘ └────┬───┘ └──┬──┘ └───┬───┘
owner   module   version   random
```

The first three parts make the directory readable — you can tell whose module a
file is, which one, and which version, without opening it or cross-referencing
the database. The random suffix is what guarantees uniqueness: two people can
publish modules with the same name, the same version can be resubmitted, and
slugs can collide after sanitising. Without it any of those would overwrite a
file another module record still points at, silently swapping one user's code
for another's.

Every part is sanitised down to lowercase alphanumerics and hyphens (the
version also keeps dots), so no stored name can escape the modules directory.

---

## Roles, tiers and moderation

Two independent axes, both set by an admin. See `src/roles.js`.

**Role** — structural:

| Role | Can do |
|---|---|
| `user` | The default. |
| `developer` | Admin panel, module review, read any module's source, unlimited concurrent bots, and bots that survive maintenance mode. |
| `admin` | Everything. |

A developer **cannot** ban, pause, reset the password of, or change the email of
an admin or another developer, and only an admin can assign roles — otherwise
the role would be a one-click path to the admin account.

**Status** — a tier: `normal`, `vip`, or `mod`. The `mod` tier grants module
review, the staff forum section, and password resets for non-staff accounts.
Tiers also set default invite quotas and concurrent bot limits.

### Warnings

Staff issue warnings against a specific thread, post or module. The content is
**snapshotted into the warning**, so editing or deleting the original afterwards
does not erase what it was about. The user is notified in-app and sees the
warning, the staff note and the quoted content on their settings page.

Crossing the configured thresholds automatically pauses and then bans the
account. Admins can revoke a warning — it stays on the record but stops counting.

---

## Admin settings

Admin → Website settings:

- **Site name**, announcement banner.
- **Registration** — open/closed, sign-up without an invite, starting credits,
  starting invite quota.
- **Maintenance mode** — switching it on immediately disconnects every running
  bot that is not owned by an admin or developer, and blocks everyone else from
  creating profiles or starting bots until it goes off. Staff bots keep running
  so maintenance can be tested against a live connection.
- **Bot limits** per tier.
- **Warning thresholds** — warnings before auto-pause, before auto-ban, and the
  ban duration.
- **Marketplace payout rate** — the fraction of each sale paid to the author.
- **Module sandbox import allowlist** — which Node builtins and npm packages a
  sandboxed module's `require()` may resolve. Seeded with `assert`, `util` and
  `events`.

Clearing the module sales figures on the monitoring page **archives** purchase
records rather than deleting them: the same records decide who owns what, so
deleting them would strip every buyer of everything they had paid for.

---

## How it fits together

```
browser ── HTTP + socket.io ──► server.js
                                   │
                                   ├── routes/*        REST API
                                   ├── db.js           MongoDB
                                   └── botManager.js
                                          │  one child process per connection
                                          ▼
                                     botChild.js  ◄── owns the live mineflayer bot
                                          │            and the 3D viewer
                                          │  one worker thread per loaded module
                                          ▼
                                   moduleSandbox.js ──► sandboxWorker.js
```

- **botManager** owns the process table and relays everything over IPC.
- **botChild** is the only place a real `bot` object exists. Chat, health,
  inventory, position and errors are pushed back to the parent as plain
  messages and re-emitted over socket.io.
- **moduleSandbox / sandboxWorker** run each module in its own worker thread.
  The worker never receives the bot object — it gets a proxy whose every access
  is an async round trip, which is what makes the import allowlist enforceable.
- **viewerProxy** puts each connection's prismarine-viewer behind the panel's
  own origin. The viewer still runs on its own port inside the child process;
  nothing but this process needs to reach it, and the browser never does
  directly. The mount path doubles as the viewer's own path prefix, because
  prismarine-viewer's browser bundle derives its socket.io URL from the page's
  pathname — the two only agree when the path *is* the prefix.

---

## Project layout

```
src/
  server.js           express app, routes, socket.io wiring
  db.js               every MongoDB query
  mongo.js            connection + persisted secrets
  auth.js             sessions, password hashing, route guards
  roles.js            who may do what
  userBadge.js        the public User/Staff/Developer/Admin label
  moderation.js       warnings and automatic punishments
  botManager.js       child-process table, one per connection
  botChild.js         runs a single bot (entrypoint, forked)
  moduleSandbox.js    worker-thread host for one loaded module
  sandboxWorker.js    runs inside that worker (entrypoint)
  moduleValidator.js  compile + export checks for uploads
  demoModules.js      the seeded example modules
  mcFormat.js         Minecraft "§" formatting -> escaped HTML
  itemData.js         item name/lore/player name serialisation
  viewerProxy.js      serves each 3D viewer through the panel's own origin
  proxyConnect.js     SOCKS/HTTP proxy dialling
  serverMonitor.js    CPU/memory/disk sampling
  bootstrap.js        admin account, allowlist, demo modules
  pagination.js       shared list filtering/paging
  lineDiff.js         changelog diffs
  routes/             one file per API area

public/
  css/                theme.css tokens + panel/landing/login/viewer styles
  js/chatCommands.js  module-command completion, shared by both chat boxes
  js/                 one script per page, plus shared dialog/paginate/tabs

views/                EJS templates, partials in views/partials
data/                 uploaded module source, avatars, module media
modules/              ready-to-publish module source (see modules/README.md)
```

---

## Security notes

**Read this before letting anyone else upload modules.**

Modules run in a dedicated worker thread with no reference to the live bot
object and an admin-controlled import allowlist. That gives real crash and
memory isolation, and makes the allowlist enforceable — but worker threads
share the server's process, so it is **not a hard security boundary**.

Admin approval means a human read the source. It is not a guarantee. Only
approve code you have actually read and understood, and only add things to the
import allowlist when you know what granting them means — adding `fs` or
`child_process` effectively reopens the sandbox for anything that imports them.

Other things worth knowing:

- Uploaded source is compiled, never executed, during validation.
- All Minecraft-sourced text (chat, item names, player names) is escaped
  server-side before it reaches the browser.
- Bans take effect immediately, including on already-open socket connections.
- Sessions are stored in MongoDB and signed with a secret persisted there, so
  logins survive restarts.

---

## Troubleshooting

**A bot is stuck on "connecting", or shows an error.** Open the connection on
the Client page — the status line carries the underlying reason, and *Show
logs* has the full lifecycle. Pinning an exact version on the server entry
resolves most version-mismatch failures.

**`array size is abnormally large`.** The byte stream desynced. Almost always
either a version mismatch (pin the version on the server entry) or an
anti-bot/CDN proxy in front of the server altering the raw connection, which
mineflayer cannot get through.

**A module does nothing.** Check *Show module errors* on that connection —
load failures, crashes and uncaught errors all land there, each expandable to
its full stack trace. Remember `bot.*` is always a Promise and events need
`api.on`.

**The 3D view is blank.** It starts on demand and takes a moment on first open.
If it never appears, the connection's log will say why the viewer failed.

**Locked out of the admin account.** Restart the server; it prints a new
password.

**Resetting everything.** Drop the `mineflayer_web` database. On the next start
the admin account, the import allowlist and the demo modules are recreated. Any
uploaded module files left in `data/modules/` become orphans and can be deleted.
