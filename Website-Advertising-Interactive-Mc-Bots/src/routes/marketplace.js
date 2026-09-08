const express = require('express')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const multer = require('multer')
const db = require('../db')
const config = require('../config')
const roles = require('../roles')
const { publicUserBadge } = require('../userBadge')
const { validateModuleSource } = require('../moduleValidator')
const { requireAdmin, requireModOrAdmin } = require('../auth')
const { paginateAndSearch } = require('../pagination')
const { asyncHandler } = require('../asyncHandler')
const { logAudit } = require('../audit')
const { diffLines } = require('../lineDiff')

fs.mkdirSync(config.modulesDir, { recursive: true })
fs.mkdirSync(config.moduleMediaDir, { recursive: true })

const MAX_MEDIA_PER_MODULE = 3
const MEDIA_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
}

// Only media is uploaded as a file now. Module source is written in the
// browser and posted as text (see the code box on the upload form and
// writeModuleSource below).
const uploadMedia = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.moduleMediaDir),
    filename: (req, file, cb) => cb(null, `${req.params.id}-${crypto.randomUUID()}${MEDIA_EXT_BY_MIME[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!MEDIA_EXT_BY_MIME[file.mimetype]) {
      return cb(new Error('Media must be a PNG, JPEG, GIF, WebP image, or MP4/WebM video.'))
    }
    cb(null, true)
  },
})

// A factory rather than a bare router: pausing or deleting a module has to
// reach into the live bot connections that are running it (see
// botManager.unloadModuleEverywhere), which a plain module-level router has
// no handle on.
function createMarketplaceRoutes(botManager) {
const router = express.Router()

// Full moderation access (approve/reject/pause/view-for-review) stays
// available to admins/mods regardless of ownership - this is NOT the same
// as "can manage this module's listing" (owner-only, see isOwner below).
// Splitting these two used to be conflated into one canManageModule check
// that also gated media upload/update submission for mods/admins on
// modules they don't own - not what "only the owner can manage it" means.
function canReviewModule(user, m) {
  return roles.isModOrAdmin(user) || m.ownerId === user.id
}

function isOwner(user, m) {
  return m.ownerId === user.id
}

// Demo modules (src/demoModules.js) are readable by anyone - being able to
// read them without buying anything is the whole reason they exist. Staff
// and the owner can still read any module's source for review.
function canViewSource(user, m) {
  return m.isDemo || canReviewModule(user, m)
}

// A private module leaves the browse list and can't be bought, but anyone
// who already purchased it keeps full access (page, source rules above, and
// loading it onto a bot). Staff can always still reach it for moderation.
async function canSeePrivateModule(user, m) {
  if (!m.isPrivate) return true
  if (isOwner(user, m) || roles.isModOrAdmin(user)) return true
  return db.hasPurchased(m.id, user.id)
}

async function serializeModule(m, requestingUser) {
  const owner = await db.findUserById(m.ownerId)
  const ownerFlag = requestingUser && m.ownerId === requestingUser.id
  const owned = ownerFlag || (requestingUser && await db.hasPurchased(m.id, requestingUser.id))
  const pendingUpdates = await db.listModuleUpdates(m.id)
  const hasPendingUpdate = pendingUpdates.some((u) => u.status === 'pending')
  const reviews = await db.listModuleReviews(m.id)
  const avgRating = reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    price: m.price,
    status: m.status,
    ownerUsername: owner ? owner.username : '(unknown)',
    // Lets listings badge the uploader as User/Staff/Developer/Admin without
    // every page re-deriving it (see src/userBadge.js).
    owner: publicUserBadge(owner),
    isOwner: ownerFlag,
    canManage: requestingUser ? isOwner(requestingUser, m) : false,
    canReview: requestingUser ? canReviewModule(requestingUser, m) : false,
    canViewSource: requestingUser ? canViewSource(requestingUser, m) : !!m.isDemo,
    owned,
    isDemo: !!m.isDemo,
    isPrivate: !!m.isPrivate,
    rejectionReason: m.rejectionReason,
    paused: !!m.paused,
    pauseReason: m.pauseReason,
    atRisk: !!m.atRisk,
    atRiskReason: m.atRiskReason,
    version: m.version || '1.0.0',
    changelog: m.changelog || [],
    media: m.media || [],
    usersCount: await db.countPurchasesForModule(m.id),
    hasPendingUpdate,
    avgRating,
    reviewCount: reviews.length,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt || m.createdAt,
  }
}

async function serializeModuleUpdate(u) {
  const submitter = await db.findUserById(u.submittedBy)
  return {
    id: u.id,
    moduleId: u.moduleId,
    submittedByUsername: submitter ? submitter.username : '(unknown)',
    version: u.version,
    changelogNotes: u.changelogNotes,
    status: u.status,
    rejectionReason: u.rejectionReason,
    createdAt: u.createdAt,
  }
}

function serializeAll(modules, user) {
  return Promise.all(modules.map((m) => serializeModule(m, user)))
}

// How the browse list can be ordered. The default is "discussion" - the
// module whose comment thread was posted in most recently floats to the top,
// which surfaces what people are actually talking about rather than whoever
// uploaded last.
const MODULE_SORTS = {
  discussion: (a, b) => (b.lastDiscussionAt || 0) - (a.lastDiscussionAt || 0) || b.updatedAt - a.updatedAt,
  updated: (a, b) => b.updatedAt - a.updatedAt,
  created: (a, b) => b.createdAt - a.createdAt,
}

router.get('/modules', asyncHandler(async (req, res) => {
  const approved = await serializeAll(await db.listApprovedModules(), req.user)
  const mine = await serializeAll(await db.listModulesByOwner(req.user.id), req.user)
  // Full (unpaginated) list of approved modules this user can load onto a
  // bot - bounded by what they actually own, unlike the browsable list
  // below which can grow across every user's uploads. Private modules stay
  // in here on purpose: going private doesn't revoke anyone's purchase.
  const owned = approved.filter((m) => m.owned)

  // ...but they do drop out of the browsable list for everyone who doesn't
  // already own them.
  const browsable = approved.filter((m) => !m.isPrivate || m.owned)

  // Timestamp of the newest comment on each module, for the default sort.
  await Promise.all(browsable.map(async (m) => {
    const comments = await db.listModuleComments(m.id)
    m.lastDiscussionAt = comments.length
      ? Math.max(...comments.map((c) => c.createdAt))
      : null
    m.commentCount = comments.length
  }))

  const sortFn = MODULE_SORTS[req.query.sort] || MODULE_SORTS.discussion
  browsable.sort(sortFn)

  // Demo modules are pinned above everything else however the list is
  // sorted - they're the documentation, and a new user should trip over them
  // without having to know they exist. They keep their relative order.
  browsable.sort((a, b) => (b.isDemo === true) - (a.isDemo === true))

  const { items, ...meta } = paginateAndSearch(browsable, { pageSize: 5, ...req.query }, (m, term) =>
    m.name.toLowerCase().includes(term) ||
    (m.description || '').toLowerCase().includes(term) ||
    m.ownerUsername.toLowerCase().includes(term))

  const response = {
    modules: items,
    ...meta,
    sort: MODULE_SORTS[req.query.sort] ? req.query.sort : 'discussion',
    mine,
    owned,
    credits: req.user.credits || 0,
    totalEarned: await db.sumEarningsForOwner(req.user.id),
  }
  if (roles.isModOrAdmin(req.user)) {
    response.pending = await serializeAll(await db.listPendingModules(), req.user)
  }
  res.json(response)
}))

async function serializeReview(r) {
  const author = await db.findUserById(r.userId)
  return { id: r.id, userId: r.userId, authorUsername: author ? author.username : '(deleted user)', rating: r.rating, body: r.body, createdAt: r.createdAt, updatedAt: r.updatedAt }
}

async function serializeComment(c) {
  const author = await db.findUserById(c.authorId)
  return { id: c.id, authorId: c.authorId, authorUsername: author ? author.username : '(deleted user)', authorAvatarUrl: author ? author.avatarUrl || null : null, body: c.body, createdAt: c.createdAt }
}

async function serializeBugReport(r) {
  const reporter = await db.findUserById(r.reporterId)
  return { id: r.id, reporterUsername: reporter ? reporter.username : '(deleted user)', title: r.title, body: r.body, status: r.status, createdAt: r.createdAt, resolvedAt: r.resolvedAt }
}

async function serializeTransaction(p) {
  const buyer = await db.findUserById(p.buyerId)
  return { id: p.id, buyerUsername: buyer ? buyer.username : '(deleted user)', price: p.price, sellerPayout: p.sellerPayout, purchasedAt: p.purchasedAt }
}

router.get('/modules/:id', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const serialized = await serializeModule(m, req.user)
  if (m.status !== 'approved' && !canReviewModule(req.user, m)) {
    return res.status(404).json({ error: 'Module not found.' })
  }
  // Same 404 (not 403) as an unapproved module - a private module shouldn't
  // confirm its own existence to someone who can't see it.
  if (!await canSeePrivateModule(req.user, m)) {
    return res.status(404).json({ error: 'Module not found.' })
  }
  const response = { module: serialized }
  if (canReviewModule(req.user, m)) {
    response.updates = await Promise.all((await db.listModuleUpdates(m.id)).map(serializeModuleUpdate))
  }
  // Transaction history/earnings are owner-or-mod/admin only - purchase
  // price/payout isn't shown to other buyers.
  if (isOwner(req.user, m) || canReviewModule(req.user, m)) {
    response.transactions = await Promise.all((await db.listPurchasesForModule(m.id)).map(serializeTransaction))
    response.totalEarned = response.transactions.reduce((sum, t) => sum + t.sellerPayout, 0)
  }
  response.reviews = await Promise.all((await db.listModuleReviews(m.id)).map(serializeReview))
  response.myReview = await db.findModuleReview(m.id, req.user.id)
  response.comments = await Promise.all((await db.listModuleComments(m.id)).map(serializeComment))
  response.bugReports = await Promise.all((await db.listModuleBugReports(m.id)).map(serializeBugReport))
  res.json(response)
}))

// Module source is written and edited in the browser, not uploaded as a file
// (see the code box on the marketplace upload form), so it arrives as plain
// text in a JSON body. These helpers turn that text into the .js file on disk
// that the sandbox actually loads.

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

// Reduces any user-supplied string to something safe to put in a filename:
// lowercase, alphanumerics and hyphens only. Everything else - including
// dots, slashes and backslashes - is collapsed away, so no part of a stored
// name can climb out of the modules directory however it was written.
function slugify(value, maxLength, fallback) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '')
  return slug || fallback
}

// Versions keep their dots, since "v1.2.0" is what anyone reading the
// directory expects to see and "v1-2-0" is not. Runs of dots are collapsed to
// one and leading/trailing dots stripped, so ".." can never survive - that is
// the only sequence here that could mean anything to a path.
function slugifyVersion(value, maxLength, fallback) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, maxLength)
    .replace(/[-.]+$/, '')
  return slug || fallback
}

/* Builds the on-disk name for a module's source file:
 *
 *     alice-vein-miner-v1.2.0-3f9c2a7b.js
 *     └─┬─┘ └────┬───┘ └──┬──┘ └───┬───┘
 *     owner   module   version   random
 *
 * The first three parts make the modules directory readable - you can tell
 * whose module a file is, which one, and which version, without opening it or
 * cross-referencing the database. That matters when something has gone wrong
 * and you are looking at the directory rather than the app.
 *
 * The random suffix is what actually guarantees uniqueness. Two people can
 * publish a module with the same name, one person can resubmit the same
 * version twice, and a slug can collide after sanitising - without it, any of
 * those would overwrite a file that another module record still points at,
 * silently swapping one user's code for another's.
 */
function moduleFileName({ username, moduleName, version }) {
  const owner = slugify(username, 32, 'user')
  const name = slugify(moduleName, 48, 'module')
  const ver = slugifyVersion(version, 24, '0')
  const random = crypto.randomBytes(4).toString('hex')
  return `${owner}-${name}-v${ver}-${random}.js`
}

// Writes the source to a fresh file and returns both the absolute path and
// the basename. The basename is stored as the module's fileName so the
// changelog and the directory listing agree on what a version is called.
async function writeModuleSource(source, naming) {
  const fileName = moduleFileName(naming)
  const filePath = path.join(config.modulesDir, fileName)
  await fs.promises.writeFile(filePath, source, 'utf8')
  return { filePath, fileName }
}

// Shared validation for both a first upload and an update: length, then the
// compile-and-check-exports pass in src/moduleValidator.js. Returns an error
// payload, or null when the source is acceptable.
function checkSource(source, label) {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { error: 'The module code is empty.' }
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    return { error: 'The module code is larger than 2MB.' }
  }
  const problems = validateModuleSource(source)
  if (problems.length) {
    return {
      error: problems.length === 1
        ? problems[0]
        : `This ${label} has ${problems.length} problems that would stop it loading.`,
      problems,
    }
  }
  return null
}

router.post('/modules', asyncHandler(async (req, res) => {
  const { name, description, price, source } = req.body || {}

  if (typeof name !== 'string' || name.trim().length < 3 || name.trim().length > 64) {
    return res.status(400).json({ error: 'Name must be 3-64 characters.' })
  }
  const priceNum = parseInt(price, 10)
  if (!Number.isInteger(priceNum) || priceNum < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative whole number.' })
  }

  // Nothing that cannot possibly load gets into the review queue. Checked
  // before anything is written, so a rejected module leaves no file behind.
  const problem = checkSource(source, 'module')
  if (problem) return res.status(400).json(problem)

  // Every module starts at 1.0.0 (see db.createModule's seeded changelog), so
  // the first file on disk is named for that version.
  const written = await writeModuleSource(source, {
    username: req.user.username,
    moduleName: name,
    version: '1.0.0',
  })

  const module_ = await db.createModule(req.user.id, {
    name: name.trim(),
    description: typeof description === 'string' ? description.trim().slice(0, 2000) : '',
    price: priceNum,
    fileName: written.fileName,
    filePath: written.filePath,
  })
  res.json(await serializeModule(module_, req.user))
}))

router.get('/modules/:id/source', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!canViewSource(req.user, m)) return res.status(403).json({ error: "Not allowed to view this module's source." })
  fs.readFile(m.filePath, 'utf8', (err, source) => {
    if (err) return res.status(500).json({ error: 'Could not read module source.' })
    res.json({ source })
  })
}))

router.post('/modules/:id/approve', requireModOrAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const updated = await db.setModuleStatus(m.id, 'approved', { reviewedBy: req.user.id })
  await logAudit(req.user.id, 'approve_module', 'module', m.id, { name: m.name })
  res.json(await serializeModule(updated, req.user))
}))

router.post('/modules/:id/reject', requireModOrAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
  const updated = await db.setModuleStatus(m.id, 'rejected', { reviewedBy: req.user.id, rejectionReason: reason })
  await logAudit(req.user.id, 'reject_module', 'module', m.id, { name: m.name, reason })
  res.json(await serializeModule(updated, req.user))
}))

router.post('/modules/:id/pause', requireAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
  const updated = await db.setModulePaused(m.id, true, { reason, byUserId: req.user.id })

  // Blocking new loads was never enough on its own: a module already running
  // on someone's bot kept running, which is precisely what a pause is for.
  // Pull it out of every live connection now.
  const affected = await botManager.unloadModuleEverywhere(m.id)

  // Tell the author, and tell anyone whose running bot just lost it.
  await db.createNotification({
    userId: m.ownerId,
    type: 'module_paused',
    title: `An admin paused your module "${m.name}"`,
    body: reason
      ? `Reason: ${reason}`
      : 'No reason was given. It cannot be bought or loaded until it is unpaused.',
    link: `/marketplace/module/${m.id}`,
    actorId: req.user.id,
  })

  const notifiedOwners = new Set([m.ownerId])
  for (const conn of affected) {
    if (notifiedOwners.has(conn.ownerUserId)) continue
    notifiedOwners.add(conn.ownerUserId)
    await db.createNotification({
      userId: conn.ownerUserId,
      type: 'module_paused',
      title: `"${m.name}" was unloaded from your bot`,
      body: `An admin paused the module${reason ? `: ${reason}` : '.'}`,
      link: '/client',
      actorId: req.user.id,
    })
  }

  await logAudit(req.user.id, 'pause_module', 'module', m.id, { name: m.name, reason, unloadedFrom: affected.length })
  res.json({ ...await serializeModule(updated, req.user), unloadedFrom: affected.length })
}))

router.post('/modules/:id/unpause', requireAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const updated = await db.setModulePaused(m.id, false)
  await logAudit(req.user.id, 'unpause_module', 'module', m.id, { name: m.name })
  res.json(await serializeModule(updated, req.user))
}))

// Hide a module from the marketplace without deleting it. Owner-or-admin,
// matching the at-risk flag below. Demo modules can't be hidden - they're
// first-party documentation, and an admin who genuinely wants one gone can
// delete it instead.
router.post('/modules/:id/private', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!isOwner(req.user, m) && !roles.isAdmin(req.user)) {
    return res.status(403).json({ error: 'Only the module owner or an admin can change this.' })
  }
  if (m.isDemo) {
    return res.status(400).json({ error: 'Demo modules are always public.' })
  }
  const isPrivate = !!req.body?.isPrivate
  const updated = await db.setModulePrivate(m.id, isPrivate)
  await logAudit(req.user.id, isPrivate ? 'make_module_private' : 'make_module_public', 'module', m.id, { name: m.name })
  res.json(await serializeModule(updated, req.user))
}))

router.post('/modules/:id/at-risk', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!isOwner(req.user, m) && !roles.isAdmin(req.user)) {
    return res.status(403).json({ error: 'Only the module owner or an admin can set this.' })
  }
  const { atRisk, reason } = req.body || {}
  const updated = await db.setModuleAtRisk(m.id, !!atRisk, {
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    byUserId: req.user.id,
  })
  await logAudit(req.user.id, updated.atRisk ? 'flag_module_at_risk' : 'clear_module_at_risk', 'module', m.id, { name: m.name, reason: updated.atRiskReason })
  res.json(await serializeModule(updated, req.user))
}))

router.post('/modules/:id/revert', requireAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const { changelogIndex } = req.body || {}
  const idx = parseInt(changelogIndex, 10)
  const entry = Array.isArray(m.changelog) ? m.changelog[idx] : null
  if (!Number.isInteger(idx) || !entry || !entry.filePath) {
    return res.status(400).json({ error: 'Unknown or unrevertable changelog entry.' })
  }
  if (!fs.existsSync(entry.filePath)) {
    return res.status(400).json({ error: 'That version\'s file is no longer available on disk.' })
  }
  const updated = await db.revertModuleToChangelogEntry(m.id, { version: entry.version, fileName: entry.fileName, filePath: entry.filePath }, req.user.id)
  await logAudit(req.user.id, 'revert_module_version', 'module', m.id, { name: m.name, toVersion: entry.version })
  res.json(await serializeModule(updated, req.user))
}))

router.delete('/modules/:id', requireAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const ownerUsername = (await db.findUserById(m.ownerId))?.username
  const pendingUpdates = await db.listModuleUpdates(m.id)
  await db.deleteModule(m.id)

  // Everything about this module (and its history) is gone from the DB at
  // this point - clean up its on-disk files too rather than leaving them
  // as permanent orphans (unlike a routine update, where the old file is
  // kept around for possible rollback of a module that still exists).
  const filePaths = new Set([
    m.filePath,
    ...(m.changelog || []).map((c) => c.filePath).filter(Boolean),
    ...pendingUpdates.map((u) => u.filePath).filter(Boolean),
  ])
  for (const p of filePaths) fs.unlink(p, () => {})
  for (const item of m.media || []) fs.unlink(path.join(config.moduleMediaDir, item.filename), () => {})

  await logAudit(req.user.id, 'delete_module', 'module', m.id, { name: m.name, ownerUsername })
  res.json({ ok: true })
}))

router.post('/modules/:id/buy', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m || m.status !== 'approved') return res.status(404).json({ error: 'Module not available.' })
  // Going private stops new sales; it doesn't touch existing purchases.
  if (m.isPrivate) return res.status(404).json({ error: 'Module not available.' })
  if (m.paused) return res.status(400).json({ error: `This module is paused: ${m.pauseReason || 'no reason given'}` })
  if (m.ownerId === req.user.id || await db.hasPurchased(m.id, req.user.id)) {
    return res.status(400).json({ error: 'You already own this module.' })
  }
  if ((req.user.credits || 0) < m.price) {
    return res.status(400).json({ error: 'Not enough credits. Ask an admin to grant you more.' })
  }

  // The uploader gets a cut of every purchase (admin-configurable on the
  // Website Settings admin panel, default 80%) - credits otherwise only
  // ever move buyer -> nowhere, which never rewarded module authors.
  const payoutRate = await db.getSystemSetting('marketplacePayoutRate', 0.8)
  const payout = Math.floor(m.price * payoutRate)

  await db.adjustUserCredits(req.user.id, -m.price)
  if (payout > 0) await db.adjustUserCredits(m.ownerId, payout)
  await db.createPurchase(m.id, req.user.id, m.price, payout)

  // Tell the author. Their own free demo/self-owned modules never reach here
  // (buying your own is rejected above), so this only fires for real sales.
  const totalUsers = await db.countPurchasesForModule(m.id)
  await db.createNotification({
    userId: m.ownerId,
    type: 'module_purchase',
    title: m.price > 0
      ? `${req.user.username} bought "${m.name}" for ${m.price} credits`
      : `${req.user.username} added your free module "${m.name}"`,
    body: payout > 0
      ? `You earned ${payout} credits. That's ${totalUsers} user${totalUsers === 1 ? '' : 's'} in total.`
      : `That's ${totalUsers} user${totalUsers === 1 ? '' : 's'} in total.`,
    link: `/marketplace/module/${m.id}`,
    actorId: req.user.id,
  })

  const refreshed = await db.findUserById(req.user.id)
  res.json({ ok: true, credits: refreshed.credits, module: await serializeModule(m, refreshed) })
}))

// ---- media (screenshots/clips shown on the module's own page) ----

router.post('/modules/:id/media', (req, res, next) => {
  uploadMedia.single('media')(req, res, (uploadErr) => {
    (async () => {
      const m = await db.findModuleById(req.params.id)
      if (!m) {
        if (req.file) fs.unlink(req.file.path, () => {})
        return res.status(404).json({ error: 'Module not found.' })
      }
      if (!isOwner(req.user, m)) {
        if (req.file) fs.unlink(req.file.path, () => {})
        return res.status(403).json({ error: 'Only the module owner can edit this.' })
      }
      if (uploadErr) return res.status(400).json({ error: uploadErr.message })
      if (!req.file) return res.status(400).json({ error: 'A media file is required.' })
      if ((m.media || []).length >= MAX_MEDIA_PER_MODULE) {
        fs.unlink(req.file.path, () => {})
        return res.status(400).json({ error: `A module can have at most ${MAX_MEDIA_PER_MODULE} images/videos - remove one first.` })
      }
      const filename = path.basename(req.file.path)
      const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image'
      const media = [...(m.media || []), { type, url: `/module-media/${filename}`, filename }]
      const updated = await db.setModuleMedia(m.id, media)
      res.json(await serializeModule(updated, req.user))
    })().catch(next)
  })
})

router.delete('/modules/:id/media/:filename', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!isOwner(req.user, m)) return res.status(403).json({ error: 'Only the module owner can edit this.' })
  const media = (m.media || []).filter((item) => item.filename !== req.params.filename)
  if (media.length === (m.media || []).length) return res.status(404).json({ error: 'Media item not found.' })
  const updated = await db.setModuleMedia(m.id, media)
  fs.unlink(path.join(config.moduleMediaDir, req.params.filename), () => {})
  res.json(await serializeModule(updated, req.user))
}))

// ---- versioning / update approval ----

router.post('/modules/:id/updates', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!isOwner(req.user, m)) {
    return res.status(403).json({ error: 'Only the module owner can submit updates.' })
  }

  const { version, changelogNotes, source } = req.body || {}
  if (typeof version !== 'string' || !version.trim() || version.trim().length > 32) {
    return res.status(400).json({ error: 'Version is required (max 32 characters).' })
  }

  // Same gate as a first upload - an update that can't parse would replace a
  // working module with a broken one the moment it's approved.
  const problem = checkSource(source, 'update')
  if (problem) return res.status(400).json(problem)

  // Named for the module's owner rather than the submitter - only the owner
  // can submit updates, so they are the same person, and keeping every
  // version of a module under one owner prefix keeps the directory sorted by
  // whose code it is.
  const written = await writeModuleSource(source, {
    username: req.user.username,
    moduleName: m.name,
    version: version.trim(),
  })

  const update = await db.createModuleUpdate(m.id, req.user.id, {
    version: version.trim(),
    changelogNotes: typeof changelogNotes === 'string' ? changelogNotes.trim().slice(0, 2000) : '',
    fileName: written.fileName,
    filePath: written.filePath,
  })
  res.json(await serializeModuleUpdate(update))
}))

// The pending update's own source - separate from GET /modules/:id/source
// (the currently-live version) so an admin can read exactly what they're
// about to approve, not what's already running.
router.get('/modules/:id/updates/:updateId/source', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!canReviewModule(req.user, m)) return res.status(403).json({ error: "Not allowed to view this module's source." })
  const update = await db.findModuleUpdate(req.params.updateId)
  if (!update || update.moduleId !== m.id) return res.status(404).json({ error: 'Update not found.' })
  fs.readFile(update.filePath, 'utf8', (err, source) => {
    if (err) return res.status(500).json({ error: 'Could not read update source.' })
    res.json({ source })
  })
}))

// Line-level additions/removals between the currently-live source and this
// pending update's source (see src/lineDiff.js) - what "show what changes
// were made" on the approval screen is built from.
router.get('/modules/:id/updates/:updateId/diff', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!canReviewModule(req.user, m)) return res.status(403).json({ error: "Not allowed to view this module's source." })
  const update = await db.findModuleUpdate(req.params.updateId)
  if (!update || update.moduleId !== m.id) return res.status(404).json({ error: 'Update not found.' })
  let oldSource
  let newSource
  try {
    [oldSource, newSource] = await Promise.all([
      fs.promises.readFile(m.filePath, 'utf8'),
      fs.promises.readFile(update.filePath, 'utf8'),
    ])
  } catch {
    return res.status(500).json({ error: 'Could not read source for diff.' })
  }
  res.json(diffLines(oldSource, newSource))
}))

router.post('/modules/:id/updates/:updateId/approve', requireModOrAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const update = await db.findModuleUpdate(req.params.updateId)
  if (!update || update.moduleId !== m.id) return res.status(404).json({ error: 'Update not found.' })
  if (update.status !== 'pending') return res.status(400).json({ error: 'This update has already been reviewed.' })

  await db.setModuleUpdateStatus(update.id, 'approved', { reviewedBy: req.user.id })
  const updatedModule = await db.applyModuleUpdate(m.id, {
    version: update.version,
    changelogNotes: update.changelogNotes,
    fileName: update.fileName,
    filePath: update.filePath,
  })
  await logAudit(req.user.id, 'approve_module_update', 'module', m.id, { name: m.name, fromVersion: m.version, toVersion: update.version })
  res.json(await serializeModule(updatedModule, req.user))
}))

router.post('/modules/:id/updates/:updateId/reject', requireModOrAdmin, asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  const update = await db.findModuleUpdate(req.params.updateId)
  if (!update || update.moduleId !== req.params.id) return res.status(404).json({ error: 'Update not found.' })
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null
  const updated = await db.setModuleUpdateStatus(update.id, 'rejected', { reviewedBy: req.user.id, rejectionReason: reason })
  await logAudit(req.user.id, 'reject_module_update', 'module', req.params.id, { name: m?.name, toVersion: update.version, reason })
  res.json(await serializeModuleUpdate(updated))
}))

// ---- reviews (purchasers only, one per user per module) ----

router.post('/modules/:id/reviews', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!(await db.hasPurchased(m.id, req.user.id)) && !isOwner(req.user, m)) {
    return res.status(403).json({ error: 'Only purchasers can review this module.' })
  }
  const { rating, body } = req.body || {}
  const ratingNum = parseInt(rating, 10)
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Rating must be 1-5.' })
  }
  if (body !== undefined && body !== null && (typeof body !== 'string' || body.length > 1000)) {
    return res.status(400).json({ error: 'Review text must be 1000 characters or fewer.' })
  }
  const review = await db.upsertModuleReview(m.id, req.user.id, { rating: ratingNum, body: typeof body === 'string' ? body.trim() : '' })
  res.json(review)
}))

// ---- discussion (purchasers only comments) ----

router.post('/modules/:id/comments', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!(await db.hasPurchased(m.id, req.user.id)) && !isOwner(req.user, m)) {
    return res.status(403).json({ error: 'Only purchasers can comment on this module.' })
  }
  const { body } = req.body || {}
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 2000) {
    return res.status(400).json({ error: 'Comment must be 1-2000 characters.' })
  }
  const comment = await db.createModuleComment(m.id, req.user.id, body.trim())
  res.json(await serializeComment(comment))
}))

router.delete('/modules/:id/comments/:commentId', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!canReviewModule(req.user, m)) return res.status(403).json({ error: 'Not allowed to remove this comment.' })
  const ok = await db.deleteModuleComment(req.params.commentId)
  if (!ok) return res.status(404).json({ error: 'Comment not found.' })
  res.json({ ok: true })
}))

// ---- bug reports (purchasers file, owner/mod/admin triage) ----

router.post('/modules/:id/bug-reports', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!(await db.hasPurchased(m.id, req.user.id)) && !isOwner(req.user, m)) {
    return res.status(403).json({ error: 'Only purchasers can file bug reports for this module.' })
  }
  const { title, body } = req.body || {}
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) {
    return res.status(400).json({ error: 'Title must be 3-120 characters.' })
  }
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 2000) {
    return res.status(400).json({ error: 'Description must be 1-2000 characters.' })
  }
  const report = await db.createModuleBugReport(m.id, req.user.id, { title: title.trim(), body: body.trim() })
  res.json(await serializeBugReport(report))
}))

router.post('/modules/:id/bug-reports/:reportId/resolve', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  if (!isOwner(req.user, m) && !canReviewModule(req.user, m)) {
    return res.status(403).json({ error: 'Only the module owner or a mod/admin can resolve this.' })
  }
  const status = req.body?.status === 'open' ? 'open' : 'resolved'
  const updated = await db.setModuleBugReportStatus(req.params.reportId, status)
  if (!updated) return res.status(404).json({ error: 'Bug report not found.' })
  res.json(await serializeBugReport(updated))
}))

// ---- abuse/policy reports (any authenticated user -> admins) ----

router.post('/modules/:id/report', asyncHandler(async (req, res) => {
  const m = await db.findModuleById(req.params.id)
  if (!m) return res.status(404).json({ error: 'Module not found.' })
  const { reason } = req.body || {}
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 1000) {
    return res.status(400).json({ error: 'Reason must be 3-1000 characters.' })
  }
  await db.createModuleReport(m.id, req.user.id, reason.trim())
  res.json({ ok: true })
}))

return router
}

module.exports = { createMarketplaceRoutes }
