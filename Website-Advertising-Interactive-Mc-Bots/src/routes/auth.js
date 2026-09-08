const express = require('express')
const db = require('../db')
const { hashPassword, verifyPassword, banMessage } = require('../auth')
const { asyncHandler } = require('../asyncHandler')

const router = express.Router()

router.post('/register', asyncHandler(async (req, res) => {
  if (!(await db.getSystemSetting('registrationOpen', true))) {
    return res.status(403).json({ error: 'Registration is currently closed.' })
  }

  const { username, password, inviteCode } = req.body || {}

  if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 32) {
    return res.status(400).json({ error: 'Username must be 3-32 characters.' })
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' })
  }

  const cleanUsername = username.trim()
  if (await db.findUserByUsername(cleanUsername)) {
    return res.status(400).json({ error: 'Username is already taken.' })
  }

  // Registration is invite-gated by default, but an admin can open it up
  // (invitelessRegistration on the Admin page's Website settings). Even when
  // it's open, an invite code that was supplied is still honoured and still
  // credits the referrer - it just stops being mandatory.
  const invitelessAllowed = await db.getSystemSetting('invitelessRegistration', false)
  const suppliedCode = typeof inviteCode === 'string' ? inviteCode.trim() : ''

  let invite = null
  if (suppliedCode) {
    invite = await db.findInviteByCode(suppliedCode)
    if (!invite || invite.usedAt) {
      return res.status(400).json({ error: 'That invite link is invalid or has already been used.' })
    }
  } else if (!invitelessAllowed) {
    return res.status(400).json({ error: 'An invite link is required to register.' })
  }

  const user = await db.createUser({
    username: cleanUsername,
    passwordHash: hashPassword(password),
    role: 'user',
  })

  // Opening balances, both admin-configurable. startingInvites overrides the
  // per-tier default quota when set; leaving it null keeps that default.
  const startingCredits = await db.getSystemSetting('startingCredits', 0)
  if (startingCredits > 0) await db.setUserCredits(user.id, startingCredits)

  const startingInvites = await db.getSystemSetting('startingInvites', null)
  if (Number.isInteger(startingInvites)) await db.setUserInviteQuota(user.id, startingInvites)

  if (invite) await db.markInviteUsed(invite.code, user.id)

  req.session.userId = user.id
  res.json({ username: user.username, role: user.role })
}))

router.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' })
  }

  const user = await db.findUserByUsername(username.trim())
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' })
  }
  if (db.isBannedNow(user)) {
    return res.status(403).json({ error: banMessage(user) })
  }

  req.session.userId = user.id
  res.json({ username: user.username, role: user.role })
}))

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }))
})

router.get('/session', asyncHandler(async (req, res) => {
  const user = req.session.userId ? await db.findUserById(req.session.userId) : null
  if (!user) return res.json({ user: null })
  res.json({ user: { username: user.username, role: user.role } })
}))

module.exports = router
