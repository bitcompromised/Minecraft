const express = require('express')
const db = require('../db')
const config = require('../config')
const { asyncHandler } = require('../asyncHandler')

const router = express.Router()

function quotaFor(user) {
  return user.inviteQuota ?? config.inviteQuotaByStatus[user.status] ?? config.inviteQuotaByStatus.normal
}

router.get('/', asyncHandler(async (req, res) => {
  const rawInvites = await db.listInvitesByUser(req.user.id)
  const invites = rawInvites
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((i) => ({ id: i.id, code: i.code, usedAt: i.usedAt, createdAt: i.createdAt }))
  const quota = quotaFor(req.user)
  const used = await db.invitesUsedTowardQuota(req.user.id)

  res.json({
    invites,
    quota,
    used,
    remaining: Math.max(0, quota - used),
    referrals: await db.listReferralsByUser(req.user.id),
  })
}))

router.post('/', asyncHandler(async (req, res) => {
  if (req.user.paused) {
    return res.status(403).json({ error: `Your account is paused: ${req.user.pauseReason || 'no reason given'}` })
  }
  const quota = quotaFor(req.user)
  const used = await db.invitesUsedTowardQuota(req.user.id)
  if (used >= quota) {
    return res.status(400).json({ error: `Invite quota reached (${quota}). Ask an admin for more.` })
  }
  const invite = await db.createInvite(req.user.id)
  res.json({ id: invite.id, code: invite.code, usedAt: invite.usedAt, createdAt: invite.createdAt })
}))

router.delete('/:id', asyncHandler(async (req, res) => {
  const ok = await db.deleteInvite(req.params.id, req.user.id)
  if (!ok) return res.status(404).json({ error: 'Invite not found, or already used.' })
  res.json({ ok: true })
}))

module.exports = router
