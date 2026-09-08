// Warnings, and the automatic consequences that follow from them.
//
// A warning is always anchored to something a user actually wrote or
// uploaded: a forum thread, a forum post, or a marketplace module. The
// content is snapshotted into the warning at issue time (quotedContent), so
// editing or deleting the original afterwards doesn't erase what the warning
// was about. Every warning also carries a staff note explaining it, and the
// user is notified in-app.
//
// Thresholds are admin-configurable (see SETTINGS_SCHEMA in routes/admin.js):
// crossing warnThresholdPause pauses the account, crossing warnThresholdBan
// bans it for warnBanDurationHours (0 = permanent). Either threshold set to 0
// disables that step.

const db = require('./db')
const roles = require('./roles')
const { logAudit } = require('./audit')

const MAX_QUOTE_LENGTH = 2000
const MAX_NOTE_LENGTH = 1000

// Who may issue a warning: both staff roles plus the 'mod' status tier.
function canIssueWarnings(user) {
  return roles.isModOrAdmin(user)
}

function truncateQuote(text) {
  const str = String(text ?? '')
  return str.length > MAX_QUOTE_LENGTH ? `${str.slice(0, MAX_QUOTE_LENGTH)}…` : str
}

// Resolves the warning target to the user who owns it, a snapshot of its
// content, and a link back to it. Returns null when the target is gone.
async function resolveTarget(targetType, targetId) {
  if (targetType === 'thread') {
    const thread = await db.findForumThread(targetId)
    if (!thread) return null
    return {
      userId: thread.authorId,
      quotedContent: truncateQuote(`${thread.title}\n\n${thread.body || ''}`),
      link: `/forum/thread/${thread.id}`,
      label: `thread "${thread.title}"`,
    }
  }

  if (targetType === 'post') {
    const post = await db.findForumPost(targetId)
    if (!post) return null
    return {
      userId: post.authorId,
      quotedContent: truncateQuote(post.body),
      link: `/forum/thread/${post.threadId}`,
      label: 'a forum post',
    }
  }

  if (targetType === 'module') {
    const module_ = await db.findModuleById(targetId)
    if (!module_) return null
    return {
      userId: module_.ownerId,
      quotedContent: truncateQuote(`${module_.name}\n\n${module_.description || ''}`),
      link: `/marketplace/module/${module_.id}`,
      label: `module "${module_.name}"`,
    }
  }

  return null
}

// Issues the warning, notifies the user, and applies any threshold that the
// new total crosses. Returns { warning, activeCount, applied } where applied
// is null, 'paused', or 'banned'.
async function issueWarning(actor, { targetType, targetId, staffNote }) {
  const target = await resolveTarget(targetType, targetId)
  if (!target) throw new Error('That thread, post, or module no longer exists.')

  const recipient = await db.findUserById(target.userId)
  if (!recipient) throw new Error('The author of that content no longer has an account.')

  // Same rule as the rest of the admin panel: staff don't get to discipline
  // each other sideways. Only a full admin can warn another staff member.
  if (roles.isStaff(recipient) && !roles.isAdmin(actor)) {
    throw new Error('Only an admin can warn a staff account.')
  }
  if (recipient.id === actor.id) throw new Error('You cannot warn yourself.')

  const note = String(staffNote ?? '').trim()
  if (note.length < 3 || note.length > MAX_NOTE_LENGTH) {
    throw new Error(`The staff note must be 3-${MAX_NOTE_LENGTH} characters.`)
  }

  const warning = await db.createWarning({
    userId: recipient.id,
    issuedBy: actor.id,
    targetType,
    targetId,
    quotedContent: target.quotedContent,
    staffNote: note,
    link: target.link,
  })

  await db.createNotification({
    userId: recipient.id,
    type: 'warning',
    title: `You received a warning about ${target.label}`,
    body: note,
    link: '/settings#warnings',
    actorId: actor.id,
  })

  await logAudit(actor.id, 'warn_user', 'user', recipient.id, {
    username: recipient.username, targetType, targetId, note,
  })

  const applied = await applyThresholds(actor, recipient)
  return { warning, activeCount: await db.countActiveWarnings(recipient.id), applied }
}

// Pauses or bans the user if their active warning count has reached a
// configured threshold. The ban threshold wins when both are crossed.
async function applyThresholds(actor, recipient) {
  const count = await db.countActiveWarnings(recipient.id)
  const banAt = await db.getSystemSetting('warnThresholdBan', 4)
  const pauseAt = await db.getSystemSetting('warnThresholdPause', 2)

  if (banAt > 0 && count >= banAt) {
    const hours = await db.getSystemSetting('warnBanDurationHours', 168)
    const durationMs = hours > 0 ? hours * 60 * 60 * 1000 : null
    await db.setUserBan(recipient.id, {
      banned: true,
      reason: `Automatic ban: reached ${count} warnings.`,
      durationMs,
      bannedBy: actor.id,
    })
    await logAudit(actor.id, 'auto_ban_on_warnings', 'user', recipient.id, {
      username: recipient.username, warnings: count, durationHours: hours || null,
    })
    return 'banned'
  }

  if (pauseAt > 0 && count >= pauseAt && !recipient.paused) {
    await db.setUserPaused(recipient.id, true, `Automatic pause: reached ${count} warnings.`)
    await logAudit(actor.id, 'auto_pause_on_warnings', 'user', recipient.id, {
      username: recipient.username, warnings: count,
    })
    return 'paused'
  }

  return null
}

async function serializeWarning(w) {
  const issuer = await db.findUserById(w.issuedBy)
  return {
    id: w.id,
    targetType: w.targetType,
    targetId: w.targetId,
    quotedContent: w.quotedContent,
    staffNote: w.staffNote,
    link: w.link,
    issuedByUsername: issuer ? issuer.username : '(deleted user)',
    acknowledgedAt: w.acknowledgedAt,
    revokedAt: w.revokedAt,
    createdAt: w.createdAt,
  }
}

module.exports = {
  MAX_QUOTE_LENGTH,
  MAX_NOTE_LENGTH,
  canIssueWarnings,
  resolveTarget,
  issueWarning,
  serializeWarning,
}
