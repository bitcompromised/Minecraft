// Runs inside a forked child process (see botManager.js's start()) - one
// child per active bot connection. Owns the live mineflayer `bot` object and
// the prismarine-viewer instance directly; everything the parent process
// needs (state changes, chat, errors, resource usage) crosses the IPC
// channel as plain messages instead of being read off a shared in-process
// object, since this process IS the only place that object exists.
const net = require('net')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { mineflayer: mineflayerViewer } = require('prismarine-viewer')
const minecraftData = require('minecraft-data')
const { Vec3 } = require('vec3')
const { buildConnectOption } = require('./proxyConnect')
const { serializeInventory, serializeItem, nameFields } = require('./itemData')
const McFormat = require('./mcFormat')
const { ModuleSandbox } = require('./moduleSandbox')
const config = require('./config')

const MOVE_CONTROLS = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'])

const CONTAINER_BLOCK_NAMES = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel',
  'furnace', 'blast_furnace', 'smoker',
  'hopper', 'dispenser', 'dropper',
  'brewing_stand', 'crafting_table',
])

function isContainerBlock(name) {
  if (!name) return false
  if (name.endsWith('shulker_box')) return true
  return CONTAINER_BLOCK_NAMES.has(name)
}

// How far the crosshair reaches. Matches mineflayer's own canDigBlock check
// (5.1 from the eye), so a block this can target is a block it can dig.
const CURSOR_REACH = 5

// prismarine-world's raycast records which face of the block the ray entered
// through, as a BlockFace enum, and the exact point where it crossed the
// surface. That face is the real answer to "what is the crosshair pointing
// at" - these are the direction vectors it corresponds to, which is the form
// bot.placeBlock wants.
const FACE_VECTORS = {
  0: new Vec3(0, -1, 0), // bottom
  1: new Vec3(0, 1, 0), // top
  2: new Vec3(0, 0, -1), // north
  3: new Vec3(0, 0, 1), // south
  4: new Vec3(-1, 0, 0), // west
  5: new Vec3(1, 0, 0), // east
}

// The face the ray actually entered through, falling back to the estimate
// below only when the raycast could not say (BlockFace.UNKNOWN, -999).
//
// The fallback used to be the only answer, and it is wrong wherever it
// matters: it picks the largest axis of the block-centre-to-eye vector, which
// is the face you would hit looking at the block head-on, not the face the
// crosshair is actually over. Looking at the top of a block from a shallow
// angle, it says "side"; standing on a block and mining downwards past its
// edge, it says "top". Placing a block then puts it on the wrong side of the
// target.
function cursorFace(bot, block) {
  const fromRaycast = FACE_VECTORS[block.face]
  if (fromRaycast) return fromRaycast
  return getPlacementFace(bot, block)
}

// Approximates which face of the targeted block is under the crosshair by
// picking the axis of the block-center-to-eye vector with the largest
// magnitude. Only used when the raycast has no face to give (see
// cursorFace) - it is an estimate, not a hit test.
function getPlacementFace(bot, block) {
  const eye = bot.entity.position.offset(0, bot.entity.height, 0)
  const center = block.position.offset(0.5, 0.5, 0.5)
  const dx = eye.x - center.x
  const dy = eye.y - center.y
  const dz = eye.z - center.z
  const absX = Math.abs(dx)
  const absY = Math.abs(dy)
  const absZ = Math.abs(dz)
  if (absX >= absY && absX >= absZ) return new Vec3(Math.sign(dx), 0, 0)
  if (absY >= absX && absY >= absZ) return new Vec3(0, Math.sign(dy), 0)
  return new Vec3(0, 0, Math.sign(dz))
}

function serializeWindow(window) {
  let title = 'Container'
  if (typeof window.title === 'string' && window.title) title = window.title
  else if (window.title && typeof window.title === 'object' && window.title.text) title = window.title.text
  return {
    id: window.id,
    type: window.type,
    title,
    slots: window.slots.map(serializeItem),
    inventoryStart: window.inventoryStart,
    inventoryEnd: window.inventoryEnd,
    hotbarStart: window.hotbarStart,
  }
}

// Set once per connection in handleStart() - whether the server/profile
// pinned an exact Minecraft version, or left it on auto-detect (`false`).
// Read by describeError() below to tailor its hint for the packet-parse
// error that pattern commonly triggers.
let versionWasPinned = false

// A corrupted/misaligned byte in the play-state packet stream (protodef's
// own safety check against reading a garbage-huge array length - see
// node_modules/protodef/src/datatypes/compiler-structures.js) almost always
// means either a Minecraft version mismatch (packet layouts differ between
// versions) or an anti-bot/CDN proxy in front of the server (Cloudflare,
// TCPShield, etc.) altering the raw TCP stream mineflayer expects to be a
// direct, unmodified Minecraft connection. Once this fires the byte stream
// is desynced for good, so the connection is unrecoverable either way - but
// the raw message is meaningless to anyone who isn't already familiar with
// protodef internals, so this rewrites it into something actionable.
const ARRAY_SIZE_PARSE_ERROR = /Parse error for .*: .*array size is abnormally large/i

function describeConnectionError(message) {
  if (!ARRAY_SIZE_PARSE_ERROR.test(message)) return message
  const hint = versionWasPinned
    ? 'This server sent data mineflayer could not parse correctly even with a pinned version - it may be sitting behind an anti-bot/CDN proxy (e.g. Cloudflare, TCPShield) that alters the raw connection, which mineflayer cannot get through.'
    : 'This server sent data mineflayer could not parse correctly, most likely because the auto-detected Minecraft version does not match what the server actually speaks. Try pinning an exact version on this server\'s entry (Bot Profiles page) instead of leaving it on auto-detect. If pinning the correct version doesn\'t help, this server may be sitting behind an anti-bot/CDN proxy (e.g. Cloudflare, TCPShield) that mineflayer cannot get through.'
  return `${message} — ${hint}`
}

// AggregateError (e.g. ECONNREFUSED from a dual-stack connection attempt)
// has an empty top-level .message, which would otherwise surface as a blank
// error to the user.
function describeError(err) {
  let message
  if (err.message) message = err.message
  else if (Array.isArray(err.errors) && err.errors.length) {
    const sub = err.errors.map((e) => e.message || e.code).filter(Boolean).join('; ')
    message = sub || null
  }
  if (!message) message = err.code || String(err)
  return describeConnectionError(message)
}

// Listens on port 0 so the OS hands back a free ephemeral port - each child
// picks its own, independent of every other bot's child process.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

let bot = null
let sandboxes = new Map() // moduleId -> ModuleSandbox
let stopping = false
let clickQueue = Promise.resolve()

// ---- held-down mining ----
// The left mouse button is held, not clicked: one press breaks the block
// under the crosshair, then the next, and the next, until it is released -
// which is what breaking anything thicker than dirt actually needs.
//
// `miningHeld` is the button state and nothing else touches it; the loop and
// the target watcher below both read it and wind themselves down when it
// goes false, so releasing the button can never leave a dig running.
let miningHeld = false
let miningLoop = null
let digTargetWatch = null

// How often to check whether the crosshair has moved off the block being
// dug. Fast enough not to be noticed, slow enough to be free.
const DIG_TARGET_WATCH_MS = 100

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Every player username ever seen online during this connection's
// lifetime (username -> {firstSeenAt, lastSeenAt}) - unlike bot.players
// (who's online *right now*), this only grows, so "users who were
// connected while the bot was running" survives players leaving. One
// child process = one connection, so this naturally resets on every
// (re)start along with everything else here - no explicit reset needed.
const seenPlayers = new Map()

function recordSeenPlayer(username) {
  const now = Date.now()
  const existing = seenPlayers.get(username)
  if (existing) existing.lastSeenAt = now
  else seenPlayers.set(username, { firstSeenAt: now, lastSeenAt: now })
  send({ type: 'seenPlayers', data: Array.from(seenPlayers, ([user, times]) => ({ username: user, ...times })) })
}

// prismarine-windows' Window.dragClick() (mode 5 - the multi-slot "paint"
// drag used to spread a stack across several slots) is genuinely
// unimplemented upstream - it unconditionally asserts/throws, and a strict
// button-value assert in acceptClick() itself rejects the drag-start button
// before dragClick even runs. Rather than not offering real drag-and-drop at
// all, this skips *only* mode-5's client-side prediction/validation and
// lets the click still go out over the wire via bot.clickWindow() (which
// still handles packet shape/versioning/etc. correctly) - the visual result
// then comes from the server's own authoritative set_slot/window_items
// packets, which mineflayer already turns into the same 'updateSlot' events
// everything else here relies on, not from local prediction. Patched once
// per window object (bot.inventory persists; each opened container is a
// new object).
function patchWindowForDrag(window) {
  if (!window || window.__dragPatchApplied) return
  window.__dragPatchApplied = true
  const originalAcceptClick = window.acceptClick.bind(window)
  window.acceptClick = (click, gamemode) => {
    if (click.mode === 5) return []
    return originalAcceptClick(click, gamemode)
  }
}

// Strictly serializes bot.clickWindow() calls - a multi-slot drag gesture
// (start -> add -> add -> ... -> end) is inherently order-dependent, and
// clicks arrive here as independent, unawaited socket commands, so without
// this a fast drag could execute its steps out of order.
function queueClickWindow(slot, mouseButton, mode) {
  clickQueue = clickQueue
    .then(() => bot?.clickWindow(slot, mouseButton, mode))
    .catch((err) => emit('actionError', { action: 'clickWindow', message: err.message }))
  return clickQueue
}

function send(message) {
  try {
    if (process.connected) process.send(message)
  } catch {
    // parent already gone - nothing to do, the process will exit shortly
  }
}

function emit(event, data) {
  send({ type: 'emit', event, data })
}

// ---- module-facing event bus ----
// Loaded modules get real mineflayer event names/arguments here, completely
// separate from emit() above (which relays a curated, renamed set of events
// to the parent process for the web UI - e.g. mineflayer's 'move' becomes a
// differently-shaped 'position' event there). Previously modules were wired
// into that same UI channel, so api.on('move', ...) (and most other real
// mineflayer event names) never fired since the UI channel never emits an
// event actually called 'move'. This is a deliberately finite allowlist of
// commonly useful bot events - a facade, not a firehose of every event
// mineflayer fires - forwarded with their real listener arguments intact
// (see moduleSandbox.js's forwardEvent() / sandboxWorker.js's `on()`).
const MODULE_EVENTS = [
  'spawn', 'respawn', 'move', 'forcedMove', 'health', 'death', 'kicked', 'end', 'error',
  'chat', 'message', 'whisper', 'title', 'actionBar',
  'playerJoined', 'playerLeft', 'playerUpdated',
  'entitySpawn', 'entityGone', 'entityMoved',
  'rain', 'weatherUpdate', 'time', 'sunrise', 'sunset', 'noon', 'midnight',
  'windowOpen', 'windowClose',
]

// Username modules see on a chat line that came from the panel's chat box
// rather than from the server (see handleCommand's 'chat' case). Not a legal
// Minecraft name, so it can never collide with a real player.
const PANEL_SENDER = '@panel'

// ---- module command registry ----
// What each loaded module says it answers to (moduleId -> {moduleId,
// moduleName, commands}), collected from the module's own `commands` export
// and sanitised in sandboxWorker.js. Two things read it: the panel, which
// builds the chat box's completion list from it, and isModuleCommand()
// below, which is what lets a "/" line be handled by a module instead of
// being passed on to the server.
const moduleCommands = new Map()

function sendModuleCommands() {
  send({ type: 'moduleCommands', data: Array.from(moduleCommands.values()) })
}

function forgetModuleCommands(moduleId) {
  if (moduleCommands.delete(moduleId)) sendModuleCommands()
}

// True when this line is a command some loaded module has claimed. Only the
// first word matters - whatever follows is the module's business.
function isModuleCommand(text) {
  const match = /^\/([A-Za-z0-9_-]+)/.exec(text)
  if (!match) return false
  const name = match[1].toLowerCase()
  for (const entry of moduleCommands.values()) {
    for (const command of entry.commands) {
      if (command.name === name || command.aliases.includes(name)) return true
    }
  }
  return false
}

function forwardToModules(event, args) {
  if (!sandboxes.size) return
  for (const sandbox of sandboxes.values()) sandbox.forwardEvent(event, args)
}

// Wires the real bot events above straight through to any loaded module
// sandboxes - called once per connection, right after the bot is created.
function registerModuleEventBridge() {
  for (const event of MODULE_EVENTS) {
    bot.on(event, (...args) => forwardToModules(event, args))
  }
}

function log(level, message, source, moduleId) {
  send({ type: 'log', level, message, source, moduleId })
}

// ---- 3D viewer, started on demand ----
// Set once a client has asked for the viewer on this connection; survives so
// that a viewer requested before spawn still comes up once the bot is in the
// world, and so a reconnect doesn't silently drop it.
let viewerRequested = false
let viewerStarted = false
// The port the viewer ended up on, kept so an already-running viewer can
// re-announce itself to a client that subscribed after it started. Named
// apart from setStatus's own viewerPort parameter, which shadows it.
let viewerHttpPort = null
// Set from the parent's start message: the URL path the panel serves this
// viewer under, e.g. "/viewer/<profileId>/<serverId>".
let viewerBasePath = ''

// Idempotent: safe to call before spawn (defers), twice, or after the viewer
// is already up.
function startViewer() {
  viewerRequested = true
  if (viewerStarted) {
    // Already running. The status carrying the port went out when it
    // started, which a client that has only just opened the view never saw -
    // so say it again rather than leaving them waiting for an event that
    // has already been and gone.
    if (viewerHttpPort) setStatus('online', null, viewerHttpPort)
    return
  }
  if (!bot || !bot.entity) return
  viewerStarted = true
  ;(async () => {
    try {
      const port = await findFreePort()
      // The prefix has to match the path the panel proxies this viewer
      // under, and not by coincidence: prismarine-viewer serves its assets
      // from `prefix + '/'` and its socket.io from `prefix + '/socket.io'`,
      // while its browser bundle connects to
      // `window.location.pathname + 'socket.io'`. Those only agree when the
      // page's own path is the prefix - which is exactly what the /viewer
      // mount in server.js arranges. Without it the viewer's socket would
      // reach for the panel's own /socket.io and get the wrong server.
      mineflayerViewer(bot, { port, prefix: viewerBasePath, firstPerson: config.viewFirstPerson })
      viewerHttpPort = port
      setStatus('online', null, port)
      log('info', `3D viewer started on port ${port}${viewerBasePath ? `, served at ${viewerBasePath}/` : ''}.`)
    } catch (err) {
      viewerStarted = false
      viewerHttpPort = null
      const message = `3D viewer failed to start: ${describeError(err)}`
      emit('chat', { username: null, message, kind: 'system', time: Date.now() })
      log('warn', message)
    }
  })()
}

function setStatus(status, lastError, viewerPort) {
  send({ type: 'status', status, lastError: lastError ?? null, viewerPort: viewerPort ?? null })
}

async function handleStart({ profile, server, proxy, viewerPrefix }) {
  // The path the panel will proxy this connection's 3D viewer under - see
  // startViewer, and the /viewer mount in server.js.
  if (typeof viewerPrefix === 'string') viewerBasePath = viewerPrefix
  log('info', `Bot process started (pid ${process.pid}).`, 'lifecycle')
  setStatus('connecting', null, null)
  log('info', `Connecting to server ${server.host}:${server.port}${proxy ? ` via proxy "${proxy.name}"` : ''}...`, 'lifecycle')

  const pinnedVersion = profile.mcVersion || server.version || null
  versionWasPinned = !!pinnedVersion

  const options = {
    host: server.host,
    port: server.port,
    username: profile.mcUsername,
    auth: profile.mcAuth,
    version: pinnedVersion || false,
    // Microsoft auth's device-code flow otherwise just prints to this
    // process's console (invisible from the web UI) and blocks until
    // someone visits the link - surface it as a first-class prompt instead.
    onMsaCode: (data) => {
      log('info', data.message)
      send({ type: 'authPrompt', code: data.user_code, url: data.verification_uri, message: data.message })
    },
  }
  if (proxy) options.connect = buildConnectOption(proxy, server.host, server.port)

  try {
    bot = mineflayer.createBot(options)
  } catch (err) {
    const message = describeError(err)
    setStatus('error', message, null)
    log('error', message)
    process.exit(0)
    return
  }
  log('info', 'Mineflayer client created.', 'lifecycle')

  bot.loadPlugin(pathfinder)
  registerBotEvents()
  registerModuleEventBridge()
}

// What's floating on the cursor mid drag-and-drop (bot.inventory.selectedItem
// once a container is involved, bot.currentWindow's when one's open) - not
// tracked anywhere before this, since nothing needed it until real vanilla
// click/drag semantics did.
function emitCursorItem() {
  if (!bot) return
  const window = bot.currentWindow || bot.inventory
  emit('cursorItem', serializeItem(window.selectedItem))
}

function registerBotEvents() {
  const emitInventory = () => {
    emit('inventory', serializeInventory(bot))
    emitCursorItem()
  }
  const emitHealth = () => emit('health', { health: bot.health ?? 20, food: bot.food ?? 20, saturation: bot.foodSaturation ?? 0 })
  const emitPosition = () => {
    if (!bot.entity) return
    emit('position', {
      position: bot.entity.position,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      onGround: bot.entity.onGround,
    })
  }
  // A player's displayName is what the server actually renders in the tab
  // list - team colours, prefixes, and rank tags all live there as legacy "§"
  // codes. Sent as both stripped text and pre-rendered HTML (see
  // src/itemData.js's nameFields), so the client can colour the player list
  // the same way the server does.
  const emitPlayers = () => emit('players', Object.values(bot.players).map((p) => {
    let raw = null
    try {
      raw = typeof p.displayName?.toString === 'function' ? p.displayName.toString() : null
    } catch {
      // A malformed display name must never take down the player list.
    }
    const display = nameFields(raw)
    return {
      username: p.username,
      displayName: display.text && display.text !== p.username ? display.text : null,
      displayNameHtml: display.html,
      ping: p.ping,
      gamemode: p.gamemode,
    }
  }))
  // Players already on the server when the bot spawns only get a
  // playerJoined event for future (re)joins, not for themselves - without
  // this, anyone already online at connect time would never enter
  // seenPlayers until they happened to leave and rejoin.
  const recordCurrentPlayers = () => { for (const p of Object.values(bot.players)) recordSeenPlayer(p.username) }

  bot.once('spawn', async () => {
    setStatus('online', null, null)
    send({ type: 'authPrompt', clear: true })
    log('info', `Connected to server as ${bot.username} (${bot.version}).`, 'lifecycle')
    patchWindowForDrag(bot.inventory)
    emit('spawn', { username: bot.username, version: bot.version })
    emitHealth()
    emitInventory()
    emitPosition()
    emitPlayers()
    recordCurrentPlayers()
    bot.inventory.on('updateSlot', emitInventory)
    // updateSlot only fires when a slot's *contents* change - pressing a
    // hotbar number key (or anything else that shifts which slot is held)
    // changes bot.quickBarSlot without touching any slot contents, so it
    // needs its own listener or the client's held-item highlight never
    // moves off slot 0.
    bot.on('heldItemChanged', emitInventory)

    // The 3D viewer is NOT started here. prismarine-viewer spins up its own
    // HTTP server and streams the whole world to it, which is by far the most
    // expensive thing a bot connection does - and most connections are never
    // watched. It's started on demand instead, the first time a client
    // actually opens the viewer (see startViewer / the 'requestViewer'
    // message from the parent).
    if (viewerRequested) startViewer()

    try {
      const mcData = minecraftData(bot.version)
      bot.pathfinderMovements = new Movements(bot, mcData)
      bot.pathfinder.setMovements(bot.pathfinderMovements)
    } catch {
      // pathfinder is a bonus feature - safe to skip if minecraft-data has no entry for this version
    }
  })

  bot.on('health', () => {
    emitHealth()
    if (bot.health === 0) {
      // mineflayer cancels the dig itself on death; the held button has to
      // be released too, or the loop starts digging again on respawn.
      stopMining()
      emit('death', {})
    }
  })
  bot.on('move', emitPosition)
  bot.on('playerJoined', (player) => { recordSeenPlayer(player.username); emitPlayers() })
  bot.on('playerUpdated', (player) => { recordSeenPlayer(player.username); emitPlayers() })
  // The player argument here is still the one that just left (mineflayer
  // passes the removed Player object, even though it's already gone from
  // bot.players by the time this fires) - recording it here is what makes
  // seenPlayers a "who was ever online" history instead of "who's online
  // right now" (which playerLeft would otherwise make you lose track of).
  bot.on('playerLeft', (player) => { recordSeenPlayer(player.username); emitPlayers() })

  // A single source of truth for every message the bot receives (chat,
  // system, game_info, whispers - whispers just arrive as chat-position
  // messages the server already formats distinctly). toHTML() renders
  // Minecraft's color/bold/italic/underline/strikethrough formatting as
  // pre-escaped <span style="..."> markup, safe to insert directly.
  bot.on('message', (jsonMsg, position) => {
    const kind = position === 'chat' ? 'chat' : position === 'game_info' ? 'game_info' : 'system'

    // Plain text with the formatting resolved away - used for exports and as
    // the fallback when there's no markup to render.
    let text = ''
    try {
      text = jsonMsg.toString()
    } catch {
      text = ''
    }

    // toMotd() is the only view that reliably exposes colour as legacy "§"
    // codes, and it does so for BOTH shapes a server can send:
    //
    //   - a legacy component, e.g. { text: "§d§lname" }, where toString()
    //     silently strips the codes and toHTML() emits them as visible
    //     literal text - so neither one ever produced colour;
    //   - a modern component with color/bold fields, which toMotd() renders
    //     down to the equivalent § codes.
    //
    // Rendering from toMotd() therefore covers both uniformly. Messages with
    // no formatting at all come back without codes and fall through to
    // toHTML(), which handles nested translate components correctly.
    let motd = null
    try {
      motd = typeof jsonMsg.toMotd === 'function' ? jsonMsg.toMotd() : null
    } catch {
      motd = null
    }

    let html = null
    if (McFormat.hasCodes(motd)) {
      html = McFormat.toHtml(motd)
      // Keep the plain text consistent with what was just rendered, and
      // cover the case where toString() mangled a bare legacy string.
      if (!text || McFormat.hasCodes(text)) text = McFormat.strip(motd)
    } else {
      try {
        html = jsonMsg.toHTML()
      } catch {
        // No markup - the client falls back to the plain text below.
      }
    }

    emit('chat', { username: null, message: text, html, kind, time: Date.now() })
  })

  bot.on('death', () => emit('death', {}))

  // Fires for ANY window the bot begins using - a chest it opened itself,
  // or one the server/a plugin forces open on it - so the client always
  // gets a window automatically, regardless of who triggered it.
  bot.on('windowOpen', (window) => {
    // The panel releases the pointer to show the container, so the button is
    // no longer held even though no mouseup was ever seen for it.
    stopMining()
    patchWindowForDrag(window)
    emit('windowOpen', serializeWindow(window))
    emitCursorItem()
    window.on('updateSlot', () => {
      emit('windowUpdate', serializeWindow(window))
      emitCursorItem()
    })
  })

  bot.on('windowClose', () => {
    emit('windowClose', {})
    emitCursorItem()
  })

  bot.on('kicked', (reason) => {
    const message = `Kicked from server: ${reason}`
    setStatus('error', message, null)
    send({ type: 'authPrompt', clear: true })
    emit('chat', { username: null, message, kind: 'system', time: Date.now() })
    log('error', message)
  })

  bot.on('end', (reason) => {
    try {
      stopMining()
      bot.viewer?.close()
    } catch {
      // already closed
    }
    for (const sandbox of sandboxes.values()) {
      sandbox.unload().catch(() => {})
    }
    sandboxes.clear()
    // Nothing is loaded any more, so nothing answers to a command - the
    // panel's completion list has to empty with them.
    moduleCommands.clear()
    sendModuleCommands()
    setStatus('offline', null, null)
    send({ type: 'authPrompt', clear: true })
    log('info', `Disconnected: ${String(reason)}`)
    emit('disconnected', { reason: String(reason) })
    // One child process per connection - once the bot is done, so is this
    // process. The parent forks a fresh one on the next start().
    process.exit(0)
  })

  bot.on('error', (err) => {
    const message = describeError(err)
    setStatus('error', message, null)
    send({ type: 'authPrompt', clear: true })
    emit('botError', { message })
    log('error', message)
  })
}

// Modules run inside their own worker_thread sandbox (see moduleSandbox.js
// and sandboxWorker.js) - a require() allowlist keeps them from importing
// anything the admin hasn't approved, and they get a mediated bot proxy
// instead of the live bot object. This is real crash/memory isolation and
// enforced import control, not a hard V8 security boundary (worker_threads
// still share this process) - admin source review is still the actual
// trust gate, same as before.
async function handleLoadModule({ reqId, moduleRecord, allowlist }) {
  if (!bot) {
    send({ type: 'loadModuleResult', reqId, ok: false, error: 'Bot is not running.' })
    return
  }
  if (sandboxes.has(moduleRecord.id)) {
    send({ type: 'loadModuleResult', reqId, ok: false, error: 'Module is already loaded on this bot.' })
    return
  }

  const sandbox = new ModuleSandbox({
    bot,
    moduleRecord,
    allowlist: allowlist || [],
    onLog: (level, message) => log(level, message, `module:${moduleRecord.name}`, moduleRecord.id),
  })
  sandbox.onApiLog = (message) => emit('chat', {
    username: null,
    message: `[${moduleRecord.name}] ${message}`,
    kind: 'system',
    time: Date.now(),
  })

  // A module that dies after loading (uncaught throw, worker exit, OOM) used
  // to vanish silently: the sandbox was gone but nothing recorded why, and
  // the module stayed listed as loaded. Both are fixed here - the failure is
  // logged as a module error, and the entry is dropped so the UI stops
  // claiming it's running.
  // Whatever this module says it answers to, forwarded on to the panel so
  // the chat box can complete it.
  sandbox.onCommands = (commands) => {
    if (!commands || commands.length === 0) return
    moduleCommands.set(moduleRecord.id, {
      moduleId: moduleRecord.id,
      moduleName: moduleRecord.name,
      commands,
    })
    sendModuleCommands()
  }

  sandbox.onExit = (code) => {
    if (!sandboxes.has(moduleRecord.id)) return
    sandboxes.delete(moduleRecord.id)
    forgetModuleCommands(moduleRecord.id)
    const message = `Module "${moduleRecord.name}" stopped unexpectedly (worker exited with code ${code}).`
    log('error', message, `module:${moduleRecord.name}`, moduleRecord.id)
    emit('chat', { username: null, message, kind: 'system', time: Date.now() })
    send({ type: 'moduleStopped', moduleId: moduleRecord.id, name: moduleRecord.name })
  }

  try {
    const result = await sandbox.load()
    if (!result.ok) {
      // Load failures are real module errors and belong in the error log,
      // not just in the HTTP response the uploader may never see again.
      log('error', `Failed to load: ${result.error}`, `module:${moduleRecord.name}`, moduleRecord.id)
      sandbox.terminate()
      // A module can declare its commands and then fail in onLoad - it is
      // not running, so it must not be listed as answering to anything.
      forgetModuleCommands(moduleRecord.id)
      send({ type: 'loadModuleResult', reqId, ok: false, error: result.error })
      return
    }
    sandboxes.set(moduleRecord.id, sandbox)
    send({ type: 'loadModuleResult', reqId, ok: true })
  } catch (err) {
    log('error', `Failed to load: ${describeError(err)}`, `module:${moduleRecord.name}`, moduleRecord.id)
    sandbox.terminate()
    forgetModuleCommands(moduleRecord.id)
    send({ type: 'loadModuleResult', reqId, ok: false, error: describeError(err) })
  }
}

async function handleUnloadModule({ reqId, moduleId }) {
  const sandbox = sandboxes.get(moduleId)
  if (!sandbox) {
    send({ type: 'unloadModuleResult', reqId, ok: true })
    return
  }
  await sandbox.unload().catch(() => {})
  sandboxes.delete(moduleId)
  forgetModuleCommands(moduleId)
  send({ type: 'unloadModuleResult', reqId, ok: true })
}

// Points the bot exactly where the client says it is aiming, before anything
// raycasts from it.
//
// The panel streams look updates on a 50ms timer, so at the moment a click
// arrives the bot's head can be up to a frame behind the crosshair the user
// clicked with - and blockAtCursor casts from the bot's head, not from the
// crosshair. On a fast flick that is a different block. Clicks carry the
// aim they were made with so the ray starts from the right place.
async function aimAt(payload) {
  if (!payload || typeof payload !== 'object') return
  const { yaw, pitch } = payload
  if (typeof yaw !== 'number' || typeof pitch !== 'number') return
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
  const clampedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
  await bot.look(yaw, clampedPitch, true)
}

// Cancels the dig in progress once the crosshair leaves the block it is on,
// so the loop below can start on whatever is there now. Without this, aiming
// somewhere else mid-dig keeps chewing through the old block - vanilla
// switches immediately, and so does this.
function watchDigTarget() {
  if (!bot || !bot.targetDigBlock) return
  const target = bot.blockAtCursor(CURSOR_REACH)
  if (!target || !target.position.equals(bot.targetDigBlock.position)) bot.stopDigging()
}

async function runMiningLoop() {
  while (miningHeld && bot && bot.entity) {
    const target = bot.blockAtCursor(CURSOR_REACH)
    // Nothing in reach, or nothing breakable: keep the button "held" and
    // look again shortly, rather than ending the loop. Aiming back at a
    // block then carries straight on without another click.
    if (!target || !bot.canDigBlock(target)) {
      await sleep(80)
      continue
    }

    try {
      // 'ignore' is what stops mineflayer turning the bot's head to the
      // centre of the block before it digs. It is already looking at the
      // block - that is how the raycast found it - and re-aiming would drag
      // the view off the crosshair the user is holding.
      await bot.dig(target, 'ignore')
    } catch (err) {
      // Aborted is the normal way a dig ends here: watchDigTarget cancels it
      // when the aim moves on. Anything else is worth reporting once, after
      // a pause so a block that cannot be dug does not spin.
      if (!/aborted/i.test(err.message || '')) {
        emit('actionError', { action: 'mine', message: err.message })
        await sleep(200)
      }
    }
  }
  miningLoop = null
}

function startMining() {
  if (miningHeld || !bot) return
  miningHeld = true
  if (!digTargetWatch) digTargetWatch = setInterval(watchDigTarget, DIG_TARGET_WATCH_MS)
  if (!miningLoop) miningLoop = runMiningLoop()
}

// Safe to call at any time, and called from every path that should end a
// dig: the button coming up, the pointer being released, the page going
// away, the bot dying or disconnecting.
function stopMining() {
  miningHeld = false
  clearInterval(digTargetWatch)
  digTargetWatch = null
  try {
    bot?.stopDigging()
  } catch {
    // Not digging, or already gone.
  }
}

function handleCommand(command, payload) {
  if (!bot) return
  try {
    switch (command) {
      case 'chat': {
        if (typeof payload !== 'string') return
        const trimmed = payload.trim().slice(0, 256)
        if (trimmed.length === 0) return
        // Everything typed in the panel is offered to loaded modules: the
        // bot's own outgoing chat never comes back as a 'chat' event, and a
        // line starting with '/' is a server command rather than public
        // chat, so without this there is no way to drive a module's
        // commands from the panel at all.
        forwardToModules('chat', [PANEL_SENDER, trimmed])

        // A line a loaded module has claimed is handled by that module and
        // is deliberately NOT passed on - the server has no such command and
        // would answer "Unknown command" to every one of them. Echoing it
        // into the log is what makes it visible that something was sent,
        // since the module's own reply may take a moment.
        if (isModuleCommand(trimmed)) {
          emit('chat', { username: null, message: trimmed, kind: 'command', time: Date.now() })
          break
        }

        bot.chat(trimmed)
        break
      }
      case 'move': {
        if (!payload || typeof payload !== 'object') return
        const { control, state } = payload
        if (MOVE_CONTROLS.has(control) && typeof state === 'boolean') bot.setControlState(control, state)
        break
      }
      case 'look': {
        if (!payload || typeof payload !== 'object') return
        const { yaw, pitch } = payload
        if (typeof yaw === 'number' && typeof pitch === 'number' && Number.isFinite(yaw) && Number.isFinite(pitch)) {
          const clampedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
          bot.look(yaw, clampedPitch, true)
        }
        break
      }
      case 'selectSlot': {
        if (Number.isInteger(payload) && payload >= 0 && payload <= 8) bot.setQuickBarSlot(payload)
        break
      }
      // Left mouse button pressed. An entity under the crosshair is hit once
      // per press, the way it already was; anything else starts mining and
      // keeps mining until the button comes up.
      case 'startMining': {
        (async () => {
          await aimAt(payload)
          const entity = bot.entityAtCursor(4)
          if (entity) {
            bot.attack(entity)
            return
          }
          startMining()
        })().catch((err) => emit('actionError', { action: command, message: err.message }))
        break
      }
      case 'stopMining': {
        stopMining()
        break
      }
      // Kept for a browser still running a cached copy of the old page,
      // which clicks to dig rather than holding: one block, then stop.
      case 'leftClick': {
        (async () => {
          await aimAt(payload)
          const entity = bot.entityAtCursor(4)
          if (entity) {
            bot.attack(entity)
            return
          }
          const block = bot.blockAtCursor(CURSOR_REACH)
          if (block) await bot.dig(block, 'ignore')
        })().catch((err) => emit('actionError', { action: command, message: err.message }))
        break
      }
      case 'rightClick': {
        (async () => {
          await aimAt(payload)
          const block = bot.blockAtCursor(CURSOR_REACH)
          if (block && isContainerBlock(block.name)) {
            await bot.openContainer(block)
            return
          }
          const item = bot.heldItem
          const mcData = minecraftData(bot.version)
          const isBlockItem = item && mcData.blocksByName[item.name]
          if (isBlockItem && block) {
            // The face the ray entered through, not a guess from the block's
            // centre - this is which side of the target the new block lands
            // on (see cursorFace).
            await bot.placeBlock(block, cursorFace(bot, block))
            return
          }
          bot.activateItem(false)
        })().catch((err) => emit('actionError', { action: command, message: err.message }))
        break
      }
      case 'deactivateItem': {
        bot.deactivateItem()
        break
      }
      // Full vanilla click/drag semantics - {slot, mouseButton, mode} is
      // exactly the Minecraft protocol's window_click packet shape, computed
      // client-side (see public/js/main.js's inventory logic) and passed
      // straight through to mineflayer's own bot.clickWindow(), which
      // already handles pickup/place/swap/shift-click/drag-paint/drop/
      // number-swap/double-click correctly against bot.currentWindow if a
      // container is open, or bot.inventory otherwise. Queued (not fired
      // directly) so a fast multi-slot drag sequence - which is inherently
      // order-dependent (start, then each add, then end) - can't race
      // itself if two clicks arrive close together.
      case 'clickWindow': {
        const { slot, mouseButton, mode } = payload || {}
        if (!Number.isInteger(slot) || !Number.isInteger(mouseButton) || !Number.isInteger(mode)) break
        queueClickWindow(slot, mouseButton, mode)
        break
      }
      case 'windowClose': {
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        break
      }
      // Q pressed while not hovering any open-window slot: drop the
      // currently held hotbar item outright. Hovering a slot instead routes
      // Q through clickWindow's drop mode (4) - see main.js.
      case 'dropSlot': {
        (async () => {
          const item = bot.inventory.slots[payload]
          if (item) await bot.tossStack(item)
        })().catch((err) => emit('actionError', { action: command, message: err.message }))
        break
      }
      case 'respawn': {
        bot.respawn()
        break
      }
      case 'goto': {
        const { x, y, z } = payload || {}
        if ([x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) {
          bot.pathfinder.setGoal(new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z)))
        }
        break
      }
      case 'stopGoto': {
        bot.pathfinder.setGoal(null)
        break
      }
      default:
        break
    }
  } catch (err) {
    emit('actionError', { action: command, message: err.message })
  }
}

function handleStop() {
  if (stopping) return
  stopping = true
  log('info', 'Process killed (stopped from web UI).')
  // Report the terminal status up front, not just from the 'end' handler
  // below - if the bot is still stuck mid-authentication (e.g. waiting on
  // a Microsoft device code) there may be no active protocol connection
  // for bot.quit() to actually close, and this process will exit via the
  // safety-net timeout instead of a real 'end' event. Without this, the
  // parent would see an exit with no status ever reported and wrongly log
  // it as a crash instead of a deliberate stop. Same reasoning for clearing
  // any pending auth prompt here rather than only from the 'end' handler.
  setStatus('offline', null, null)
  send({ type: 'authPrompt', clear: true })
  if (bot) {
    try {
      bot.quit('Stopped from web UI')
    } catch {
      process.exit(0)
    }
    // Safety net - if 'end' doesn't fire promptly for some reason, don't
    // leave an orphaned process running.
    setTimeout(() => process.exit(0), 5000).unref()
  } else {
    process.exit(0)
  }
}

// Periodic self-reported resource usage, so the parent can show real
// per-bot CPU/RAM in the admin monitoring panel instead of an estimate.
setInterval(() => {
  const mem = process.memoryUsage()
  const cpu = process.cpuUsage()
  send({
    type: 'stats',
    memoryRssMB: mem.rss / (1024 * 1024),
    cpuUserMs: cpu.user / 1000,
    cpuSystemMs: cpu.system / 1000,
  })
}, 5000).unref()

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'start':
      handleStart(msg).catch((err) => {
        setStatus('error', describeError(err), null)
        log('error', describeError(err))
        process.exit(1)
      })
      break
    case 'command':
      handleCommand(msg.command, msg.payload)
      break
    // Sent when a client actually opens the 3D view for this connection -
    // see socketHandlers.js's 'requestViewer'.
    case 'requestViewer':
      startViewer()
      break
    case 'loadModule':
      handleLoadModule(msg)
      break
    case 'unloadModule':
      handleUnloadModule(msg)
      break
    case 'stop':
      handleStop()
      break
    default:
      break
  }
})

process.on('uncaughtException', (err) => {
  log('error', `Bot process crashed: ${describeError(err)}`)
  setStatus('error', describeError(err), null)
  process.exit(1)
})
