const express = require('express')
const db = require('../db')
const { requireModOrAdmin } = require('../auth')
const { paginateAndSearch } = require('../pagination')
const { asyncHandler } = require('../asyncHandler')
const { isModOrAdmin, canAccessSection } = require('../forumAccess')

// Maps the list endpoint's ?sort= param to a comparator over the
// already-fully-loaded, serialized thread array (see the note on
// paginateAndSearch in src/pagination.js - every list endpoint in this app
// sorts/filters/paginates an in-memory array, not a DB query, so a "sort by
// views/replies" that has no natural Mongo index still just works here).
const THREAD_SORTS = {
  activity: (a, b) => (b.pinned - a.pinned) || (b.lastPostAt - a.lastPostAt),
  newest: (a, b) => (b.pinned - a.pinned) || (b.createdAt - a.createdAt),
  views: (a, b) => (b.pinned - a.pinned) || (b.views - a.views),
  replies: (a, b) => (b.pinned - a.pinned) || (b.postCount - a.postCount),
}

function canEditPost(user, post) {
  return isModOrAdmin(user) || post.authorId === user.id
}

function canEditThread(user, thread) {
  return isModOrAdmin(user) || thread.authorId === user.id
}

function authorFields(author) {
  return {
    authorUsername: author ? author.username : '(deleted user)',
    authorAvatarUrl: author ? author.avatarUrl || null : null,
    authorTags: author ? author.tags || [] : [],
  }
}

async function serializeThread(t, requestingUser) {
  const author = await db.findUserById(t.authorId)
  const postCount = await db.countForumPosts(t.id)
  return {
    id: t.id,
    section: t.section,
    title: t.title,
    ...authorFields(author),
    authorId: t.authorId,
    canEdit: requestingUser ? canEditThread(requestingUser, t) : false,
    pinned: !!t.pinned,
    locked: !!t.locked,
    views: t.views || 0,
    editedAt: t.editedAt || null,
    createdAt: t.createdAt,
    lastPostAt: t.lastPostAt,
    postCount,
  }
}

// A short, plain-text (formatting stripped just by truncation, not markup
// parsing - post bodies are already plain text) preview of the post being
// replied to, resolved server-side so the thread page can render a quote
// in one round trip instead of N follow-up lookups.
const REPLY_SNIPPET_LENGTH = 120

async function serializePost(p, requestingUser) {
  const author = await db.findUserById(p.authorId)
  let replyTo = null
  if (p.replyToId) {
    const parent = await db.findForumPost(p.replyToId)
    if (parent) {
      const parentAuthor = await db.findUserById(parent.authorId)
      replyTo = {
        id: parent.id,
        authorUsername: parentAuthor ? parentAuthor.username : '(deleted user)',
        bodySnippet: parent.body.length > REPLY_SNIPPET_LENGTH ? `${parent.body.slice(0, REPLY_SNIPPET_LENGTH)}…` : parent.body,
      }
    }
  }
  return {
    id: p.id,
    threadId: p.threadId,
    ...authorFields(author),
    authorId: p.authorId,
    canEdit: requestingUser ? canEditPost(requestingUser, p) : false,
    body: p.body,
    replyToId: p.replyToId || null,
    replyTo,
    pinned: !!p.pinned,
    editedAt: p.editedAt || null,
    createdAt: p.createdAt,
  }
}

const router = express.Router()

router.get('/sections/:section/threads', asyncHandler(async (req, res) => {
  const { section } = req.params
  if (!canAccessSection(req.user, section)) return res.status(403).json({ error: 'Not allowed to view this section.' })
  const all = await Promise.all((await db.listForumThreads(section)).map((t) => serializeThread(t, req.user)))
  const sortFn = THREAD_SORTS[req.query.sort] || THREAD_SORTS.activity
  all.sort(sortFn)
  const { items, ...meta } = paginateAndSearch(all, req.query, (t, term) =>
    t.title.toLowerCase().includes(term) || t.authorUsername.toLowerCase().includes(term))
  res.json({ threads: items, ...meta })
}))

router.post('/sections/:section/threads', asyncHandler(async (req, res) => {
  const { section } = req.params
  if (!canAccessSection(req.user, section)) return res.status(403).json({ error: 'Not allowed to post in this section.' })
  const { title, body } = req.body || {}
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) {
    return res.status(400).json({ error: 'Title must be 3-120 characters.' })
  }
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 5000) {
    return res.status(400).json({ error: 'Post must be 1-5000 characters.' })
  }
  const thread = await db.createForumThread(section, req.user.id, { title: title.trim(), body: body.trim() })
  res.json(await serializeThread(thread, req.user))
}))

router.get('/threads/:id', asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  if (!canAccessSection(req.user, thread.section)) return res.status(403).json({ error: 'Not allowed to view this thread.' })
  await db.incrementForumThreadViews(thread.id)
  thread.views = (thread.views || 0) + 1
  const posts = await Promise.all((await db.listForumPosts(thread.id)).map((p) => serializePost(p, req.user)))
  res.json({ thread: await serializeThread(thread, req.user), posts })
}))

router.post('/threads/:id/posts', asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  if (!canAccessSection(req.user, thread.section)) return res.status(403).json({ error: 'Not allowed to post in this section.' })
  if (thread.locked && !isModOrAdmin(req.user)) {
    return res.status(400).json({ error: 'This thread is locked.' })
  }
  const { body, replyToId } = req.body || {}
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 5000) {
    return res.status(400).json({ error: 'Post must be 1-5000 characters.' })
  }
  let resolvedReplyToId = null
  if (replyToId !== undefined && replyToId !== null) {
    const parent = await db.findForumPost(replyToId)
    if (!parent || parent.threadId !== thread.id) {
      return res.status(400).json({ error: 'Cannot reply to a post that is not in this thread.' })
    }
    resolvedReplyToId = parent.id
  }
  const post = await db.createForumPost(thread.id, req.user.id, body.trim(), resolvedReplyToId)
  await notifyOnReply(thread, post, req.user, resolvedReplyToId)
  res.json(await serializePost(post, req.user))
}))

// Two notifications can come out of one reply: the thread's author hears
// that their thread got a reply, and (when this post is a direct reply) the
// quoted post's author hears that someone answered them. Whoever wrote the
// reply never notifies themselves, and if both roles are the same person
// only the more specific "replied to you" one is sent.
const SNIPPET_LENGTH = 140

function snippet(text) {
  const str = String(text || '').replace(/\s+/g, ' ').trim()
  return str.length > SNIPPET_LENGTH ? `${str.slice(0, SNIPPET_LENGTH)}…` : str
}

async function notifyOnReply(thread, post, author, replyToId) {
  const link = `/forum/thread/${thread.id}`
  const notified = new Set([author.id])

  if (replyToId) {
    const parent = await db.findForumPost(replyToId)
    if (parent && !notified.has(parent.authorId)) {
      notified.add(parent.authorId)
      await db.createNotification({
        userId: parent.authorId,
        type: 'post_reply',
        title: `${author.username} replied to your post in "${thread.title}"`,
        body: snippet(post.body),
        link,
        actorId: author.id,
      })
    }
  }

  if (!notified.has(thread.authorId)) {
    await db.createNotification({
      userId: thread.authorId,
      type: 'thread_reply',
      title: `${author.username} replied to your thread "${thread.title}"`,
      body: snippet(post.body),
      link,
      actorId: author.id,
    })
  }
}

// ---- reporting a thread or a post to staff ----

const MAX_REPORT_REASON = 1000

async function handleForumReport(req, res, { targetType, target, threadId }) {
  if (!target) return res.status(404).json({ error: 'That content no longer exists.' })
  const { reason } = req.body || {}
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > MAX_REPORT_REASON) {
    return res.status(400).json({ error: `Please describe the problem in 3-${MAX_REPORT_REASON} characters.` })
  }
  if (target.authorId === req.user.id) {
    return res.status(400).json({ error: 'You cannot report your own content.' })
  }
  await db.createForumReport(req.user.id, {
    targetType,
    targetId: target.id,
    threadId,
    reason: reason.trim(),
  })
  res.json({ ok: true })
}

router.post('/threads/:id/report', asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (thread && !canAccessSection(req.user, thread.section)) {
    return res.status(403).json({ error: 'Not allowed to view this thread.' })
  }
  await handleForumReport(req, res, { targetType: 'thread', target: thread, threadId: thread?.id })
}))

router.post('/posts/:id/report', asyncHandler(async (req, res) => {
  const post = await db.findForumPost(req.params.id)
  if (post) {
    const thread = await db.findForumThread(post.threadId)
    if (thread && !canAccessSection(req.user, thread.section)) {
      return res.status(403).json({ error: 'Not allowed to view this thread.' })
    }
  }
  await handleForumReport(req, res, { targetType: 'post', target: post, threadId: post?.threadId })
}))

router.post('/threads/:id/edit', asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  if (!canAccessSection(req.user, thread.section)) return res.status(403).json({ error: 'Not allowed to view this thread.' })
  if (!canEditThread(req.user, thread)) return res.status(403).json({ error: 'Only the thread author or a mod/admin can edit this.' })
  const { title } = req.body || {}
  if (typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 120) {
    return res.status(400).json({ error: 'Title must be 3-120 characters.' })
  }
  const updated = await db.editForumThreadTitle(thread.id, title.trim())
  res.json(await serializeThread(updated, req.user))
}))

router.post('/threads/:id/pin', requireModOrAdmin, asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  const updated = await db.setForumThreadPinned(thread.id, !!req.body?.pinned)
  res.json(await serializeThread(updated, req.user))
}))

router.post('/threads/:id/lock', requireModOrAdmin, asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  const updated = await db.setForumThreadLocked(thread.id, !!req.body?.locked)
  res.json(await serializeThread(updated, req.user))
}))

router.delete('/threads/:id', requireModOrAdmin, asyncHandler(async (req, res) => {
  const thread = await db.findForumThread(req.params.id)
  if (!thread) return res.status(404).json({ error: 'Thread not found.' })
  await db.deleteForumThread(thread.id)
  res.json({ ok: true })
}))

router.post('/posts/:id/edit', asyncHandler(async (req, res) => {
  const post = await db.findForumPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  const thread = await db.findForumThread(post.threadId)
  if (!thread || !canAccessSection(req.user, thread.section)) return res.status(403).json({ error: 'Not allowed to view this post.' })
  if (!canEditPost(req.user, post)) return res.status(403).json({ error: 'Only the post author or a mod/admin can edit this.' })
  if (thread.locked && !isModOrAdmin(req.user)) {
    return res.status(400).json({ error: 'This thread is locked.' })
  }
  const { body } = req.body || {}
  if (typeof body !== 'string' || body.trim().length < 1 || body.trim().length > 5000) {
    return res.status(400).json({ error: 'Post must be 1-5000 characters.' })
  }
  const updated = await db.editForumPost(post.id, body.trim())
  res.json(await serializePost(updated, req.user))
}))

router.post('/posts/:id/pin', requireModOrAdmin, asyncHandler(async (req, res) => {
  const post = await db.findForumPost(req.params.id)
  if (!post) return res.status(404).json({ error: 'Post not found.' })
  const updated = await db.setForumPostPinned(post.id, !!req.body?.pinned)
  res.json(await serializePost(updated, req.user))
}))

router.delete('/posts/:id', requireModOrAdmin, asyncHandler(async (req, res) => {
  const ok = await db.deleteForumPost(req.params.id)
  if (!ok) return res.status(404).json({ error: 'Post not found.' })
  res.json({ ok: true })
}))

module.exports = router
