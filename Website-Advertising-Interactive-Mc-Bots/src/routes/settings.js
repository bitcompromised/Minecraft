const express = require('express')
const fs = require('fs')
const path = require('path')
const multer = require('multer')
const db = require('../db')
const config = require('../config')
const { hashPassword, verifyPassword } = require('../auth')
const { asyncHandler } = require('../asyncHandler')

fs.mkdirSync(config.avatarsDir, { recursive: true })

const AVATAR_EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.avatarsDir),
    filename: (req, file, cb) => cb(null, `${req.user.id}${AVATAR_EXT_BY_MIME[file.mimetype] || ''}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!AVATAR_EXT_BY_MIME[file.mimetype]) {
      return cb(new Error('Profile picture must be a PNG, JPEG, GIF, or WebP image.'))
    }
    cb(null, true)
  },
})

const router = express.Router()

const PASSWORD_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000

function formatRemaining(ms) {
  const totalMinutes = Math.ceil(ms / (60 * 1000))
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

router.post('/password', asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {}
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Current and new password are required.' })
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' })
  }
  if (!verifyPassword(currentPassword, req.user.passwordHash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' })
  }
  // Self-service only - an admin resetting your password from the Admin
  // page isn't subject to this (see db.setLastSelfPasswordChangeAt).
  const last = req.user.lastSelfPasswordChangeAt
  if (last) {
    const elapsed = Date.now() - last
    if (elapsed < PASSWORD_CHANGE_COOLDOWN_MS) {
      return res.status(429).json({
        error: `You can only change your password once per day. Try again in ${formatRemaining(PASSWORD_CHANGE_COOLDOWN_MS - elapsed)}.`,
      })
    }
  }
  await db.updateUserPassword(req.user.id, hashPassword(newPassword))
  await db.setLastSelfPasswordChangeAt(req.user.id, Date.now())
  res.json({ ok: true })
}))

router.post('/avatar', (req, res, next) => {
  // multer's callback isn't awaited by multer itself, so a rejecting async
  // handler here would become an unhandled rejection unless caught manually
  // (same pattern as the module upload route in routes/marketplace.js).
  uploadAvatar.single('avatar')(req, res, (uploadErr) => {
    (async () => {
      if (uploadErr) return res.status(400).json({ error: uploadErr.message })
      if (!req.file) return res.status(400).json({ error: 'An image file is required.' })

      // Clean up a stale avatar left over from a previous upload with a
      // different image type (same userId prefix, different extension) -
      // otherwise it'd sit around forever, orphaned, once the DB record
      // points at the new file instead.
      const keepName = path.basename(req.file.path)
      const entries = await fs.promises.readdir(config.avatarsDir).catch(() => [])
      await Promise.all(
        entries
          .filter((name) => name !== keepName && name.startsWith(req.user.id))
          .map((name) => fs.promises.unlink(path.join(config.avatarsDir, name)).catch(() => {}))
      )

      const user = await db.setUserAvatar(req.user.id, `/avatars/${keepName}`)
      res.json({ avatarUrl: user.avatarUrl })
    })().catch(next)
  })
})

// Users set their own email now (it used to be admin-only). It's a contact
// field, not an identity or a recovery channel - there is no email-based
// password reset in this app - so there's nothing to verify against and no
// uniqueness constraint to enforce. Admins can still overwrite it from the
// Admin page.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

router.post('/email', asyncHandler(async (req, res) => {
  const { email } = req.body || {}
  if (typeof email !== 'string') {
    return res.status(400).json({ error: 'Email must be text (send an empty string to clear it).' })
  }
  const trimmed = email.trim()
  if (trimmed && (trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed))) {
    return res.status(400).json({ error: 'That does not look like a valid email address.' })
  }
  const user = await db.setUserEmail(req.user.id, trimmed || null)
  res.json({ email: user.email })
}))

const MAX_BIO_LENGTH = 500

router.post('/bio', asyncHandler(async (req, res) => {
  const { bio } = req.body || {}
  if (typeof bio !== 'string' || bio.length > MAX_BIO_LENGTH) {
    return res.status(400).json({ error: `Bio must be ${MAX_BIO_LENGTH} characters or fewer.` })
  }
  const user = await db.setUserBio(req.user.id, bio.trim())
  res.json({ bio: user.bio })
}))

module.exports = router
