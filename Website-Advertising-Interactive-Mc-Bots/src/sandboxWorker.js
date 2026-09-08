// Runs inside a worker_thread (see moduleSandbox.js) - one worker per
// loaded marketplace module. Never receives the live mineflayer `bot`
// object; instead gets a Proxy that turns every property read/method call
// into an async message round-trip to the main thread (moduleSandbox.js),
// which is the only place with the real object. This is what makes it
// possible to enforce the require() allowlist below without also having to
// hand-audit every module for what it does with a live bot reference - the
// worker simply never has one.
const { parentPort, workerData } = require('worker_threads')
const Module = require('module')
const path = require('path')

const { filePath, allowlist } = workerData

function send(message) {
  parentPort.postMessage(message)
}

function stringifyArg(a) {
  if (typeof a === 'string') return a
  try {
    return JSON.stringify(a)
  } catch {
    return String(a)
  }
}

function log(level, ...args) {
  send({ type: 'log', level, message: args.map(stringifyArg).join(' ') })
}

// console.* is the normal way module authors already expect output to go
// somewhere - route it into this bot's unified log instead of this
// worker's own (invisible) stdout.
console.log = (...args) => log('info', ...args)
console.info = (...args) => log('info', ...args)
console.warn = (...args) => log('warn', ...args)
console.error = (...args) => log('error', ...args)
console.debug = (...args) => log('info', ...args)

// ---- require() allowlist guard ----
// Patches this worker's own module loader only - completely separate from
// the main thread's and every other worker's, so this can't affect
// anything outside this one module's sandbox.
const originalLoad = Module._load
const allowedSet = new Set(allowlist)
Module._load = function requireGuard(request, parent, isMain) {
  const isRelativeOrAbsolute = request.startsWith('.') || request.startsWith('/') || path.isAbsolute(request)
  if (isRelativeOrAbsolute) {
    // The module's own file (and anything it requires by relative/absolute
    // path, i.e. its own local file tree) isn't allowlist-checked - only
    // bare package/builtin names are, since those are what actually reach
    // outside code the admin hasn't reviewed.
    return originalLoad.apply(this, arguments)
  }
  const baseName = request.startsWith('@') ? request.split('/').slice(0, 2).join('/') : request.split('/')[0]
  if (!allowedSet.has(baseName) && !allowedSet.has(request)) {
    throw new Error(`Import "${request}" is not on the admin-approved allowlist. Ask an admin to add it on the Admin page if this module genuinely needs it.`)
  }
  return originalLoad.apply(this, arguments)
}

// ---- remote bot proxy ----
// Every property access/method call on `bot` (at any depth) becomes an
// async request resolved against the real bot object on the main thread.
// This means bot.* is always a Promise now, even for plain property reads
// (`await bot.entity.position`, not `bot.entity.position`) - the one
// unavoidable ergonomic cost of a real process/thread boundary, since
// there is no synchronous way to read a value that lives in another
// thread. Rich objects (Vec3, Block, Entity, ...) also arrive as plain
// data, not live class instances - structured cloning across the worker
// boundary can't carry prototypes/methods with it either.
let nextCallId = 1
const pending = new Map()

function remoteCall(pathArr, args) {
  return new Promise((resolve, reject) => {
    const callId = nextCallId++
    pending.set(callId, { resolve, reject })
    send({ type: 'botCall', callId, path: pathArr, args })
  })
}

function makeBotProxy(pathArr) {
  const fn = function callable(...args) {
    return remoteCall(pathArr, args)
  }
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') {
        // Being awaited/`.then()`ed directly rather than called - resolve
        // the current path as a value read.
        const promise = remoteCall(pathArr, undefined)
        return promise.then.bind(promise)
      }
      if (typeof prop === 'symbol') return undefined
      return makeBotProxy([...pathArr, prop])
    },
  })
}

const bot = makeBotProxy([])

// ---- event subscription ----
// bot.on(...) can't cross the thread boundary (listener functions aren't
// cloneable), so modules subscribe through api.on(event, fn) instead - the
// main thread only forwards events a sandbox has actually asked for.
const listeners = new Map() // event -> Set<fn>

function on(event, fn) {
  if (typeof fn !== 'function') return
  if (!listeners.has(event)) {
    listeners.set(event, new Set())
    send({ type: 'subscribeEvent', event })
  }
  listeners.get(event).add(fn)
}

function off(event, fn) {
  listeners.get(event)?.delete(fn)
}

const api = {
  log: (message) => send({ type: 'apiLog', message: String(message) }),
  on,
  off,
}

// ---- declared commands ----
// A module may export a `commands` array describing the chat commands it
// answers to. That description is the only thing the rest of the app knows
// about a module's command surface: the panel's chat box builds its
// completion list from it, and the bot uses it to tell a module command
// apart from a real server command (see botChild.js's handleCommand).
//
// It is read after onLoad, so a module can build the list at load time, and
// it is sanitised here rather than trusted: this is unreviewed code
// describing itself to a UI that will render it.
const MAX_COMMANDS = 24
const MAX_SUBCOMMANDS = 48
const MAX_ALIASES = 8
const MAX_TEXT = 200

// Control characters would break the log and the completion list alike.
function cleanText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, limit)
}

// A command name has to be typeable after a slash and matchable against what
// someone types - anything else is dropped rather than escaped.
function cleanName(value) {
  const name = cleanText(value, 32).replace(/^\/+/, '')
  return /^[a-z0-9_-]+$/i.test(name) ? name.toLowerCase() : null
}

function sanitizeSubcommand(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = cleanName(raw.name)
  if (!name) return null
  return {
    name,
    usage: cleanText(raw.usage, 120),
    description: cleanText(raw.description),
  }
}

function sanitizeCommands(raw) {
  if (!Array.isArray(raw)) return []
  const commands = []
  const claimed = new Set()

  for (const entry of raw.slice(0, MAX_COMMANDS)) {
    if (!entry || typeof entry !== 'object') continue
    const name = cleanName(entry.name)
    if (!name || claimed.has(name)) continue
    claimed.add(name)

    // Claimed as we go, not afterwards: "/advert" and "advert" clean to the
    // same alias, and both would otherwise survive the same pass.
    const aliases = (Array.isArray(entry.aliases) ? entry.aliases : [])
      .map(cleanName)
      .filter((alias) => {
        if (!alias || claimed.has(alias)) return false
        claimed.add(alias)
        return true
      })
      .slice(0, MAX_ALIASES)

    commands.push({
      name,
      aliases,
      usage: cleanText(entry.usage, 120) || `/${name}`,
      description: cleanText(entry.description),
      subcommands: (Array.isArray(entry.subcommands) ? entry.subcommands : [])
        .slice(0, MAX_SUBCOMMANDS)
        .map(sanitizeSubcommand)
        .filter(Boolean),
    })
  }

  return commands
}

let moduleExports = null

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'botCallResult': {
      const entry = pending.get(msg.callId)
      if (!entry) return
      pending.delete(msg.callId)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(new Error(msg.error))
      break
    }
    case 'botEvent': {
      const set = listeners.get(msg.event)
      if (!set) return
      const args = Array.isArray(msg.args) ? msg.args : []
      for (const fn of set) {
        try {
          fn(...args)
        } catch (err) {
          log('error', `Error in "${msg.event}" handler: ${err.message}`)
        }
      }
      break
    }
    case 'load': {
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        moduleExports = require(filePath)
        if (!moduleExports || typeof moduleExports.onLoad !== 'function') {
          throw new Error('Module must export an onLoad(bot, api) function.')
        }
        await moduleExports.onLoad(bot, api)
        // Read after onLoad, not before: a module is free to assemble its
        // command list while starting up.
        send({ type: 'commands', commands: sanitizeCommands(moduleExports.commands) })
        send({ type: 'loadResult', ok: true })
      } catch (err) {
        send({ type: 'loadResult', ok: false, error: err.message })
      }
      break
    }
    case 'unload': {
      try {
        if (moduleExports && typeof moduleExports.onUnload === 'function') {
          await moduleExports.onUnload(bot, api)
        }
        send({ type: 'unloadResult', ok: true })
      } catch (err) {
        send({ type: 'unloadResult', ok: false, error: err.message })
      } finally {
        process.exit(0)
      }
      break
    }
    default:
      break
  }
})

process.on('uncaughtException', (err) => {
  log('error', `Uncaught error: ${err.message}`)
})

process.on('unhandledRejection', (err) => {
  log('error', `Unhandled rejection: ${err && err.message ? err.message : String(err)}`)
})
