const express = require('express')
const db = require('../db')
const { asyncHandler } = require('../asyncHandler')

// In-app notifications: forum replies, replies to your posts, and warnings
// issued by staff. Written by whatever produced them (routes/forum.js,
// src/moderation.js); this router only reads and marks them.
const router = express.Router()

async function serialize(n) {
  const actor = n.actorId ? await db.findUserById(n.actorId) : null
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    actorUsername: actor ? actor.username : null,
    actorAvatarUrl: actor ? actor.avatarUrl || null : null,
    readAt: n.readAt,
    createdAt: n.createdAt,
  }
}

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.listNotificationsForUser(req.user.id)
  res.json({
    notifications: await Promise.all(rows.map(serialize)),
    unread: await db.countUnreadNotifications(req.user.id),
  })
}))

// Polled by the nav bell on every page, so it stays deliberately cheap.
router.get('/unread-count', asyncHandler(async (req, res) => {
  res.json({ count: await db.countUnreadNotifications(req.user.id) })
}))

// With no ids, marks everything read; with ids, marks just those.
router.post('/read', asyncHandler(async (req, res) => {
  const { ids } = req.body || {}
  const marked = await db.markNotificationsRead(req.user.id, Array.isArray(ids) ? ids : null)
  res.json({ marked, unread: await db.countUnreadNotifications(req.user.id) })
}))

// Clicking a notification consumes it. Marking it read would leave it in the
// list forever, slowly turning the bell into an archive nobody reads; the
// content it points at is the permanent record, not the alert about it.
// With no ids, clears the whole list ("Mark all read").
router.post('/dismiss', asyncHandler(async (req, res) => {
  const { ids } = req.body || {}
  const deleted = Array.isArray(ids) && ids.length
    ? await db.deleteNotifications(req.user.id, ids)
    : await db.deleteNotificationsForUser(req.user.id)
  res.json({ deleted, unread: await db.countUnreadNotifications(req.user.id) })
}))

router.delete('/', asyncHandler(async (req, res) => {
  res.json({ deleted: await db.deleteNotificationsForUser(req.user.id) })
}))

module.exports = router
