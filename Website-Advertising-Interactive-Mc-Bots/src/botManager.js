const crypto = require('crypto')
const path = require('path')
const { fork } = require('child_process')

const MAX_CHAT_LOG = 200
const MAX_BOT_LOG = 500
// How long player sightings are allowed to pile up before being written -
// see _persistSightings for why they are coalesced at all.
const SIGHTING_FLUSH_MS = 15000

// The panel path one connection's 3D viewer is served under. Both ends have
// to agree on this exactly: the child gives it to prismarine-viewer as a
// path prefix, and server.js proxies this path through to the viewer's own
// port. Exported so neither side can drift from the other.
function viewerPath(profileId, serverId) {
  return `/viewer/${encodeURIComponent(profileId)}/${encodeURIComponent(serverId)}`
}
const CHILD_PATH = path.join(__dirname, 'botChild.js')

// A bot profile is just an identity (account + auth type) - it can now run
// against several servers at once, so every connection is keyed by
// (profileId, serverId) together, not profileId alone. Each such connection
// still runs in its own forked child process (src/botChild.js) - real
// per-connection crash isolation and real per-connection CPU/RAM accounting
// (see getResourceUsage()), instead of an estimate. This class owns the
// parent side: forking/tearing down children, relaying their IPC messages
// to socket.io rooms, and mirroring just enough state (status/snapshot/log)
// to answer the same getStatus()/getSnapshot()/getLog() contract
// routes/admin.js and routes/bots.js already relied on before this was
// in-process.
class BotManager {
  constructor(io, db) {
    this.io = io
    this.db = db
    this.instances = new Map() // "profileId:serverId" -> instance
    this._pending = new Map() // reqId -> { resolve }
    this._reqCounter = 0
  }

  _key(profileId, serverId) {
    return `${profileId}:${serverId}`
  }

  room(profileId, serverId) {
    return `bot:${profileId}:${serverId}`
  }

  getStatus(profileId, serverId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst) return { status: 'offline', viewerPort: null, error: null, server: null, proxyName: null, authPrompt: null }
    return {
      status: inst.status,
      viewerPort: inst.viewerPort,
      error: inst.lastError,
      server: inst.serverHost ? { id: inst.serverId, name: inst.serverName, host: inst.serverHost, port: inst.serverPort } : null,
      proxyName: inst.proxyName || null,
      // Set while a Microsoft-auth bot is waiting on a first-time
      // device-code sign-in (see botChild.js's onMsaCode) - {code, url,
      // message} or null. Polled by the Bots page like everything else here.
      authPrompt: inst.authPrompt || null,
    }
  }

  // Every connection currently known for this profile (any status) - what
  // the Bots page renders as that profile's list of running/recent
  // connections, since a profile can now be live on more than one server.
  listConnectionsForProfile(profileId) {
    const result = []
    for (const inst of this.instances.values()) {
      if (inst.profileId !== profileId) continue
      result.push({ serverId: inst.serverId, ...this.getStatus(profileId, inst.serverId) })
    }
    return result
  }

  // Number of this user's connections currently 'connecting' or 'online',
  // across every one of their bot profiles - what routes/bots.js's
  // /:id/start checks against the tier-based concurrency limit
  // (config.botConcurrencyByStatus) before starting a new one.
  // excludeProfileId/excludeServerId let the caller not count a connection
  // that a start request would just be idempotently re-using (see
  // botManager.start()'s own early-return for an already
  // connecting/online connection).
  countActiveConnectionsForUser(userId, excludeProfileId = null, excludeServerId = null) {
    const excludeKey = excludeProfileId && excludeServerId ? this._key(excludeProfileId, excludeServerId) : null
    let count = 0
    for (const [key, inst] of this.instances) {
      if (key === excludeKey) continue
      if (inst.ownerUserId !== userId) continue
      if (inst.status === 'connecting' || inst.status === 'online') count += 1
    }
    return count
  }

  getSnapshot(profileId, serverId) {
    return this.instances.get(this._key(profileId, serverId))?.snapshot || null
  }

  // The chat commands the modules currently loaded on this connection have
  // declared, as [{moduleId, moduleName, commands}] - what the panel's chat
  // box completes against. Empty when nothing is loaded.
  getModuleCommands(profileId, serverId) {
    return this.instances.get(this._key(profileId, serverId))?.moduleCommands || []
  }

  // ---- player sighting persistence ----
  //
  // The child re-sends its whole seen-players list on every join, leave and
  // tab-list update, which on a busy server is several times a second. That
  // is the right granularity for the in-memory copy and completely the
  // wrong one for the database, so writes are coalesced: the first report
  // arms a timer, every report until it fires is absorbed, and one bulk
  // upsert of the current list goes out at the end of the window.
  //
  // Losing the last few seconds of a window to a crash costs nothing real -
  // the child re-reports everyone it can still see the moment it reconnects,
  // and the timestamps merge rather than overwrite.
  // Writes out whatever this connection has seen but not yet recorded.
  // Called before anything reads the sighting history, so a list opened
  // mid-window shows who is on the server right now rather than who was on
  // it when the last flush happened. A no-op when nothing is connected.
  async flushSightings(profileId, serverId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst) return
    if (inst.sightingTimer) {
      clearTimeout(inst.sightingTimer)
      inst.sightingTimer = null
    }
    await this._flushSightings(inst)
  }

  _persistSightings(inst) {
    if (inst.sightingTimer) return
    inst.sightingTimer = setTimeout(() => {
      inst.sightingTimer = null
      this._flushSightings(inst)
    }, SIGHTING_FLUSH_MS)
    // Must not hold the process open on shutdown; stopAll flushes anyway.
    inst.sightingTimer.unref?.()
  }

  async _flushSightings(inst) {
    const entries = inst.seenPlayers
    if (!entries || entries.length === 0) return

    const payload = entries.map((entry) => {
      const counted = inst.countedSightings.has(entry.username)
      inst.countedSightings.add(entry.username)
      return Object.assign({}, entry, { isNewThisConnection: !counted })
    })

    try {
      await this.db.recordPlayerSightings(inst.ownerUserId, inst.profileId, inst.serverId, payload)
    } catch (err) {
      // A sighting is a nice-to-have record, never a reason to disturb a
      // running connection.
      console.error('[mineflayer-web] could not record player sightings:', err.message)
    }
  }

  // The per-connection log shown on the Bots page: everything from routine
  // lifecycle events (connecting/spawned/module load-unload/disconnect
  // reason) up through real errors, in one ordered, in-memory-only stream
  // that resets every time this connection is (re)started - it is
  // intentionally NOT the same list as the admin's cross-user "Error logs"
  // card, which stays a persisted, errors-only audit trail so one chatty
  // bot can't crowd real errors for other users out of that shared
  // 2000-entry cap.
  getLog(profileId, serverId) {
    return this.instances.get(this._key(profileId, serverId))?.log || []
  }

  // Real, self-reported resource usage from this connection's own child
  // process (see botChild.js's periodic 'stats' message) - null until it's
  // been running long enough to report at least once.
  getResourceUsage(profileId, serverId) {
    return this.instances.get(this._key(profileId, serverId))?.resourceUsage || null
  }

  // One entry per currently-running connection, for the admin
  // server-monitoring panel's per-bot averages - real numbers (each
  // connection's own child process self-reports via
  // process.cpuUsage()/memoryUsage()), not an estimate.
  getAllResourceUsage() {
    const result = []
    for (const inst of this.instances.values()) {
      if (inst.status === 'offline' || !inst.resourceUsage) continue
      result.push({ profileId: inst.profileId, serverId: inst.serverId, ...inst.resourceUsage })
    }
    return result
  }

  // level: 'info' | 'warn' | 'error'. source identifies where the line came
  // from - 'connection' (default) for the bot/server lifecycle itself, or
  // 'module:<name>' for a loaded module's own output/errors (moduleId set
  // alongside it so the module error tab - see routes/bots.js's /errors -
  // can filter to one exact module rather than matching on its name).
  _log(inst, ownerUserId, level, message, source = 'connection', moduleId = null) {
    if (inst) {
      if (!inst.log) inst.log = []
      inst.log.push({ id: crypto.randomUUID(), level, message, source, moduleId, createdAt: Date.now() })
      if (inst.log.length > MAX_BOT_LOG) inst.log.shift()
    }
    if (level === 'error') {
      try {
        // Fire-and-forget: logging must never itself take down a bot
        // connection, and addErrorLog() is async (Mongo-backed) so a
        // rejected promise needs its own catch, not just a try/catch
        // around the call. Only real errors go here - see the comment on
        // getLog() above for why routine lifecycle chatter doesn't.
        this.db?.addErrorLog({ level, message, userId: ownerUserId, botProfileId: inst?.profileId || null })?.catch(() => {})
      } catch {
        // synchronous throw from a misbehaving db shim, still ignored
      }
    }
  }

  _pushChat(inst, line) {
    if (!inst) return
    inst.snapshot.chatLog.push(line)
    if (inst.snapshot.chatLog.length > MAX_CHAT_LOG) inst.snapshot.chatLog.shift()
    this.io.to(this.room(inst.profileId, inst.serverId)).emit('chat', line)
  }

  _emitStatus(inst) {
    this.io.to(this.room(inst.profileId, inst.serverId)).emit('status', this.getStatus(inst.profileId, inst.serverId))
  }

  async start(profile, server, proxy) {
    const key = this._key(profile.id, server.id)
    const existing = this.instances.get(key)
    if (existing && (existing.status === 'online' || existing.status === 'connecting')) {
      return this.getStatus(profile.id, server.id)
    }
    if (existing?.child) {
      // Stale child from a previous run that somehow never finished exiting.
      try { existing.child.kill() } catch { /* already gone */ }
    }

    const inst = {
      profileId: profile.id,
      serverId: server.id,
      ownerUserId: profile.userId,
      status: 'connecting',
      lastError: null,
      child: null,
      terminalReported: false,
      viewerPort: null,
      serverName: server.name,
      serverHost: server.host,
      serverPort: server.port,
      proxyName: proxy ? proxy.name : null,
      loadedModules: new Map(),
      snapshot: { health: null, inventory: null, position: null, players: [], chatLog: [], window: null, cursorItem: null },
      // The per-connection log resets on every (re)start, by design - see getLog().
      log: [],
      resourceUsage: null,
      authPrompt: null,
      // Every player username seen online during this connection (see
      // botChild.js's seenPlayers) - also resets on every (re)start. The
      // durable history lives in the database (db.recordPlayerSightings),
      // which this feeds.
      seenPlayers: [],
      // What each loaded module says it answers to, for the chat box's
      // command completion - see botChild.js's moduleCommands.
      moduleCommands: [],
      // Sighting persistence: the pending flush, and who has already been
      // counted as "seen during this connection" so the per-player
      // connection tally doesn't climb on every flush.
      sightingTimer: null,
      countedSightings: new Set(),
    }
    this.instances.set(key, inst)
    this._emitStatus(inst)

    const child = fork(CHILD_PATH, [], {
      // Strip debugger flags so forking many children doesn't collide on
      // the same --inspect port when the parent itself is being debugged.
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    inst.child = child
    child.on('message', (msg) => this._handleChildMessage(key, msg))
    child.on('exit', (code) => this._handleChildExit(key, code))
    child.on('error', (err) => {
      this._log(inst, profile.userId, 'error', `Bot process error: ${err.message}`)
    })

    child.send({
      type: 'start',
      profile: { mcUsername: profile.mcUsername, mcAuth: profile.mcAuth, mcVersion: profile.mcVersion },
      server: { name: server.name, host: server.host, port: server.port, version: server.version },
      proxy: proxy
        ? { name: proxy.name, type: proxy.type, host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password }
        : null,
      // Where the panel will serve this connection's 3D viewer from. The
      // child hands it to prismarine-viewer as its path prefix so the
      // proxied page, its assets and its socket all agree on one path -
      // see startViewer in botChild.js and the /viewer mount in server.js.
      viewerPrefix: viewerPath(profile.id, server.id),
    })

    return this.getStatus(profile.id, server.id)
  }

  async stop(profileId, serverId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst || !inst.child) return this.getStatus(profileId, serverId)
    try {
      inst.child.send({ type: 'stop' })
    } catch {
      // already gone
    }
    return this.getStatus(profileId, serverId)
  }

  async removeConnection(profileId, serverId) {
    const key = this._key(profileId, serverId)
    const inst = this.instances.get(key)
    if (inst?.child) {
      const child = inst.child
      try { child.send({ type: 'stop' }) } catch { /* already gone */ }
      setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 5000).unref()
    }
    this.instances.delete(key)
  }

  // Stops every live connection whose owner isn't exempt - used when an
  // admin switches maintenance mode on (see routes/admin.js). Staff bots
  // (admin/developer, see src/roles.js) are deliberately left running so
  // whoever is doing the maintenance can keep testing against a live bot.
  // Returns the number of connections stopped.
  async stopAllExceptUsers(exemptUserIds) {
    const exempt = new Set(exemptUserIds)
    const toStop = []
    for (const inst of this.instances.values()) {
      if (exempt.has(inst.ownerUserId)) continue
      if (inst.status !== 'online' && inst.status !== 'connecting') continue
      toStop.push(inst)
    }
    for (const inst of toStop) {
      this._log(inst, inst.ownerUserId, 'warn', 'Stopped: the site was put into maintenance mode.')
    }
    await Promise.all(toStop.map((inst) => this.stop(inst.profileId, inst.serverId)))
    return toStop.length
  }

  // Unloads a module from every connection running it, across every user.
  // Used when an admin pauses or removes a module: blocking new loads isn't
  // enough on its own, because a module that's already running keeps running
  // - which is exactly the situation a pause is meant to stop. Returns the
  // owners of the bots it was pulled from, so they can be told why.
  async unloadModuleEverywhere(moduleId) {
    const affected = []
    for (const inst of [...this.instances.values()]) {
      if (!inst.loadedModules?.has(moduleId)) continue
      affected.push({ ownerUserId: inst.ownerUserId, profileId: inst.profileId, serverId: inst.serverId })
      this._log(inst, inst.ownerUserId, 'warn',
        `Module "${inst.loadedModules.get(moduleId).name}" was unloaded: an admin paused it.`,
        `module:${inst.loadedModules.get(moduleId).name}`)
      await this.unloadModule(inst.profileId, inst.serverId, moduleId)
    }
    return affected
  }

  // Forgets this profile's connections that have cleanly finished, so
  // starting it on a different server doesn't leave the previous one behind
  // as a stale "offline" row. Connections that ended in an error are kept -
  // their status and logs are exactly what you'd want to look at - as is the
  // one being (re)started, passed in as keepServerId.
  pruneIdleConnections(profileId, keepServerId = null) {
    let removed = 0
    for (const [key, inst] of [...this.instances]) {
      if (inst.profileId !== profileId) continue
      if (inst.serverId === keepServerId) continue
      if (inst.status !== 'offline') continue
      if (inst.child) continue
      this.instances.delete(key)
      removed += 1
    }
    return removed
  }

  // Stops and forgets every connection for a profile - used when the whole
  // bot profile is deleted, since it may be live on more than one server.
  async removeAllForProfile(profileId) {
    const toRemove = []
    for (const inst of this.instances.values()) {
      if (inst.profileId === profileId) toRemove.push(inst.serverId)
    }
    await Promise.all(toRemove.map((serverId) => this.removeConnection(profileId, serverId)))
  }

  // Stops every running connection and waits (up to timeoutMs each) for
  // their child processes to actually exit, force-killing any that don't -
  // used on server shutdown so bot connections don't linger as orphaned
  // processes after the main server exits.
  async stopAll(timeoutMs = 5000) {
    const waits = []
    for (const inst of this.instances.values()) {
      if (!inst.child) continue
      const child = inst.child
      waits.push(new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          resolve()
        }
        child.once('exit', finish)
        try {
          child.send({ type: 'stop' })
        } catch {
          finish()
          return
        }
        setTimeout(() => {
          if (done) return
          try { child.kill() } catch { /* already gone */ }
          finish()
        }, timeoutMs).unref()
      }))
    }
    await Promise.all(waits)
    // Each exit above queues a final sighting write. Those are fire-and-
    // forget during normal running, but this is called on the way to
    // process.exit() and closeMongo() - so they are awaited here, or the
    // last window of every connection is lost on every shutdown.
    await Promise.all([...this.instances.values()].map((inst) => this._flushSightings(inst)))
  }

  sendCommand(profileId, serverId, command, payload) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst?.child) return
    try {
      inst.child.send({ type: 'command', command, payload })
    } catch {
      // child gone - nothing to do
    }
  }

  // Asks this connection's child process to bring up its prismarine-viewer.
  // Nothing starts one otherwise (see botChild.js's startViewer) - it's the
  // single most expensive thing a connection does, and most connections are
  // never watched.
  requestViewer(profileId, serverId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst?.child) return
    inst.viewerRequested = true
    try {
      inst.child.send({ type: 'requestViewer' })
    } catch {
      // child gone - nothing to do
    }
  }

  _nextReqId() {
    this._reqCounter += 1
    return this._reqCounter
  }

  _childRequest(inst, message, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = message.reqId
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        reject(new Error('Bot process did not respond in time.'))
      }, timeoutMs)
      this._pending.set(reqId, { resolve: (v) => { clearTimeout(timer); resolve(v) } })
      try {
        inst.child.send(message)
      } catch (err) {
        clearTimeout(timer)
        this._pending.delete(reqId)
        reject(err)
      }
    })
  }

  // Sends the module's file (and the current admin-controlled import
  // allowlist) over to the child, which loads it into its own
  // worker_thread sandbox - see botChild.js/moduleSandbox.js/
  // sandboxWorker.js. Real crash/memory isolation and enforced import
  // control; still not a hard security boundary, so admin source review
  // before approving a module still matters.
  async loadModule(profileId, serverId, moduleRecord) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst || !inst.child) throw new Error('Bot is not running.')
    if (!inst.loadedModules) inst.loadedModules = new Map()
    if (inst.loadedModules.has(moduleRecord.id)) throw new Error('Module is already loaded on this bot.')

    const allowlist = (await this.db.listImportWhitelist()).map((e) => e.name)
    const reqId = this._nextReqId()
    const result = await this._childRequest(inst, {
      type: 'loadModule',
      reqId,
      moduleRecord: { id: moduleRecord.id, name: moduleRecord.name, filePath: moduleRecord.filePath },
      allowlist,
    })
    if (!result.ok) throw new Error(result.error || 'Failed to load module.')
    inst.loadedModules.set(moduleRecord.id, { name: moduleRecord.name })
    this._pushChat(inst, { username: null, message: `Module "${moduleRecord.name}" loaded.`, kind: 'system', time: Date.now() })
    this._log(inst, inst.ownerUserId, 'info', `Module "${moduleRecord.name}" loaded.`, `module:${moduleRecord.name}`)
  }

  async unloadModule(profileId, serverId, moduleId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    const entry = inst?.loadedModules?.get(moduleId)
    if (!entry) return
    if (inst.child) {
      const reqId = this._nextReqId()
      try {
        await this._childRequest(inst, { type: 'unloadModule', reqId, moduleId })
      } catch {
        // best-effort, same as the pre-child-process behavior
      }
    }
    inst.loadedModules.delete(moduleId)
    this._pushChat(inst, { username: null, message: `Module "${entry.name}" unloaded.`, kind: 'system', time: Date.now() })
    this._log(inst, inst.ownerUserId, 'info', `Module "${entry.name}" unloaded.`, `module:${entry.name}`)
  }

  listLoadedModules(profileId, serverId) {
    const inst = this.instances.get(this._key(profileId, serverId))
    if (!inst?.loadedModules) return []
    return Array.from(inst.loadedModules.entries()).map(([id, entry]) => ({ id, name: entry.name }))
  }

  _handleChildMessage(key, msg) {
    const inst = this.instances.get(key)
    if (!inst || !msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'status': {
        inst.status = msg.status
        if (msg.status === 'connecting') {
          inst.lastError = null
          inst.viewerPort = null
        } else if (msg.lastError !== null && msg.lastError !== undefined) {
          inst.lastError = msg.lastError
        }
        if (msg.viewerPort !== null && msg.viewerPort !== undefined) inst.viewerPort = msg.viewerPort
        if (msg.status === 'offline' || msg.status === 'error') inst.terminalReported = true
        this._emitStatus(inst)
        break
      }
      case 'emit': {
        this._relayEvent(inst, msg.event, msg.data)
        break
      }
      case 'log': {
        this._log(inst, inst.ownerUserId, msg.level, msg.message, msg.source || 'connection', msg.moduleId || null)
        break
      }
      case 'stats': {
        // process.cpuUsage() (what botChild.js reports) is cumulative
        // since that process started, not a point-in-time reading - a
        // usable percentage needs the delta against the previous sample
        // over the wall-clock time that passed between them.
        const prev = inst.resourceUsage
        const now = Date.now()
        let cpuPercent = prev ? 0 : null
        if (prev) {
          const deltaCpuMs = (msg.cpuUserMs + msg.cpuSystemMs) - (prev.cpuUserMs + prev.cpuSystemMs)
          const deltaWallMs = now - prev.at
          if (deltaWallMs > 0) cpuPercent = Math.max(0, (deltaCpuMs / deltaWallMs) * 100)
        }
        inst.resourceUsage = {
          memoryRssMB: msg.memoryRssMB,
          cpuUserMs: msg.cpuUserMs,
          cpuSystemMs: msg.cpuSystemMs,
          cpuPercent,
          at: now,
        }
        break
      }
      case 'authPrompt': {
        inst.authPrompt = msg.clear ? null : { code: msg.code, url: msg.url, message: msg.message }
        this._emitStatus(inst)
        break
      }
      case 'seenPlayers': {
        inst.seenPlayers = msg.data
        this._persistSightings(inst)
        break
      }
      // Pushed whenever a module is loaded or unloaded, so a chat box open
      // at the time updates its completion list without a refresh.
      case 'moduleCommands': {
        inst.moduleCommands = Array.isArray(msg.data) ? msg.data : []
        this.io.to(this.room(inst.profileId, inst.serverId)).emit('moduleCommands', inst.moduleCommands)
        break
      }
      // A module's sandbox died on its own (see botChild.js's onExit). Drop
      // it from the loaded list so the client stops showing it as running -
      // the error itself is already in the connection's log.
      case 'moduleStopped': {
        inst.loadedModules?.delete(msg.moduleId)
        break
      }
      case 'loadModuleResult':
      case 'unloadModuleResult': {
        const pending = this._pending.get(msg.reqId)
        if (pending) {
          this._pending.delete(msg.reqId)
          pending.resolve(msg)
        }
        break
      }
      default:
        break
    }
  }

  _relayEvent(inst, event, data) {
    switch (event) {
      case 'inventory': inst.snapshot.inventory = data; break
      case 'health': inst.snapshot.health = data; break
      case 'position': inst.snapshot.position = data; break
      case 'players': inst.snapshot.players = data; break
      case 'windowOpen':
      case 'windowUpdate': inst.snapshot.window = data; break
      case 'windowClose': inst.snapshot.window = null; break
      case 'cursorItem': inst.snapshot.cursorItem = data; break
      case 'chat': {
        inst.snapshot.chatLog.push(data)
        if (inst.snapshot.chatLog.length > MAX_CHAT_LOG) inst.snapshot.chatLog.shift()
        break
      }
      default:
        break
    }
    this.io.to(this.room(inst.profileId, inst.serverId)).emit(event, data)
  }

  _handleChildExit(key, code) {
    const inst = this.instances.get(key)
    if (!inst) return
    inst.child = null
    // A clean stop/disconnect/kick already reports a terminal status
    // before the child exits - if none arrived, the process died without
    // getting the chance to (crash, kill signal, OOM, etc).
    if (!inst.terminalReported) {
      inst.status = 'error'
      inst.lastError = `Process crashed unexpectedly (exit code ${code}).`
      this._log(inst, inst.ownerUserId, 'error', inst.lastError)
      this._emitStatus(inst)
    }
    inst.terminalReported = false
    // Belt-and-suspenders: whatever the exit path was, there's no process
    // left to ever answer a pending device-code sign-in once it's gone.
    inst.authPrompt = null
    inst.loadedModules.clear()
    inst.moduleCommands = []
    // The connection is over, so the pending sighting window will never
    // close on its own - write what it saw before the instance goes cold.
    if (inst.sightingTimer) {
      clearTimeout(inst.sightingTimer)
      inst.sightingTimer = null
    }
    this._flushSightings(inst)
  }
}

module.exports = { BotManager, viewerPath }
