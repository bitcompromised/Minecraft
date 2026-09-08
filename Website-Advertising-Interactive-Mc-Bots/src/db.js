const crypto = require('crypto')
const { getDb } = require('./mongo')
const config = require('./config')

function newId() {
  return crypto.randomUUID()
}

function col(name) {
  return getDb().collection(name)
}

// Every document keeps its own uuid `id` field (never Mongo's ObjectId) so
// the rest of the app - routes, sockets, the browser - never has to know
// this is backed by Mongo at all. This strips Mongo's internal _id before
// handing documents back out.
function clean(doc) {
  if (!doc) return null
  const { _id, ...rest } = doc
  return rest
}

function cleanAll(docs) {
  return docs.map(clean)
}

function inviteQuotaFor(status) {
  return config.inviteQuotaByStatus[status] ?? config.inviteQuotaByStatus.normal
}

const db = {
  // ---- users ----

  async findUserByUsername(username) {
    const doc = await col('users').findOne({ usernameLower: username.toLowerCase() })
    return clean(doc)
  },

  async findUserById(id) {
    const doc = await col('users').findOne({ id })
    return clean(doc)
  },

  async createUser({ username, passwordHash, role }) {
    const user = {
      id: newId(),
      username,
      usernameLower: username.toLowerCase(),
      email: null,
      passwordHash,
      role,
      status: 'normal',
      credits: 0,
      inviteQuota: inviteQuotaFor('normal'),
      paused: false,
      pauseReason: null,
      banned: false,
      banReason: null,
      banExpiresAt: null,
      bannedAt: null,
      bannedBy: null,
      avatarUrl: null,
      bio: null,
      tags: [],
      lastSelfPasswordChangeAt: null,
      createdAt: Date.now(),
    }
    await col('users').insertOne(user)
    return clean(user)
  },

  async userCount() {
    return col('users').countDocuments()
  },

  async listAllUsers() {
    return cleanAll(await col('users').find().toArray())
  },

  // True if the user is currently locked out (permanent ban, or a timed ban
  // that hasn't expired yet). A timed ban past its expiry is treated as not
  // banned without needing a cleanup job. Pure function - no DB access.
  isBannedNow(user) {
    if (!user || !user.banned) return false
    if (user.banExpiresAt === null) return true
    return user.banExpiresAt > Date.now()
  },

  async updateUserPassword(userId, passwordHash) {
    const result = await col('users').updateOne({ id: userId }, { $set: { passwordHash } })
    return result.matchedCount > 0
  },

  // Tracked separately from passwordHash/updateUserPassword above so the
  // once-per-day self-service rate limit (see routes/settings.js) only
  // applies to a user changing their own password - an admin resetting it
  // (routes/admin.js) doesn't touch this, and isn't limited by it either.
  async setLastSelfPasswordChangeAt(userId, timestamp) {
    await col('users').updateOne({ id: userId }, { $set: { lastSelfPasswordChangeAt: timestamp } })
  },

  async setUserEmail(userId, email) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { email: email || null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserCredits(userId, credits) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { credits: Math.max(0, Math.round(credits)) } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async adjustUserCredits(userId, delta) {
    const user = await db.findUserById(userId)
    if (!user) return null
    return db.setUserCredits(userId, (user.credits || 0) + delta)
  },

  async setUserInviteQuota(userId, quota) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { inviteQuota: Math.max(0, Math.round(quota)) } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // Sets the tier badge (normal/vip/mod) and resets invite quota to that
  // tier's default. Admins can still call setUserInviteQuota afterward to
  // override the value for an individual user.
  async setUserStatus(userId, status) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { status, inviteQuota: inviteQuotaFor(status) } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // 'user' | 'developer' | 'admin' - the structural staff axis, separate
  // from the status tier above (see src/roles.js).
  async setUserRole(userId, role) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { role } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserPaused(userId, paused, reason) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { paused: !!paused, pauseReason: paused ? (reason || null) : null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserAvatar(userId, avatarUrl) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { avatarUrl: avatarUrl || null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserBio(userId, bio) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { bio: bio || null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserTags(userId, tags) {
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: { tags } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setUserBan(userId, { banned, reason = null, durationMs = null, bannedBy = null }) {
    const update = banned
      ? { banned: true, banReason: reason, banExpiresAt: durationMs ? Date.now() + durationMs : null, bannedAt: Date.now(), bannedBy }
      : { banned: false, banReason: null, banExpiresAt: null, bannedAt: null, bannedBy: null }
    const result = await col('users').findOneAndUpdate(
      { id: userId },
      { $set: update },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- invites ----

  async createInvite(createdByUserId) {
    const invite = {
      id: newId(),
      code: crypto.randomBytes(12).toString('hex'),
      createdByUserId,
      usedByUserId: null,
      createdAt: Date.now(),
      usedAt: null,
    }
    await col('invites').insertOne(invite)
    return clean(invite)
  },

  async findInviteByCode(code) {
    return clean(await col('invites').findOne({ code }))
  },

  async markInviteUsed(code, userId) {
    await col('invites').updateOne({ code }, { $set: { usedByUserId: userId, usedAt: Date.now() } })
  },

  async listInvitesByUser(userId) {
    return cleanAll(await col('invites').find({ createdByUserId: userId }).toArray())
  },

  // Every invite a user has ever created counts against their quota, even
  // once used - only deleting an unused one frees a slot back up.
  async invitesUsedTowardQuota(userId) {
    return col('invites').countDocuments({ createdByUserId: userId })
  },

  async listReferralsByUser(userId) {
    const invites = await col('invites').find({ createdByUserId: userId, usedByUserId: { $ne: null } }).toArray()
    const referrals = []
    for (const invite of invites) {
      const user = await db.findUserById(invite.usedByUserId)
      referrals.push({ username: user ? user.username : '(deleted user)', joinedAt: invite.usedAt })
    }
    return referrals
  },

  async deleteInvite(id, userId) {
    const result = await col('invites').deleteOne({ id, createdByUserId: userId, usedAt: null })
    return result.deletedCount > 0
  },

  // The invite (if any) that this user registered through - used to show
  // "invited by" on the admin Users tab. Null for the bootstrap admin or
  // anyone whose invite record no longer exists.
  async findInviteByUsedUserId(userId) {
    return clean(await col('invites').findOne({ usedByUserId: userId }))
  },

  // ---- proxies ----

  async listProxiesByUser(userId) {
    return cleanAll(await col('proxies').find({ userId }).toArray())
  },

  async findProxy(id, userId) {
    if (!id) return null
    return clean(await col('proxies').findOne({ id, userId }))
  },

  async createProxy(userId, { name, type, host, port, username, password }) {
    const proxy = {
      id: newId(),
      userId,
      name,
      type,
      host,
      port,
      username: username || null,
      password: password || null,
      createdAt: Date.now(),
    }
    await col('proxies').insertOne(proxy)
    return clean(proxy)
  },

  async deleteProxy(id, userId) {
    const result = await col('proxies').deleteOne({ id, userId })
    return result.deletedCount > 0
  },

  // ---- saved servers ----

  async listServersByUser(userId) {
    return cleanAll(await col('servers').find({ userId }).toArray())
  },

  async findServer(id, userId) {
    if (!id) return null
    return clean(await col('servers').findOne({ id, userId }))
  },

  async createServer(userId, { name, host, port, version }) {
    const server = {
      id: newId(),
      userId,
      name,
      host,
      port,
      version: version || null,
      createdAt: Date.now(),
    }
    await col('servers').insertOne(server)
    return clean(server)
  },

  async deleteServer(id, userId) {
    const result = await col('servers').deleteOne({ id, userId })
    return result.deletedCount > 0
  },

  // ---- bot profiles ----

  async listBotProfilesByUser(userId) {
    return cleanAll(await col('botProfiles').find({ userId }).toArray())
  },

  async listAllBotProfiles() {
    return cleanAll(await col('botProfiles').find().toArray())
  },

  async findBotProfile(id, userId) {
    if (!id) return null
    return clean(await col('botProfiles').findOne({ id, userId }))
  },

  async findBotProfileById(id) {
    return clean(await col('botProfiles').findOne({ id }))
  },

  async createBotProfile(userId, profile) {
    const botProfile = { id: newId(), userId, notes: '', createdAt: Date.now(), ...profile }
    await col('botProfiles').insertOne(botProfile)
    return clean(botProfile)
  },

  async deleteBotProfile(id, userId) {
    const result = await col('botProfiles').deleteOne({ id, userId })
    return result.deletedCount > 0
  },

  async setBotProfileNotes(id, userId, notes) {
    const result = await col('botProfiles').findOneAndUpdate(
      { id, userId },
      { $set: { notes } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- marketplace modules ----
  // status: 'pending' | 'approved' | 'rejected'

  async createModule(ownerId, { name, description, price, fileName, filePath, isDemo = false, demoKey = null, isPrivate = false, status = 'pending' }) {
    const now = Date.now()
    const module_ = {
      id: newId(),
      ownerId,
      name,
      description,
      price,
      fileName,
      filePath,
      // Demo modules are the free, first-party examples seeded at startup
      // (see src/bootstrap.js). Their source is readable by anyone, not just
      // owners/staff, since reading them is the entire point.
      isDemo: !!isDemo,
      demoKey,
      // Private modules stay out of the browse list and can't be bought.
      // Whoever already owns one keeps it and can still load it.
      isPrivate: !!isPrivate,
      version: '1.0.0',
      // Seeded with the initial release so every version this module has
      // ever had (including v1.0.0) is revertible via
      // revertModuleToChangelogEntry - not just versions submitted through
      // an update.
      changelog: [{ version: '1.0.0', notes: 'Initial release.', approvedAt: now, fileName, filePath }],
      media: [],
      status,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      paused: false,
      pauseReason: null,
      pausedBy: null,
      pausedAt: null,
      // "At risk" is a distinct, more visible flag than pause - meant for a
      // known security/abuse concern (self-reported by the owner, or set by
      // an admin), not routine moderation. See setModuleAtRisk below.
      atRisk: false,
      atRiskReason: null,
      atRiskBy: null,
      atRiskAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await col('modules').insertOne(module_)
    return clean(module_)
  },

  async findModuleById(id) {
    if (!id) return null
    return clean(await col('modules').findOne({ id }))
  },

  async listApprovedModules() {
    return cleanAll(await col('modules').find({ status: 'approved' }).toArray())
  },

  async listModulesByOwner(ownerId) {
    return cleanAll(await col('modules').find({ ownerId }).toArray())
  },

  async listPendingModules() {
    return cleanAll(await col('modules').find({ status: 'pending' }).toArray())
  },

  async findModuleByDemoKey(demoKey) {
    return clean(await col('modules').findOne({ demoKey }))
  },

  // Private modules are hidden from the marketplace browse list and can no
  // longer be purchased. Existing purchases are untouched - whoever already
  // owns it keeps it, and can still load it onto a bot.
  async setModulePrivate(id, isPrivate) {
    const result = await col('modules').findOneAndUpdate(
      { id },
      { $set: { isPrivate: !!isPrivate, updatedAt: Date.now() } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setModuleStatus(id, status, { reviewedBy, rejectionReason = null } = {}) {
    const result = await col('modules').findOneAndUpdate(
      { id },
      { $set: { status, reviewedBy, reviewedAt: Date.now(), rejectionReason } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setModulePaused(id, paused, { reason = null, byUserId = null } = {}) {
    const update = paused
      ? { paused: true, pauseReason: reason, pausedBy: byUserId, pausedAt: Date.now() }
      : { paused: false, pauseReason: null, pausedBy: null, pausedAt: null }
    const result = await col('modules').findOneAndUpdate(
      { id },
      { $set: update },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async setModuleMedia(id, media) {
    const result = await col('modules').findOneAndUpdate(
      { id },
      { $set: { media, updatedAt: Date.now() } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // Settable by the module's own owner (self-reporting a concern they
  // found) or an admin - deliberately not mod-eligible, same tier as pause.
  async setModuleAtRisk(id, atRisk, { reason = null, byUserId = null } = {}) {
    const update = atRisk
      ? { atRisk: true, atRiskReason: reason, atRiskBy: byUserId, atRiskAt: Date.now() }
      : { atRisk: false, atRiskReason: null, atRiskBy: null, atRiskAt: null }
    const result = await col('modules').findOneAndUpdate({ id }, { $set: update }, { returnDocument: 'after' })
    return clean(result)
  },

  // Hard delete (admin-only, see routes/marketplace.js) - cascades to
  // everything scoped to this one module (update submissions, reviews,
  // discussion comments, bug reports, abuse reports). Purchase records are
  // deliberately NOT deleted - they're the transaction history/earnings
  // ledger and should survive a module's removal.
  async deleteModule(id) {
    const result = await col('modules').deleteOne({ id })
    await Promise.all([
      col('moduleUpdates').deleteMany({ moduleId: id }),
      col('moduleReviews').deleteMany({ moduleId: id }),
      col('moduleComments').deleteMany({ moduleId: id }),
      col('moduleBugReports').deleteMany({ moduleId: id }),
      col('moduleReports').deleteMany({ moduleId: id }),
    ])
    return result.deletedCount > 0
  },

  // Reverts the module's live file/version back to an earlier changelog
  // entry (see applyModuleUpdate's fileName/filePath now stored per entry)
  // without erasing history - pushes a new "reverted to vX" changelog
  // entry rather than deleting the entries in between, so the changelog
  // always reads forward-only, same as a normal update.
  async revertModuleToChangelogEntry(moduleId, { version, fileName, filePath }, revertedBy) {
    const now = Date.now()
    const result = await col('modules').findOneAndUpdate(
      { id: moduleId },
      {
        $set: { version, fileName, filePath, updatedAt: now },
        $push: { changelog: { version, notes: `Reverted to v${version} by admin.`, approvedAt: now, fileName, filePath, revertedBy } },
      },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- module update submissions (versioning/changelog approval) ----

  async createModuleUpdate(moduleId, submittedBy, { version, changelogNotes, fileName, filePath }) {
    const update = {
      id: newId(),
      moduleId,
      submittedBy,
      version,
      changelogNotes,
      fileName,
      filePath,
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: Date.now(),
    }
    await col('moduleUpdates').insertOne(update)
    return clean(update)
  },

  async findModuleUpdate(id) {
    if (!id) return null
    return clean(await col('moduleUpdates').findOne({ id }))
  },

  async listModuleUpdates(moduleId) {
    return cleanAll(await col('moduleUpdates').find({ moduleId }).sort({ createdAt: -1 }).toArray())
  },

  async listPendingModuleUpdates() {
    return cleanAll(await col('moduleUpdates').find({ status: 'pending' }).toArray())
  },

  async setModuleUpdateStatus(id, status, { reviewedBy, rejectionReason = null } = {}) {
    const result = await col('moduleUpdates').findOneAndUpdate(
      { id },
      { $set: { status, reviewedBy, reviewedAt: Date.now(), rejectionReason } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // Approving an update makes it the module's live version: swaps in the
  // new file, bumps the version string, and appends a changelog entry -
  // the previous file is left on disk (still referenced by the changelog)
  // rather than deleted, in case it's ever needed for a rollback/review.
  async applyModuleUpdate(moduleId, { version, changelogNotes, fileName, filePath }) {
    const now = Date.now()
    const result = await col('modules').findOneAndUpdate(
      { id: moduleId },
      {
        $set: { version, fileName, filePath, updatedAt: now },
        $push: { changelog: { version, notes: changelogNotes, approvedAt: now, fileName, filePath } },
      },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- marketplace purchases ----

  async createPurchase(moduleId, buyerId, price, sellerPayout = 0) {
    // archivedAt is set (not deleted) when an admin clears the sales figures
    // - see clearModuleSales. Explicitly null here so the aggregation's
    // { archivedAt: null } match works on rows written before the field
    // existed as well as new ones.
    const purchase = { id: newId(), moduleId, buyerId, price, sellerPayout, purchasedAt: Date.now(), archivedAt: null }
    await col('purchases').insertOne(purchase)
    return clean(purchase)
  },

  async hasPurchased(moduleId, buyerId) {
    const count = await col('purchases').countDocuments({ moduleId, buyerId })
    return count > 0
  },

  async listPurchasedModuleIds(buyerId) {
    const purchases = await col('purchases').find({ buyerId }).toArray()
    return purchases.map((p) => p.moduleId)
  },

  async countPurchasesForModule(moduleId) {
    return col('purchases').countDocuments({ moduleId })
  },

  // Full transaction history for one module (owner/mod/admin view) -
  // newest first.
  async listPurchasesForModule(moduleId) {
    return cleanAll(await col('purchases').find({ moduleId }).sort({ purchasedAt: -1 }).toArray())
  },

  // Every purchase a user has ever made, across every module - their own
  // transaction history (Settings/profile-adjacent, not admin-only).
  async listPurchasesByBuyer(buyerId) {
    return cleanAll(await col('purchases').find({ buyerId }).sort({ purchasedAt: -1 }).toArray())
  },

  // Total sellerPayout this user has earned across every module they own -
  // resolves owned module ids first, then sums purchases against that set
  // in one aggregation rather than per-module round trips.
  // Resets the sales figures on the monitoring page.
  //
  // Purchases are NOT deleted: the same collection is what hasPurchased()
  // reads to decide who owns a module, so deleting rows would silently strip
  // every buyer of everything they'd paid for. They're marked archived
  // instead - ownership and earnings history stay intact, and only the
  // reporting aggregates below skip them.
  async clearModuleSales() {
    const result = await col('purchases').updateMany(
      { archivedAt: null },
      { $set: { archivedAt: Date.now() } }
    )
    return result.modifiedCount
  },

  async sumEarningsForOwner(ownerId) {
    const moduleIds = (await col('modules').find({ ownerId }).project({ id: 1 }).toArray()).map((m) => m.id)
    if (moduleIds.length === 0) return 0
    const [result] = await col('purchases').aggregate([
      { $match: { moduleId: { $in: moduleIds } } },
      { $group: { _id: null, total: { $sum: '$sellerPayout' } } },
    ]).toArray()
    return result?.total || 0
  },

  // ---- module reviews (purchasers only, one per user per module) ----

  async upsertModuleReview(moduleId, userId, { rating, body }) {
    const now = Date.now()
    await col('moduleReviews').updateOne(
      { moduleId, userId },
      { $set: { rating, body, updatedAt: now }, $setOnInsert: { id: newId(), moduleId, userId, createdAt: now } },
      { upsert: true }
    )
    return clean(await col('moduleReviews').findOne({ moduleId, userId }))
  },

  async listModuleReviews(moduleId) {
    return cleanAll(await col('moduleReviews').find({ moduleId }).sort({ createdAt: -1 }).toArray())
  },

  async findModuleReview(moduleId, userId) {
    return clean(await col('moduleReviews').findOne({ moduleId, userId }))
  },

  // ---- module discussion (purchasers only comments, separate from reviews) ----

  async createModuleComment(moduleId, authorId, body) {
    const comment = { id: newId(), moduleId, authorId, body, createdAt: Date.now() }
    await col('moduleComments').insertOne(comment)
    return clean(comment)
  },

  async listModuleComments(moduleId) {
    return cleanAll(await col('moduleComments').find({ moduleId }).sort({ createdAt: 1 }).toArray())
  },

  async deleteModuleComment(id) {
    const result = await col('moduleComments').deleteOne({ id })
    return result.deletedCount > 0
  },

  // ---- module bug reports (purchasers file, owner/mod/admin triage) ----

  async createModuleBugReport(moduleId, reporterId, { title, body }) {
    const report = { id: newId(), moduleId, reporterId, title, body, status: 'open', createdAt: Date.now(), resolvedAt: null }
    await col('moduleBugReports').insertOne(report)
    return clean(report)
  },

  async listModuleBugReports(moduleId) {
    return cleanAll(await col('moduleBugReports').find({ moduleId }).sort({ createdAt: -1 }).toArray())
  },

  async setModuleBugReportStatus(id, status) {
    const result = await col('moduleBugReports').findOneAndUpdate(
      { id },
      { $set: { status, resolvedAt: status === 'resolved' ? Date.now() : null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- forum abuse/policy reports (any user -> staff) ----
  // Deliberately a separate collection from moduleReports above: the target
  // is a thread or a post, and the admin queue shows them side by side but
  // resolves them independently.

  async createForumReport(reporterId, { targetType, targetId, threadId, reason }) {
    const report = {
      id: newId(),
      reporterId,
      targetType, // 'thread' | 'post'
      targetId,
      threadId,
      reason,
      status: 'open',
      createdAt: Date.now(),
      resolvedAt: null,
      resolvedBy: null,
    }
    await col('forumReports').insertOne(report)
    return clean(report)
  },

  async listOpenForumReports() {
    return cleanAll(await col('forumReports').find({ status: 'open' }).sort({ createdAt: -1 }).toArray())
  },

  async setForumReportStatus(id, status, resolvedBy) {
    const result = await col('forumReports').findOneAndUpdate(
      { id },
      { $set: { status, resolvedAt: status === 'resolved' ? Date.now() : null, resolvedBy: resolvedBy || null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- notifications ----
  // In-app only: someone replied to your thread, quoted your post, or staff
  // issued you a warning. Each carries a link the bell menu navigates to.

  async createNotification({ userId, type, title, body = '', link = null, actorId = null }) {
    const notification = {
      id: newId(),
      userId,
      type, // 'thread_reply' | 'post_reply' | 'warning'
      title,
      body,
      link,
      actorId,
      readAt: null,
      createdAt: Date.now(),
    }
    await col('notifications').insertOne(notification)
    return clean(notification)
  },

  async listNotificationsForUser(userId, limit = 50) {
    return cleanAll(await col('notifications').find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray())
  },

  async countUnreadNotifications(userId) {
    return col('notifications').countDocuments({ userId, readAt: null })
  },

  async markNotificationsRead(userId, ids = null) {
    const filter = { userId, readAt: null }
    if (Array.isArray(ids) && ids.length) filter.id = { $in: ids }
    const result = await col('notifications').updateMany(filter, { $set: { readAt: Date.now() } })
    return result.modifiedCount
  },

  async deleteNotificationsForUser(userId) {
    const result = await col('notifications').deleteMany({ userId })
    return result.deletedCount
  },

  // Scoped to the owner as well as the ids, so one user can never dismiss
  // another's notifications by guessing an id.
  async deleteNotifications(userId, ids) {
    const result = await col('notifications').deleteMany({ userId, id: { $in: ids } })
    return result.deletedCount
  },

  // ---- warnings ----
  // Staff-issued, always tied to a piece of content (a thread, a post, or a
  // module) whose text is snapshotted into quotedContent at issue time - the
  // original can be edited or deleted afterwards, and the warning still has
  // to show what it was actually about.

  async createWarning({ userId, issuedBy, targetType, targetId, quotedContent, staffNote, link = null }) {
    const warning = {
      id: newId(),
      userId,
      issuedBy,
      targetType, // 'thread' | 'post' | 'module' | 'other'
      targetId,
      quotedContent,
      staffNote,
      link,
      acknowledgedAt: null,
      revokedAt: null,
      revokedBy: null,
      createdAt: Date.now(),
    }
    await col('warnings').insertOne(warning)
    return clean(warning)
  },

  async listWarningsForUser(userId) {
    return cleanAll(await col('warnings').find({ userId }).sort({ createdAt: -1 }).toArray())
  },

  async listAllWarnings() {
    return cleanAll(await col('warnings').find().sort({ createdAt: -1 }).toArray())
  },

  // Only warnings that still count toward the auto-punishment thresholds -
  // a revoked warning stays on the record but stops counting.
  async countActiveWarnings(userId) {
    return col('warnings').countDocuments({ userId, revokedAt: null })
  },

  async findWarningById(id) {
    return clean(await col('warnings').findOne({ id }))
  },

  async acknowledgeWarning(id, userId) {
    const result = await col('warnings').findOneAndUpdate(
      { id, userId },
      { $set: { acknowledgedAt: Date.now() } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async revokeWarning(id, revokedBy) {
    const result = await col('warnings').findOneAndUpdate(
      { id },
      { $set: { revokedAt: Date.now(), revokedBy } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- module abuse/policy reports (any user -> admins) ----

  async createModuleReport(moduleId, reporterId, reason) {
    const report = { id: newId(), moduleId, reporterId, reason, status: 'open', createdAt: Date.now(), resolvedAt: null, resolvedBy: null }
    await col('moduleReports').insertOne(report)
    return clean(report)
  },

  async listOpenModuleReports() {
    return cleanAll(await col('moduleReports').find({ status: 'open' }).sort({ createdAt: -1 }).toArray())
  },

  async listModuleReports(moduleId) {
    return cleanAll(await col('moduleReports').find({ moduleId }).sort({ createdAt: -1 }).toArray())
  },

  async setModuleReportStatus(id, status, resolvedBy) {
    const result = await col('moduleReports').findOneAndUpdate(
      { id },
      { $set: { status, resolvedAt: status === 'resolved' ? Date.now() : null, resolvedBy: status === 'resolved' ? resolvedBy : null } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  // ---- error logs ----

  async addErrorLog({ level = 'error', message, userId = null, botProfileId = null }) {
    const entry = { id: newId(), level, message, userId, botProfileId, createdAt: Date.now() }
    await col('errorLogs').insertOne(entry)
    // Keep the log from growing unbounded on a long-running server.
    const total = await col('errorLogs').countDocuments()
    if (total > 2000) {
      const toRemove = await col('errorLogs')
        .find()
        .sort({ createdAt: 1 })
        .limit(total - 2000)
        .toArray()
      await col('errorLogs').deleteMany({ id: { $in: toRemove.map((e) => e.id) } })
    }
    return clean(entry)
  },

  // Returns everything up to the 2000-entry cap already enforced in
  // addErrorLog, newest first - callers paginate/filter over this in memory.
  async listErrorLogs() {
    return cleanAll(await col('errorLogs').find().sort({ createdAt: -1 }).toArray())
  },

  // ---- forum ----
  // sections: 'marketplace' | 'reviews' | 'discussion' | 'bugs' | 'admin'
  // (the 'admin' section is access-gated in routes/forum.js, not here)

  // Creates a thread and its first post together - a thread never exists
  // without at least one post.
  async createForumThread(section, authorId, { title, body }) {
    const now = Date.now()
    const thread = { id: newId(), section, authorId, title, pinned: false, locked: false, views: 0, editedAt: null, createdAt: now, lastPostAt: now }
    await col('forumThreads').insertOne(thread)
    await col('forumPosts').insertOne({ id: newId(), threadId: thread.id, authorId, body, replyToId: null, pinned: false, editedAt: null, createdAt: now })
    return clean(thread)
  },

  // Thread author or a mod/admin (checked in routes/forum.js) renaming
  // their own thread - just the title, since the thread's "body" is really
  // its first post and already editable through editForumPost below.
  async editForumThreadTitle(id, title) {
    const result = await col('forumThreads').findOneAndUpdate(
      { id },
      { $set: { title, editedAt: Date.now() } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async listForumThreads(section) {
    return cleanAll(await col('forumThreads').find({ section }).sort({ pinned: -1, lastPostAt: -1 }).toArray())
  },

  // Every section a user has started threads/posted in, newest first -
  // routes/users.js filters this down by section access (a normal user
  // can't see another user's threads in the mod-only 'admin' section, for
  // instance) before it ever reaches a profile page response.
  async listForumThreadsByAuthor(authorId) {
    return cleanAll(await col('forumThreads').find({ authorId }).sort({ createdAt: -1 }).toArray())
  },

  async listForumPostsByAuthor(authorId) {
    return cleanAll(await col('forumPosts').find({ authorId }).sort({ createdAt: -1 }).toArray())
  },

  async findForumThread(id) {
    if (!id) return null
    return clean(await col('forumThreads').findOne({ id }))
  },

  async incrementForumThreadViews(id) {
    await col('forumThreads').updateOne({ id }, { $inc: { views: 1 } })
  },

  async countForumPosts(threadId) {
    return col('forumPosts').countDocuments({ threadId })
  },

  async createForumPost(threadId, authorId, body, replyToId = null) {
    const post = { id: newId(), threadId, authorId, body, replyToId, pinned: false, editedAt: null, createdAt: Date.now() }
    await col('forumPosts').insertOne(post)
    await col('forumThreads').updateOne({ id: threadId }, { $set: { lastPostAt: post.createdAt } })
    return clean(post)
  },

  // Post author or a mod/admin (checked in routes/forum.js) editing their
  // own reply/OP body - editedAt drives the "(edited)" marker in the UI.
  async editForumPost(id, body) {
    const result = await col('forumPosts').findOneAndUpdate(
      { id },
      { $set: { body, editedAt: Date.now() } },
      { returnDocument: 'after' }
    )
    return clean(result)
  },

  async listForumPosts(threadId) {
    return cleanAll(await col('forumPosts').find({ threadId }).sort({ pinned: -1, createdAt: 1 }).toArray())
  },

  async findForumPost(id) {
    if (!id) return null
    return clean(await col('forumPosts').findOne({ id }))
  },

  async setForumThreadPinned(id, pinned) {
    const result = await col('forumThreads').findOneAndUpdate({ id }, { $set: { pinned: !!pinned } }, { returnDocument: 'after' })
    return clean(result)
  },

  async setForumPostPinned(id, pinned) {
    const result = await col('forumPosts').findOneAndUpdate({ id }, { $set: { pinned: !!pinned } }, { returnDocument: 'after' })
    return clean(result)
  },

  async setForumThreadLocked(id, locked) {
    const result = await col('forumThreads').findOneAndUpdate({ id }, { $set: { locked: !!locked } }, { returnDocument: 'after' })
    return clean(result)
  },

  async deleteForumThread(id) {
    await col('forumPosts').deleteMany({ threadId: id })
    const result = await col('forumThreads').deleteOne({ id })
    return result.deletedCount > 0
  },

  async deleteForumPost(id) {
    const result = await col('forumPosts').deleteOne({ id })
    return result.deletedCount > 0
  },

  // ---- private messaging ----
  // A conversation is just every message between two specific users - there
  // is no separate "conversation" document, so it's always derived (see
  // listConversationsForUser below) rather than stored.

  async createMessage(fromUserId, toUserId, body) {
    const message = { id: newId(), fromUserId, toUserId, body, createdAt: Date.now(), readAt: null }
    await col('messages').insertOne(message)
    return clean(message)
  },

  // Every message between these two users, oldest first - the thread view.
  // Also used to derive whether/when a user has ever messaged another.
  async listConversation(userId1, userId2) {
    return cleanAll(await col('messages').find({
      $or: [
        { fromUserId: userId1, toUserId: userId2 },
        { fromUserId: userId2, toUserId: userId1 },
      ],
    }).sort({ createdAt: 1 }).toArray())
  },

  // Marks every message *to* userId *from* otherUserId as read - called
  // when userId opens that conversation.
  async markConversationRead(userId, otherUserId) {
    await col('messages').updateMany(
      { fromUserId: otherUserId, toUserId: userId, readAt: null },
      { $set: { readAt: Date.now() } }
    )
  },

  // One row per distinct conversation partner, each with their most recent
  // message and how many of that partner's messages are still unread -
  // aggregated in Mongo rather than the load-everything-into-memory pattern
  // most other list endpoints in this app use, since a user could plausibly
  // have exchanged messages with many people and this only needs to run
  // this one small summary computation, not full pagination over raw rows.
  async listConversationsForUser(userId) {
    const rows = await col('messages').aggregate([
      { $match: { $or: [{ fromUserId: userId }, { toUserId: userId }] } },
      {
        $addFields: {
          partnerId: { $cond: [{ $eq: ['$fromUserId', userId] }, '$toUserId', '$fromUserId'] },
        },
      },
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: '$partnerId',
          lastMessage: { $last: '$body' },
          lastMessageAt: { $last: '$createdAt' },
          lastMessageFromUserId: { $last: '$fromUserId' },
          unreadCount: {
            $sum: { $cond: [{ $and: [{ $eq: ['$toUserId', userId] }, { $eq: ['$readAt', null] }] }, 1, 0] },
          },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]).toArray()
    return rows.map((r) => ({
      partnerId: r._id,
      lastMessage: r.lastMessage,
      lastMessageAt: r.lastMessageAt,
      lastMessageFromUserId: r.lastMessageFromUserId,
      unreadCount: r.unreadCount,
    }))
  },

  async countUnreadMessagesForUser(userId) {
    return col('messages').countDocuments({ toUserId: userId, readAt: null })
  },

  // Admin-only cross-user message search (see routes/admin.js) - every
  // private message ever sent, newest first. Deliberately not paginated at
  // the DB level (same in-memory filter+paginate pattern as every other
  // admin list endpoint) so search can match on resolved usernames, not
  // just raw ids.
  async listAllMessages() {
    return cleanAll(await col('messages').find().sort({ createdAt: -1 }).toArray())
  },

  // ---- module sandbox import allowlist ----
  // Names a module's require()/import may resolve inside its sandbox worker
  // (see src/sandboxWorker.js) - both Node builtins (e.g. 'util') and npm
  // package names already installed in this project. Admin-controlled.

  async listImportWhitelist() {
    return cleanAll(await col('importWhitelist').find().sort({ name: 1 }).toArray())
  },

  async addImportWhitelistEntry(name, addedBy) {
    const entry = { id: newId(), name, addedBy, createdAt: Date.now() }
    await col('importWhitelist').updateOne({ name }, { $setOnInsert: entry }, { upsert: true })
    return clean(await col('importWhitelist').findOne({ name }))
  },

  async removeImportWhitelistEntry(name) {
    const result = await col('importWhitelist').deleteOne({ name })
    return result.deletedCount > 0
  },

  // ---- website settings ----
  // Generic key/value store, same systemConfig collection mongo.js already
  // uses for the session secret (see getOrCreatePersistedValue) - this is
  // the plain get-or-default/set half for admin-editable settings.

  async getSystemSetting(key, defaultValue) {
    const doc = await col('systemConfig').findOne({ key })
    return doc ? doc.value : defaultValue
  },

  async setSystemSetting(key, value) {
    await col('systemConfig').updateOne({ key }, { $set: { key, value } }, { upsert: true })
    return value
  },

  // ---- admin audit log ----
  // Records every mutating admin/mod action (credits, status, pause, ban,
  // password reset, email/tags changes, website settings, import
  // allowlist, module approve/reject/pause) - see routes/admin.js's
  // logAudit() and routes/marketplace.js. `details` is a small plain
  // object describing what changed (old/new values, reason, etc.) -
  // never a password or other secret.

  async addAuditLogEntry({ actorId, action, targetType = null, targetId = null, details = null }) {
    const entry = { id: newId(), actorId, action, targetType, targetId, details, createdAt: Date.now() }
    await col('adminAuditLog').insertOne(entry)
    return clean(entry)
  },

  async listAuditLog() {
    return cleanAll(await col('adminAuditLog').find().sort({ createdAt: -1 }).toArray())
  },

  // ---- aggregate stats for the admin server-monitoring panel ----
  // Real Mongo aggregations rather than the load-everything-into-memory
  // pattern the rest of this app's list endpoints use - appropriate here
  // since these return a small handful of numbers, not a paginated list.

  async sumUserCredits() {
    const result = await col('users').aggregate([
      { $group: { _id: null, total: { $sum: '$credits' } } },
    ]).toArray()
    return result[0]?.total || 0
  },

  // Reporting only - archived purchases (see clearModuleSales) are excluded
  // here but still count for ownership everywhere else.
  async moduleSalesStats() {
    const live = { archivedAt: null }
    const [overall] = await col('purchases').aggregate([
      { $match: live },
      { $group: { _id: null, totalSales: { $sum: 1 }, totalRevenue: { $sum: '$price' }, totalPayout: { $sum: '$sellerPayout' } } },
    ]).toArray()
    const byModule = await col('purchases').aggregate([
      { $match: live },
      { $group: { _id: '$moduleId', sales: { $sum: 1 }, revenue: { $sum: '$price' }, payout: { $sum: '$sellerPayout' } } },
      { $sort: { revenue: -1 } },
    ]).toArray()
    return {
      totalSales: overall?.totalSales || 0,
      totalRevenue: overall?.totalRevenue || 0,
      totalPayout: overall?.totalPayout || 0,
      byModule: byModule.map((m) => ({ moduleId: m._id, sales: m.sales, revenue: m.revenue, payout: m.payout })),
    }
  },

  // ---- player sightings ----
  //
  // Who a bot has seen on a server, and when it first and last saw them.
  //
  // The live version of this lives in the connection's own child process
  // (botChild.js's seenPlayers) and dies with it, which made "who has this
  // bot seen" mean "since the last restart". These documents are the
  // durable record: one per (bot profile, server, player), accumulated
  // across every connection that profile has ever made to that server.
  //
  // Timestamps merge rather than overwrite - firstSeenAt only ever moves
  // earlier and lastSeenAt only ever moves later - so an older connection
  // reporting late (or a second connection to the same server) can never
  // narrow the window that is already recorded.

  async recordPlayerSightings(userId, botProfileId, serverId, entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0

    const now = Date.now()
    const operations = []

    for (const entry of entries) {
      const username = typeof entry?.username === 'string' ? entry.username.trim() : ''
      if (!username || username.length > 32) continue

      const firstSeenAt = Number.isFinite(entry.firstSeenAt) ? entry.firstSeenAt : now
      const lastSeenAt = Number.isFinite(entry.lastSeenAt) ? entry.lastSeenAt : now

      operations.push({
        updateOne: {
          filter: { botProfileId, serverId, usernameLower: username.toLowerCase() },
          update: {
            $setOnInsert: {
              id: newId(),
              botProfileId,
              serverId,
              userId,
              username,
              usernameLower: username.toLowerCase(),
            },
            $min: { firstSeenAt },
            $max: { lastSeenAt },
            // How many separate connections have seen this player at all -
            // "seen on 9 different sessions" is a different fact from "seen
            // over a 3-week window", and neither implies the other.
            $inc: { connections: entry.isNewThisConnection ? 1 : 0 },
          },
          upsert: true,
        },
      })
    }

    if (operations.length === 0) return 0
    // Unordered: one player failing (a racing upsert on the unique index)
    // must not stop the rest of the batch being recorded.
    const result = await col('playerSightings').bulkWrite(operations, { ordered: false })
    return (result.upsertedCount || 0) + (result.modifiedCount || 0)
  },

  async listPlayerSightings(botProfileId, serverId, { search = '', limit = 200, skip = 0 } = {}) {
    const query = { botProfileId, serverId }
    if (search) {
      // Anchored and escaped: a substring search here would otherwise let a
      // username like ".*" scan the whole collection.
      query.usernameLower = { $regex: `^${String(search).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }
    }
    const docs = await col('playerSightings')
      .find(query)
      .sort({ lastSeenAt: -1 })
      .skip(Math.max(0, skip))
      .limit(Math.min(1000, Math.max(1, limit)))
      .toArray()
    return cleanAll(docs)
  },

  async countPlayerSightings(botProfileId, serverId) {
    return col('playerSightings').countDocuments({ botProfileId, serverId })
  },

  async clearPlayerSightings(botProfileId, serverId) {
    const result = await col('playerSightings').deleteMany({ botProfileId, serverId })
    return result.deletedCount || 0
  },
}

module.exports = db
