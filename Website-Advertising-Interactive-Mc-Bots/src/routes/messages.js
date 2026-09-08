const express = require('express')
const db = require('../db')
const { publicUserBadge } = require('../userBadge')
const { asyncHandler } = require('../asyncHandler')

const MAX_BODY_LENGTH = 4000

const router = express.Router()

async function serializeConversation(row, viewerId) {
  const partner = await db.findUserById(row.partnerId)
  return {
    username: partner ? partner.username : '(deleted user)',
    avatarUrl: partner ? partner.avatarUrl || null : null,
    ...publicUserBadge(partner),
    lastMessage: row.lastMessage,
    lastMessageAt: row.lastMessageAt,
    lastMessageFromMe: row.lastMessageFromUserId === viewerId,
    unreadCount: row.unreadCount,
  }
}

router.get('/conversations', asyncHandler(async (req, res) => {
  const rows = await db.listConversationsForUser(req.user.id)
  const conversations = await Promise.all(rows.map((r) => serializeConversation(r, req.user.id)))
  res.json({ conversations })
}))

router.get('/unread-count', asyncHandler(async (req, res) => {
  res.json({ count: await db.countUnreadMessagesForUser(req.user.id) })
}))

router.get('/with/:username', asyncHandler(async (req, res) => {
  const partner = await db.findUserByUsername(req.params.username)
  if (!partner) return res.status(404).json({ error: 'User not found.' })
  if (partner.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." })

  const messages = await db.listConversation(req.user.id, partner.id)
  await db.markConversationRead(req.user.id, partner.id)

  res.json({
    partner: { username: partner.username, avatarUrl: partner.avatarUrl || null, ...publicUserBadge(partner) },
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      fromMe: m.fromUserId === req.user.id,
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
  })
}))

router.post('/with/:username', asyncHandler(async (req, res) => {
  const partner = await db.findUserByUsername(req.params.username)
  if (!partner) return res.status(404).json({ error: 'User not found.' })
  if (partner.id === req.user.id) return res.status(400).json({ error: "You can't message yourself." })

  const { body } = req.body || {}
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > MAX_BODY_LENGTH) {
    return res.status(400).json({ error: `Message must be 1-${MAX_BODY_LENGTH} characters.` })
  }

  const message = await db.createMessage(req.user.id, partner.id, body.trim())
  res.json({ id: message.id, body: message.body, fromMe: true, createdAt: message.createdAt, readAt: null })
}))

module.exports = router
