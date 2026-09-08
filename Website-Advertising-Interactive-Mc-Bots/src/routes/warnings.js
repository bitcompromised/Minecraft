const express = require('express')
const db = require('../db')
const roles = require('../roles')
const moderation = require('../moderation')
const { asyncHandler } = require('../asyncHandler')

// Staff issue warnings against a specific thread, post, or module; users read
// their own. The rules, the content snapshot, and the automatic
// pause/ban thresholds all live in src/moderation.js.
const router = express.Router()

// What a warning would quote, fetched before the staff member commits to it -
// the confirm dialog shows the exact text that will be attached.
router.get('/preview', asyncHandler(async (req, res) => {
  if (!moderation.canIssueWarnings(req.user)) {
    return res.status(403).json({ error: 'Moderators or admins only.' })
  }
  const { targetType, targetId } = req.query
  const target = await moderation.resolveTarget(targetType, targetId)
  if (!target) return res.status(404).json({ error: 'That thread, post, or module no longer exists.' })

  const recipient = await db.findUserById(target.userId)
  if (!recipient) return res.status(404).json({ error: 'That content has no author account.' })

  res.json({
    username: recipient.username,
    label: target.label,
    quotedContent: target.quotedContent,
    link: target.link,
    activeWarnings: await db.countActiveWarnings(recipient.id),
    thresholds: {
      pause: await db.getSystemSetting('warnThresholdPause', 2),
      ban: await db.getSystemSetting('warnThresholdBan', 4),
      banHours: await db.getSystemSetting('warnBanDurationHours', 168),
    },
  })
}))

router.post('/', asyncHandler(async (req, res) => {
  if (!moderation.canIssueWarnings(req.user)) {
    return res.status(403).json({ error: 'Moderators or admins only.' })
  }
  const { targetType, targetId, staffNote } = req.body || {}
  try {
    const result = await moderation.issueWarning(req.user, { targetType, targetId, staffNote })
    res.json({
      warning: await moderation.serializeWarning(result.warning),
      activeCount: result.activeCount,
      applied: result.applied,
    })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
}))

// A user's own warnings. Staff can read anyone's by passing ?username=.
router.get('/', asyncHandler(async (req, res) => {
  let targetUser = req.user
  if (req.query.username) {
    if (!moderation.canIssueWarnings(req.user)) {
      return res.status(403).json({ error: 'Moderators or admins only.' })
    }
    targetUser = await db.findUserByUsername(req.query.username)
    if (!targetUser) return res.status(404).json({ error: 'User not found.' })
  }
  const rows = await db.listWarningsForUser(targetUser.id)
  res.json({
    username: targetUser.username,
    warnings: await Promise.all(rows.map(moderation.serializeWarning)),
    activeCount: await db.countActiveWarnings(targetUser.id),
  })
}))

router.post('/:id/acknowledge', asyncHandler(async (req, res) => {
  const updated = await db.acknowledgeWarning(req.params.id, req.user.id)
  if (!updated) return res.status(404).json({ error: 'Warning not found.' })
  res.json(await moderation.serializeWarning(updated))
}))

// Revoking keeps the warning on the record but stops it counting toward the
// auto-punishment thresholds. Admin-only - a mod shouldn't be able to undo
// another mod's call.
router.post('/:id/revoke', asyncHandler(async (req, res) => {
  if (!roles.isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin can revoke a warning.' })
  const existing = await db.findWarningById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Warning not found.' })
  const updated = await db.revokeWarning(req.params.id, req.user.id)
  res.json(await moderation.serializeWarning(updated))
}))

module.exports = router
