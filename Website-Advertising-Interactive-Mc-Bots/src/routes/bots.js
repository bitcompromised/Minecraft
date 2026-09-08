const express = require('express')
const db = require('../db')
const config = require('../config')
const roles = require('../roles')
const { paginateAndSearch } = require('../pagination')
const { asyncHandler } = require('../asyncHandler')

const AUTH_TYPES = new Set(['microsoft', 'offline', 'mojang'])

// Staff (admin/developer) are unlimited. Everyone else is capped per tier:
// the admin-configurable botLimit* settings win when set, otherwise the
// .env-derived config.botConcurrencyByStatus defaults apply.
const BOT_LIMIT_SETTING_BY_STATUS = {
  normal: 'botLimitNormal',
  vip: 'botLimitVip',
  mod: 'botLimitMod',
}

async function botConcurrencyLimitFor(user) {
  if (roles.hasUnlimitedBots(user)) return Infinity
  const status = user.status || 'normal'
  const settingKey = BOT_LIMIT_SETTING_BY_STATUS[status] || BOT_LIMIT_SETTING_BY_STATUS.normal
  const configured = await db.getSystemSetting(settingKey, null)
  if (Number.isInteger(configured)) return configured
  return config.botConcurrencyByStatus[status] ?? config.botConcurrencyByStatus.normal
}

// While maintenance mode is on, nobody but staff can create a bot profile or
// start a connection - their existing bots were already stopped when the
// switch was flipped (see botManager.stopAllExceptUsers), and letting anyone
// immediately restart one would defeat the point. Returns an error string,
// or null when the user is clear to proceed.
async function maintenanceBlock(user) {
  if (roles.isMaintenanceExempt(user)) return null
  if (!await db.getSystemSetting('maintenanceMode', false)) return null
  const message = await db.getSystemSetting('maintenanceMessage', '')
  return `The site is in maintenance mode, so bots can't be started right now.${message ? ` ${message}` : ''}`
}

function createBotRoutes(botManager) {
  const router = express.Router()

  // A profile can now be connected to more than one saved server at once,
  // so its live state is a list of connections (one per server it's
  // currently running against, possibly empty) rather than a single
  // status/server/viewerPort/etc - see botManager.js's
  // listConnectionsForProfile().
  async function serializeProfile(profile) {
    const connections = botManager.listConnectionsForProfile(profile.id)
    const withModules = await Promise.all(connections.map(async (conn) => {
      // Counted from the in-memory per-connection log the /logs and /errors
      // endpoints already read, so the collapsed summary on the client page
      // can show "3 errors" without a request per connection.
      const log = botManager.getLog(profile.id, conn.serverId)
      const errorCount = log.filter((entry) => entry.level === 'error').length
      const moduleErrorCount = log.filter((entry) =>
        entry.level === 'error' && entry.source && entry.source.startsWith('module:')).length
      return {
        ...conn,
        loadedModules: botManager.listLoadedModules(profile.id, conn.serverId),
        errorCount,
        moduleErrorCount,
      }
    }))
    return {
      id: profile.id,
      name: profile.name,
      mcUsername: profile.mcUsername,
      mcAuth: profile.mcAuth,
      mcVersion: profile.mcVersion,
      notes: profile.notes || '',
      connections: withModules,
    }
  }

  // Filesystem-unsafe characters stripped so a bot/profile name can be used
  // directly as a download filename.
  function safeFilenamePart(name) {
    return String(name || '').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 64) || 'bot'
  }

  function describeServer(server, serverId) {
    if (!server) return `(deleted server ${serverId})`
    return `${server.name} (${server.host}:${server.port})`
  }

  // Exports are named for the bot, the server they came from, and the day
  // they were taken - downloading the same bot's log from two servers, or the
  // same server on two days, no longer produces colliding filenames.
  function exportFilename(profile, server, kind, extension) {
    const date = new Date().toISOString().slice(0, 10)
    const serverPart = safeFilenamePart(server ? server.name : 'unknown-server')
    return `${safeFilenamePart(profile.name)}-${serverPart}-${date}-${kind}.${extension}`
  }

  router.get('/', asyncHandler(async (req, res) => {
    const all = await Promise.all((await db.listBotProfilesByUser(req.user.id)).map(serializeProfile))
    const { items, ...meta } = paginateAndSearch(all, req.query, (b, term) => b.name.toLowerCase().includes(term))
    res.json({ bots: items, ...meta })
  }))

  router.post('/', asyncHandler(async (req, res) => {
    const blocked = await maintenanceBlock(req.user)
    if (blocked) return res.status(503).json({ error: blocked })

    const { name, mcUsername, mcAuth, mcVersion } = req.body || {}

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required.' })
    }
    if (!AUTH_TYPES.has(mcAuth)) {
      return res.status(400).json({ error: 'Invalid auth type.' })
    }
    if (typeof mcUsername !== 'string' || !mcUsername.trim()) {
      return res.status(400).json({ error: 'Username/email is required.' })
    }

    const profile = await db.createBotProfile(req.user.id, {
      name: name.trim(),
      mcUsername: mcUsername.trim(),
      mcAuth,
      mcVersion: mcVersion && mcVersion !== 'auto' ? String(mcVersion).trim() : null,
    })
    res.json(await serializeProfile(profile))
  }))

  router.delete('/:id', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    await botManager.removeAllForProfile(profile.id)
    await db.deleteBotProfile(profile.id, req.user.id)
    res.json({ ok: true })
  }))

  // A free-text scratchpad the owner writes for themselves (what this bot
  // is doing, TODOs, config reminders) - not shown to anyone else.
  router.post('/:id/notes', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { notes } = req.body || {}
    if (typeof notes !== 'string' || notes.length > 10000) {
      return res.status(400).json({ error: 'Notes must be 10000 characters or fewer.' })
    }
    const updated = await db.setBotProfileNotes(profile.id, req.user.id, notes)
    res.json({ notes: updated.notes })
  }))

  router.post('/:id/start', asyncHandler(async (req, res) => {
    if (req.user.paused) {
      return res.status(403).json({ error: `Your account is paused: ${req.user.pauseReason || 'no reason given'}` })
    }
    const blocked = await maintenanceBlock(req.user)
    if (blocked) return res.status(503).json({ error: blocked })
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const server = await db.findServer(req.body?.serverId, req.user.id)
    if (!server) return res.status(400).json({ error: 'Pick a server from your saved list to connect to.' })
    const proxy = req.body?.proxyId ? await db.findProxy(req.body.proxyId, req.user.id) : null
    if (req.body?.proxyId && !proxy) return res.status(400).json({ error: 'Unknown proxy.' })

    const limit = await botConcurrencyLimitFor(req.user)
    if (Number.isFinite(limit)) {
      const active = botManager.countActiveConnectionsForUser(req.user.id, profile.id, server.id)
      if (active >= limit) {
        return res.status(403).json({
          error: `You've reached your concurrent bot limit (${limit} for your ${req.user.status || 'normal'} tier). Stop another bot before starting a new one.`,
        })
      }
    }

    // Starting on a different server used to leave the previous server's
    // finished connection sitting in the list as a stale "offline" row, which
    // reads like a second bot that failed. Cleanly-stopped connections are
    // dropped here; ones that ended in an error are kept, since their status
    // and logs are the whole reason you'd want them.
    botManager.pruneIdleConnections(profile.id, server.id)

    const status = await botManager.start(profile, server, proxy)
    res.json(status)
  }))

  // Removes a single connection row from a profile - the manual counterpart
  // to the pruning above, for connections that ended in an error (which are
  // deliberately kept) once the owner has finished reading them. Refuses to
  // remove a live one; stop it first.
  router.delete('/:id/connections/:serverId', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const conn = botManager.getStatus(profile.id, req.params.serverId)
    if (conn.status === 'online' || conn.status === 'connecting') {
      return res.status(400).json({ error: 'Stop this connection before removing it.' })
    }
    await botManager.removeConnection(profile.id, req.params.serverId)
    res.json({ ok: true })
  }))

  router.post('/:id/stop', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.body || {}
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    const status = await botManager.stop(profile.id, serverId)
    res.json(status)
  }))

  // Sourced from botManager's in-memory per-connection log (see
  // botManager.js's getLog()/_log()) rather than the persisted, errors-only
  // Mongo errorLogs collection - this is the richer stream (connecting/
  // spawned/module load-unload/disconnect reason, plus real errors), and
  // resets every time this connection is (re)started, by design.
  //
  // ?level=error narrows this down to just the error-level entries (both
  // connection-level and module-level - see /errors below for a
  // module-only slice of the same thing) - but the four lifecycle
  // milestones (process started/connecting/client created/connected,
  // tagged source:'lifecycle' in botChild.js) always come through
  // regardless of the filter, so switching to "errors only" never hides
  // whether/when the bot actually got that far.
  router.get('/:id/logs', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    let logs = [...botManager.getLog(profile.id, serverId)].reverse()
    if (req.query.level === 'error') {
      logs = logs.filter((entry) => entry.level === 'error' || entry.source === 'lifecycle')
    }
    const { items, ...meta } = paginateAndSearch(logs, req.query, (entry, term) =>
      entry.message.toLowerCase().includes(term))
    res.json({ logs: items, ...meta })
  }))

  // Module-only, error-level slice of the same per-connection log as /logs
  // above - searchable, and resets on every (re)start along with the rest
  // of that log (see botManager.js's start()).
  router.get('/:id/errors', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    let entries = botManager.getLog(profile.id, serverId).filter((e) => e.level === 'error' && e.source && e.source.startsWith('module:'))
    if (req.query.moduleId) entries = entries.filter((e) => e.moduleId === req.query.moduleId)
    entries = [...entries].reverse()
    const { items, ...meta } = paginateAndSearch(entries, req.query, (entry, term) =>
      entry.message.toLowerCase().includes(term) || entry.source.toLowerCase().includes(term))
    res.json({ errors: items, ...meta })
  }))

  // Downloads this connection's chat log (see botManager.js's snapshot -
  // capped at the most recent 200 lines, in-memory only, resets on
  // restart, same as everything else in the snapshot) as a plain text
  // file rather than just returning it as JSON, since the point is to
  // save/archive it outside the app.
  router.get('/:id/chat-history', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    const server = await db.findServer(serverId, req.user.id)
    const snapshot = botManager.getSnapshot(profile.id, serverId)
    const chatLog = snapshot?.chatLog || []

    // Everything the bot received is in here, not just player chat: server
    // broadcasts, join/leave notices, action-bar text, and whispers all
    // arrive through the same 'message' event (see botChild.js) and are
    // tagged with a kind. The export labels each line with that kind so a
    // saved log is readable without having to guess what came from where.
    const KIND_LABEL = { chat: 'CHAT', system: 'SERVER', game_info: 'ACTIONBAR' }
    const lines = chatLog.map((line) => {
      const time = new Date(line.time).toISOString()
      const kind = KIND_LABEL[line.kind] || 'SERVER'
      const who = line.username ? ` <${line.username}>` : ''
      // line.message already has any legacy colour codes stripped.
      return `[${time}] [${kind}]${who} ${line.message}`
    })

    const header = [
      `# Chat history for bot "${profile.name}"`,
      `# Server: ${describeServer(server, serverId)}`,
      `# Exported: ${new Date().toISOString()}`,
      `# Lines: ${lines.length}`,
      '',
    ]
    const body = lines.length
      ? header.concat(lines).join('\n')
      : header.concat('No chat messages recorded for this connection yet.').join('\n')

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(profile, server, 'chat', 'txt')}"`)
    res.send(body)
  }))

  // ---- who this bot has seen ----
  //
  // Every player this profile has ever seen on this server, with when it
  // first and last saw them. The record is kept in the database
  // (db.recordPlayerSightings), not in the running connection: a bot that
  // has been restarted five times has still seen everyone it saw on the
  // first run, and answering "when did you last see X" is the whole point.
  //
  // Both endpoints flush the live connection's pending sightings first, so
  // what comes back includes whoever walked past a moment ago rather than
  // stopping at the last write window (see botManager's flushSightings).

  // Cross-referenced against who is on the server right now - that is what
  // separates "seen at 14:02, still here" from "seen at 14:02, long gone".
  function onlineNow(profileId, serverId) {
    return new Set((botManager.getSnapshot(profileId, serverId)?.players || []).map((p) => p.username))
  }

  router.get('/:id/seen-players', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId, search } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })

    await botManager.flushSightings(profile.id, serverId)

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
    const skip = Math.max(0, Number(req.query.skip) || 0)
    const rows = await db.listPlayerSightings(profile.id, serverId, {
      search: typeof search === 'string' ? search.trim() : '',
      limit,
      skip,
    })
    const online = onlineNow(profile.id, serverId)

    res.json({
      total: await db.countPlayerSightings(profile.id, serverId),
      limit,
      skip,
      players: rows.map((row) => ({
        username: row.username,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        connections: row.connections || 1,
        online: online.has(row.username),
      })),
    })
  }))

  // The same history as a download.
  router.get('/:id/connected-users', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    const server = await db.findServer(serverId, req.user.id)

    await botManager.flushSightings(profile.id, serverId)

    const seen = await db.listPlayerSightings(profile.id, serverId, { limit: 1000 })
    const online = onlineNow(profile.id, serverId)

    const csvCell = (value) => {
      const str = String(value ?? '')
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }

    const header = 'username,firstSeenAt,lastSeenAt,stillOnline,connectionsSeenOn,minutesObserved'
    const lines = [header]
    for (const p of seen) {
      const minutes = Math.max(0, Math.round((p.lastSeenAt - p.firstSeenAt) / 60000))
      lines.push([
        csvCell(p.username),
        new Date(p.firstSeenAt).toISOString(),
        new Date(p.lastSeenAt).toISOString(),
        online.has(p.username) ? 'yes' : 'no',
        p.connections || 1,
        minutes,
      ].join(','))
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(profile, server, 'players', 'csv')}"`)
    res.send(seen.length ? lines.join('\n') : header)
  }))

  // Forgetting the history is the user's call to make - it is a record of
  // other people, kept on their behalf.
  router.delete('/:id/seen-players', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.query
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    const removed = await db.clearPlayerSightings(profile.id, serverId)
    res.json({ ok: true, removed })
  }))

  router.post('/:id/modules/:moduleId/load', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.body || {}
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    const module_ = await db.findModuleById(req.params.moduleId)
    if (!module_ || module_.status !== 'approved') {
      return res.status(404).json({ error: 'Module not available.' })
    }
    if (module_.paused) {
      return res.status(400).json({ error: `This module is paused: ${module_.pauseReason || 'no reason given'}` })
    }
    const owns = module_.ownerId === req.user.id || await db.hasPurchased(module_.id, req.user.id)
    if (!owns) return res.status(403).json({ error: 'You do not own this module.' })

    try {
      await botManager.loadModule(profile.id, serverId, module_)
      res.json({ ok: true, loadedModules: botManager.listLoadedModules(profile.id, serverId) })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  }))

  router.post('/:id/modules/:moduleId/unload', asyncHandler(async (req, res) => {
    const profile = await db.findBotProfile(req.params.id, req.user.id)
    if (!profile) return res.status(404).json({ error: 'Bot profile not found.' })
    const { serverId } = req.body || {}
    if (typeof serverId !== 'string' || !serverId) return res.status(400).json({ error: 'serverId is required.' })
    await botManager.unloadModule(profile.id, serverId, req.params.moduleId)
    res.json({ ok: true, loadedModules: botManager.listLoadedModules(profile.id, serverId) })
  }))

  return router
}

module.exports = { createBotRoutes }
