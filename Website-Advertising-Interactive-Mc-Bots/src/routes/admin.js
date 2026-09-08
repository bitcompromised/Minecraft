const express = require('express')
const os = require('os')
const db = require('../db')
const config = require('../config')
const roles = require('../roles')
const serverMonitor = require('../serverMonitor')
const { hashPassword, requireAdmin, requireModOrAdmin } = require('../auth')
const { paginateAndSearch } = require('../pagination')
const { asyncHandler } = require('../asyncHandler')
const { logAudit: logAuditEntry } = require('../audit')

const STATUS_VALUES = new Set(['normal', 'vip', 'mod'])
const BOT_STATUS_VALUES = new Set(['online', 'offline', 'connecting', 'error'])
const MAX_TAGS = 5
const MAX_TAG_LENGTH = 20

// Site-wide settings, stored via db.getSystemSetting/setSystemSetting (the
// same systemConfig collection mongo.js already uses for the session
// secret). Admin-only - not mod-eligible, since these affect every user
// (registration, payout economics, maintenance messaging).
const bool = { validate: (v) => typeof v === 'boolean', clean: (v) => v }
const wholeNumber = (max) => ({
  validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max,
  clean: (v) => v,
})

const SETTINGS_SCHEMA = {
  siteName: { default: 'Mineflayer Web', validate: (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 60, clean: (v) => v.trim() },
  registrationOpen: { default: true, ...bool },
  // When true, anyone can sign up without an invite code. Invites still work
  // and still track referrals; they just stop being mandatory.
  invitelessRegistration: { default: false, ...bool },
  // Applied once, at registration (see routes/auth.js).
  startingCredits: { default: 0, ...wholeNumber(100000) },
  startingInvites: { default: null, validate: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1000), clean: (v) => v },

  maintenanceMode: { default: false, ...bool },
  maintenanceMessage: { default: '', validate: (v) => typeof v === 'string' && v.length <= 500, clean: (v) => v.trim() },
  announcementBanner: { default: '', validate: (v) => typeof v === 'string' && v.length <= 500, clean: (v) => v.trim() },
  marketplacePayoutRate: { default: 0.8, validate: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1, clean: (v) => v },

  // Automatic consequences once a user accumulates this many active
  // (non-revoked) warnings. 0 disables that step entirely.
  warnThresholdPause: { default: 2, ...wholeNumber(100) },
  warnThresholdBan: { default: 4, ...wholeNumber(100) },
  // 0 = permanent.
  warnBanDurationHours: { default: 168, ...wholeNumber(87600) },

  // Concurrent running bot connections per tier. Overrides the .env-derived
  // config.botConcurrencyByStatus defaults when set; staff are unlimited
  // regardless (see src/roles.js).
  botLimitNormal: { default: null, validate: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1000), clean: (v) => v },
  botLimitVip: { default: null, validate: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1000), clean: (v) => v },
  botLimitMod: { default: null, validate: (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 1000), clean: (v) => v },
}

// Blocks a developer from acting on an admin or another developer (see
// src/roles.js canActOnUser). Admins are unrestricted. Returns an error
// string, or null when the action may proceed.
async function outrankBlock(actor, targetId) {
  const target = await db.findUserById(targetId)
  if (!target) return null // the route's own 404 handles this
  if (roles.canActOnUser(actor, target)) return null
  return 'Developers cannot act on an admin or another developer account.'
}

function serializeUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status || 'normal',
    credits: u.credits || 0,
    inviteQuota: u.inviteQuota ?? config.inviteQuotaByStatus.normal,
    paused: !!u.paused,
    pauseReason: u.pauseReason,
    banned: !!u.banned,
    banReason: u.banReason,
    banExpiresAt: u.banExpiresAt,
    avatarUrl: u.avatarUrl || null,
    tags: u.tags || [],
    createdAt: u.createdAt,
  }
}

// Thin req-aware wrapper over the shared logAudit (src/audit.js) - every
// call site in this file already has `req` in scope, not a bare actorId.
async function logAudit(req, action, targetType, targetId, details = null) {
  await logAuditEntry(req.user.id, action, targetType, targetId, details)
}

function createAdminRoutes(botManager) {
  const router = express.Router()

  router.get('/users', requireModOrAdmin, asyncHandler(async (req, res) => {
    const all = await Promise.all((await db.listAllUsers()).map(async (u) => {
      const invite = await db.findInviteByUsedUserId(u.id)
      const inviter = invite ? await db.findUserById(invite.createdByUserId) : null
      return { ...serializeUser(u), invitedByUsername: inviter ? inviter.username : null }
    }))
    const { items, ...meta } = paginateAndSearch(all, req.query, (u, term) =>
      u.username.toLowerCase().includes(term) || (u.email || '').toLowerCase().includes(term))
    res.json({ users: items, ...meta })
  }))

  router.post('/users/:id/credits', requireAdmin, asyncHandler(async (req, res) => {
    const num = parseInt(req.body?.credits, 10)
    if (!Number.isInteger(num) || num < 0) return res.status(400).json({ error: 'Invalid credits amount.' })
    const before = await db.findUserById(req.params.id)
    const user = await db.setUserCredits(req.params.id, num)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_credits', 'user', user.id, { username: user.username, from: before?.credits ?? null, to: user.credits })
    res.json(serializeUser(user))
  }))

  router.post('/users/:id/invite-quota', requireAdmin, asyncHandler(async (req, res) => {
    const num = parseInt(req.body?.inviteQuota, 10)
    if (!Number.isInteger(num) || num < 0) return res.status(400).json({ error: 'Invalid invite quota.' })
    const before = await db.findUserById(req.params.id)
    const user = await db.setUserInviteQuota(req.params.id, num)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_invite_quota', 'user', user.id, { username: user.username, from: before?.inviteQuota ?? null, to: user.inviteQuota })
    res.json(serializeUser(user))
  }))

  router.post('/users/:id/status', requireAdmin, asyncHandler(async (req, res) => {
    const { status } = req.body || {}
    if (!STATUS_VALUES.has(status)) return res.status(400).json({ error: 'Status must be normal, vip, or mod.' })
    const before = await db.findUserById(req.params.id)
    const user = await db.setUserStatus(req.params.id, status)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_status', 'user', user.id, { username: user.username, from: before?.status ?? null, to: user.status })
    res.json(serializeUser(user))
  }))

  // Role assignment is admin-only, deliberately narrower than the rest of
  // this file: a developer being able to promote themselves (or anyone
  // else) to admin would make the canActOnUser guard below pointless.
  router.post('/users/:id/role', asyncHandler(async (req, res) => {
    if (!roles.isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin can change roles.' })
    const { role } = req.body || {}
    if (!roles.ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${roles.ASSIGNABLE_ROLES.join(', ')}.` })
    }
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot change your own role.' })
    }
    const before = await db.findUserById(req.params.id)
    const user = await db.setUserRole(req.params.id, role)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_role', 'user', user.id, { username: user.username, from: before?.role ?? null, to: user.role })
    res.json(serializeUser(user))
  }))

  router.post('/users/:id/pause', requireAdmin, asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot pause your own account.' })
    }
    const blocked = await outrankBlock(req.user, req.params.id)
    if (blocked) return res.status(403).json({ error: blocked })
    const { paused, reason } = req.body || {}
    const user = await db.setUserPaused(req.params.id, !!paused, typeof reason === 'string' ? reason.slice(0, 500) : null)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, user.paused ? 'pause_user' : 'unpause_user', 'user', user.id, { username: user.username, reason: user.pauseReason })
    res.json(serializeUser(user))
  }))

  router.post('/users/:id/ban', requireAdmin, asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot ban your own account.' })
    }
    const blocked = await outrankBlock(req.user, req.params.id)
    if (blocked) return res.status(403).json({ error: blocked })
    const { banned, reason, durationMs } = req.body || {}
    let duration = null
    if (banned && durationMs !== null && durationMs !== undefined && durationMs !== '') {
      duration = parseInt(durationMs, 10)
      if (!Number.isInteger(duration) || duration <= 0) {
        return res.status(400).json({ error: 'Duration must be a positive number of milliseconds, or omitted for a permanent ban.' })
      }
    }
    const user = await db.setUserBan(req.params.id, {
      banned: !!banned,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      durationMs: duration,
      bannedBy: req.user.id,
    })
    if (!user) return res.status(404).json({ error: 'User not found.' })
    // A ban takes effect immediately even on an already-open connection -
    // requirePageAuth/requireApiAuth already block their *next* request, but
    // a live socket.io connection (the Play page) stays open until it
    // reconnects unless force-disconnected here too.
    if (user.banned) {
      botManager.io.in(`user:${user.id}`).disconnectSockets(true)
    }
    await logAudit(req, user.banned ? 'ban_user' : 'unban_user', 'user', user.id, {
      username: user.username, reason: user.banReason, durationMs: duration,
    })
    res.json(serializeUser(user))
  }))

  // Password resets are mod-eligible (admins retain everything else above -
  // credits/status/pause/ban/quota stay admin-only). A mod resetting an
  // admin's password would be a privilege-escalation path (reset -> log in
  // as admin), so that combination is blocked even though a real admin can
  // still reset another admin's password.
  router.post('/users/:id/password', requireModOrAdmin, asyncHandler(async (req, res) => {
    // Mods can't reset a staff account's password, and a developer can't
    // reset an admin's or another developer's - both are the same
    // privilege-escalation path (reset -> log in as them).
    if (!roles.isAdmin(req.user)) {
      const target = await db.findUserById(req.params.id)
      if (target && roles.isStaff(target)) {
        return res.status(403).json({ error: "You cannot reset a staff account's password." })
      }
    }
    const { newPassword } = req.body || {}
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' })
    }
    const ok = await db.updateUserPassword(req.params.id, hashPassword(newPassword))
    if (!ok) return res.status(404).json({ error: 'User not found.' })
    // Never log the new password itself - just that a reset happened.
    const target = await db.findUserById(req.params.id)
    await logAudit(req, 'reset_password', 'user', req.params.id, { username: target?.username })
    res.json({ ok: true })
  }))

  router.post('/users/:id/email', requireAdmin, asyncHandler(async (req, res) => {
    const blocked = await outrankBlock(req.user, req.params.id)
    if (blocked) return res.status(403).json({ error: blocked })
    const { email } = req.body || {}
    if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'Invalid email address.' })
    }
    const before = await db.findUserById(req.params.id)
    const user = await db.setUserEmail(req.params.id, email ? email.trim() : null)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_email', 'user', user.id, { username: user.username, from: before?.email ?? null, to: user.email })
    res.json(serializeUser(user))
  }))

  router.post('/users/:id/tags', requireAdmin, asyncHandler(async (req, res) => {
    const { tags } = req.body || {}
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'Tags must be a list.' })
    const cleaned = [...new Set(tags
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && t.length <= MAX_TAG_LENGTH))]
      .slice(0, MAX_TAGS)
    const user = await db.setUserTags(req.params.id, cleaned)
    if (!user) return res.status(404).json({ error: 'User not found.' })
    await logAudit(req, 'set_tags', 'user', user.id, { username: user.username, tags: cleaned })
    res.json(serializeUser(user))
  }))

  router.get('/settings', requireAdmin, asyncHandler(async (req, res) => {
    const result = {}
    for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
      result[key] = await db.getSystemSetting(key, spec.default)
    }
    res.json(result)
  }))

  router.post('/settings', requireAdmin, asyncHandler(async (req, res) => {
    const updates = req.body || {}
    const wasInMaintenance = await db.getSystemSetting('maintenanceMode', false)
    const result = {}
    for (const [key, value] of Object.entries(updates)) {
      const spec = SETTINGS_SCHEMA[key]
      if (!spec) continue
      if (!spec.validate(value)) return res.status(400).json({ error: `Invalid value for "${key}".` })
      result[key] = await db.setSystemSetting(key, spec.clean(value))
    }

    // Switching maintenance mode on takes effect immediately: every running
    // bot that isn't owned by staff is stopped right here, rather than being
    // left connected until someone happens to notice. Staff bots keep
    // running so maintenance can be tested against a live connection, and
    // routes/bots.js blocks everyone else from starting a new one until the
    // switch goes back off.
    if (result.maintenanceMode === true && !wasInMaintenance) {
      const staff = (await db.listAllUsers()).filter((u) => roles.isMaintenanceExempt(u))
      const stopped = await botManager.stopAllExceptUsers(staff.map((u) => u.id))
      result.botsStopped = stopped
      if (stopped > 0) {
        await logAudit(req, 'maintenance_stop_bots', 'setting', null, { stopped })
      }
    }

    if (Object.keys(result).length) await logAudit(req, 'update_settings', 'setting', null, result)
    res.json(result)
  }))

  router.get('/monitoring', requireAdmin, asyncHandler(async (req, res) => {
    const [cpuPercent, disks] = await Promise.all([
      serverMonitor.getCpuUsagePercent(),
      serverMonitor.getDiskUsage(),
    ])
    const memory = serverMonitor.getMemoryUsage()

    const perBot = botManager.getAllResourceUsage()
    const cpuSamples = perBot.filter((b) => b.cpuPercent !== null)
    const avgBotCpuPercent = cpuSamples.length ? cpuSamples.reduce((s, b) => s + b.cpuPercent, 0) / cpuSamples.length : 0
    const avgBotMemoryMB = perBot.length ? perBot.reduce((s, b) => s + (b.memoryRssMB || 0), 0) / perBot.length : 0

    const totalUsers = await db.userCount()
    const totalCredits = await db.sumUserCredits()
    const sales = await db.moduleSalesStats()
    const byModule = await Promise.all(sales.byModule.map(async (m) => {
      const mod = await db.findModuleById(m.moduleId)
      return { ...m, name: mod ? mod.name : '(deleted module)' }
    }))

    res.json({
      cpu: { percent: cpuPercent, cores: os.cpus().length },
      memory,
      disks,
      thisProcess: { memoryRssMB: process.memoryUsage().rss / (1024 * 1024) },
      bots: { runningCount: perBot.length, avgCpuPercent: avgBotCpuPercent, avgMemoryMB: avgBotMemoryMB, perBot },
      users: { total: totalUsers, totalCredits, averageCredits: totalUsers ? totalCredits / totalUsers : 0 },
      moduleSales: { totalSales: sales.totalSales, totalRevenue: sales.totalRevenue, totalPayout: sales.totalPayout, byModule },
    })
  }))

  // Resets the sales figures on the monitoring page. Purchases are archived,
  // not deleted, so nobody loses a module they paid for - see
  // db.clearModuleSales.
  router.post('/module-sales/clear', requireAdmin, asyncHandler(async (req, res) => {
    const archived = await db.clearModuleSales()
    await logAudit(req, 'clear_module_sales', 'setting', null, { archived })
    res.json({ ok: true, archived })
  }))

  // Names a sandboxed module's require()/import may resolve to (see
  // src/sandboxWorker.js) - both Node builtins and npm package names
  // already installed in this project. Adding a builtin like 'fs' or
  // 'child_process' here effectively reopens the sandbox for anything that
  // imports it, so this stays admin-only, not mod-eligible.
  router.get('/import-whitelist', requireAdmin, asyncHandler(async (req, res) => {
    res.json({ entries: await db.listImportWhitelist() })
  }))

  router.post('/import-whitelist', requireAdmin, asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name || name.length > 100 || /[\s;]/.test(name)) {
      return res.status(400).json({ error: 'Invalid package/module name.' })
    }
    const entry = await db.addImportWhitelistEntry(name, req.user.id)
    await logAudit(req, 'add_import_whitelist', 'importWhitelist', entry.id, { name })
    res.json(entry)
  }))

  router.delete('/import-whitelist/:name', requireAdmin, asyncHandler(async (req, res) => {
    const ok = await db.removeImportWhitelistEntry(req.params.name)
    if (!ok) return res.status(404).json({ error: 'Not found.' })
    await logAudit(req, 'remove_import_whitelist', 'importWhitelist', null, { name: req.params.name })
    res.json({ ok: true })
  }))

  // Every private message ever sent, searchable by sender/recipient/body -
  // admin-only (not mod-eligible, unlike most of this file) since this is
  // meaningfully more sensitive than anything else here.
  router.get('/messages', requireAdmin, asyncHandler(async (req, res) => {
    const all = await db.listAllMessages()
    const entries = await Promise.all(all.map(async (m) => {
      const from = await db.findUserById(m.fromUserId)
      const to = await db.findUserById(m.toUserId)
      return {
        id: m.id,
        fromUsername: from ? from.username : '(deleted user)',
        toUsername: to ? to.username : '(deleted user)',
        body: m.body,
        createdAt: m.createdAt,
        readAt: m.readAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(entries, req.query, (entry, term) =>
      entry.fromUsername.toLowerCase().includes(term) ||
      entry.toUsername.toLowerCase().includes(term) ||
      entry.body.toLowerCase().includes(term))
    res.json({ messages: items, ...meta })
  }))

  // Every mutating admin/mod action above writes here via logAudit() -
  // who did what, to what, and when. Same paginated/searchable pattern as
  // the other admin list endpoints (see src/pagination.js).
  router.get('/audit-log', requireAdmin, asyncHandler(async (req, res) => {
    const all = await db.listAuditLog()
    const entries = await Promise.all(all.map(async (entry) => {
      const actor = await db.findUserById(entry.actorId)
      return {
        id: entry.id,
        actorUsername: actor ? actor.username : '(deleted user)',
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        details: entry.details,
        createdAt: entry.createdAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(entries, req.query, (entry, term) =>
      entry.actorUsername.toLowerCase().includes(term) ||
      entry.action.toLowerCase().includes(term) ||
      JSON.stringify(entry.details || {}).toLowerCase().includes(term))
    res.json({ entries: items, ...meta })
  }))

  // Modules reported by users for policy/abuse concerns (see
  // routes/marketplace.js's POST /modules/:id/report) - mod-eligible, same
  // tier as module approval since it's the same review duty.
  router.get('/module-reports', requireModOrAdmin, asyncHandler(async (req, res) => {
    const openReports = await db.listOpenModuleReports()
    const entries = await Promise.all(openReports.map(async (r) => {
      const reporter = await db.findUserById(r.reporterId)
      const module_ = await db.findModuleById(r.moduleId)
      return {
        id: r.id,
        moduleId: r.moduleId,
        moduleName: module_ ? module_.name : '(deleted module)',
        reporterUsername: reporter ? reporter.username : '(deleted user)',
        reason: r.reason,
        createdAt: r.createdAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(entries, req.query, (entry, term) =>
      entry.moduleName.toLowerCase().includes(term) ||
      entry.reporterUsername.toLowerCase().includes(term) ||
      entry.reason.toLowerCase().includes(term))
    res.json({ reports: items, ...meta })
  }))

  // Threads and posts users have reported (see routes/forum.js's
  // /threads/:id/report and /posts/:id/report). Same mod-eligible tier as
  // module reports - it's the same review duty.
  router.get('/forum-reports', requireModOrAdmin, asyncHandler(async (req, res) => {
    const open = await db.listOpenForumReports()
    const entries = await Promise.all(open.map(async (r) => {
      const reporter = await db.findUserById(r.reporterId)
      const thread = r.threadId ? await db.findForumThread(r.threadId) : null
      const post = r.targetType === 'post' ? await db.findForumPost(r.targetId) : null
      const authorId = r.targetType === 'post' ? post?.authorId : thread?.authorId
      const author = authorId ? await db.findUserById(authorId) : null
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        threadId: r.threadId,
        threadTitle: thread ? thread.title : '(deleted thread)',
        // A snippet of what was actually reported, so triage doesn't need a
        // round trip to the thread page for the obvious cases.
        excerpt: r.targetType === 'post'
          ? (post ? post.body.slice(0, 300) : '(deleted post)')
          : (thread ? (thread.body || '').slice(0, 300) : '(deleted thread)'),
        authorUsername: author ? author.username : '(deleted user)',
        reporterUsername: reporter ? reporter.username : '(deleted user)',
        reason: r.reason,
        createdAt: r.createdAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(entries, req.query, (e, term) =>
      e.threadTitle.toLowerCase().includes(term) ||
      e.authorUsername.toLowerCase().includes(term) ||
      e.reporterUsername.toLowerCase().includes(term) ||
      e.reason.toLowerCase().includes(term))
    res.json({ reports: items, ...meta })
  }))

  router.post('/forum-reports/:id/resolve', requireModOrAdmin, asyncHandler(async (req, res) => {
    const updated = await db.setForumReportStatus(req.params.id, 'resolved', req.user.id)
    if (!updated) return res.status(404).json({ error: 'Report not found.' })
    await logAudit(req, 'resolve_forum_report', 'forumReport', updated.id, { targetType: updated.targetType })
    res.json({ ok: true })
  }))

  // Every warning ever issued, newest first - the staff-side counterpart to
  // a user's own list on their settings page.
  router.get('/warnings', requireModOrAdmin, asyncHandler(async (req, res) => {
    const all = await db.listAllWarnings()
    const entries = await Promise.all(all.map(async (w) => {
      const recipient = await db.findUserById(w.userId)
      const issuer = await db.findUserById(w.issuedBy)
      return {
        id: w.id,
        username: recipient ? recipient.username : '(deleted user)',
        issuedByUsername: issuer ? issuer.username : '(deleted user)',
        targetType: w.targetType,
        staffNote: w.staffNote,
        quotedContent: w.quotedContent,
        link: w.link,
        revokedAt: w.revokedAt,
        createdAt: w.createdAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(entries, req.query, (e, term) =>
      e.username.toLowerCase().includes(term) ||
      e.issuedByUsername.toLowerCase().includes(term) ||
      e.staffNote.toLowerCase().includes(term))
    res.json({ warnings: items, ...meta })
  }))

  router.post('/module-reports/:id/resolve', requireModOrAdmin, asyncHandler(async (req, res) => {
    const updated = await db.setModuleReportStatus(req.params.id, 'resolved', req.user.id)
    if (!updated) return res.status(404).json({ error: 'Report not found.' })
    await logAudit(req, 'resolve_module_report', 'moduleReport', updated.id, { moduleId: updated.moduleId })
    res.json({ ok: true })
  }))

  // One row per live connection (a profile can now run against more than
  // one saved server at once - see botManager.js's
  // listConnectionsForProfile()), or a single synthetic "offline" row for a
  // profile with none running, so every profile still shows up at least once.
  router.get('/bot-profiles', requireAdmin, asyncHandler(async (req, res) => {
    const allProfiles = await db.listAllBotProfiles()
    let rows = []
    for (const profile of allProfiles) {
      const owner = await db.findUserById(profile.userId)
      const ownerUsername = owner ? owner.username : '(deleted user)'
      const connections = botManager.listConnectionsForProfile(profile.id)
      const base = {
        id: profile.id,
        name: profile.name,
        ownerUsername,
        mcUsername: profile.mcUsername,
        mcAuth: profile.mcAuth,
        createdAt: profile.createdAt,
      }
      if (connections.length === 0) {
        rows.push({ ...base, status: 'offline', server: null, proxyName: null, lastError: null })
      } else {
        for (const conn of connections) {
          rows.push({ ...base, status: conn.status, server: conn.server, proxyName: conn.proxyName, lastError: conn.error })
        }
      }
    }
    if (BOT_STATUS_VALUES.has(req.query.status)) {
      rows = rows.filter((p) => p.status === req.query.status)
    }
    const { items, ...meta } = paginateAndSearch(rows, req.query, (p, term) =>
      p.name.toLowerCase().includes(term) ||
      p.ownerUsername.toLowerCase().includes(term) ||
      p.mcUsername.toLowerCase().includes(term))
    res.json({ botProfiles: items, ...meta })
  }))

  router.get('/logs', requireAdmin, asyncHandler(async (req, res) => {
    const allLogs = await db.listErrorLogs()
    const logs = await Promise.all(allLogs.map(async (entry) => {
      const user = entry.userId ? await db.findUserById(entry.userId) : null
      const profile = entry.botProfileId ? await db.findBotProfileById(entry.botProfileId) : null
      return {
        id: entry.id,
        level: entry.level,
        message: entry.message,
        username: user ? user.username : null,
        botProfileName: profile ? profile.name : null,
        createdAt: entry.createdAt,
      }
    }))
    const { items, ...meta } = paginateAndSearch(logs, req.query, (entry, term) =>
      entry.message.toLowerCase().includes(term) ||
      (entry.username || '').toLowerCase().includes(term) ||
      (entry.botProfileName || '').toLowerCase().includes(term))
    res.json({ logs: items, ...meta })
  }))

  return router
}

module.exports = { createAdminRoutes }
