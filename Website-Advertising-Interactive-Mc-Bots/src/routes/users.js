const express = require('express')
const db = require('../db')
const { asyncHandler } = require('../asyncHandler')
const { isModOrAdmin, canAccessSection } = require('../forumAccess')

const MAX_ITEMS = 20

const router = express.Router()

router.get('/:username', asyncHandler(async (req, res) => {
  const target = await db.findUserByUsername(req.params.username)
  if (!target) return res.status(404).json({ error: 'User not found.' })

  const isSelfOrMod = req.user.id === target.id || isModOrAdmin(req.user)

  const [allThreads, allPosts, allModules] = await Promise.all([
    db.listForumThreadsByAuthor(target.id),
    db.listForumPostsByAuthor(target.id),
    db.listModulesByOwner(target.id),
  ])

  const visibleThreads = allThreads.filter((t) => canAccessSection(req.user, t.section))

  // "Comments under others' threads" per the profile spec - excludes the
  // opening post of a thread this user started themselves (same authorId +
  // identical createdAt timestamp as the thread, since createForumThread
  // stamps both with the same `now`), so starting a thread doesn't also
  // show up as a "comment". A later reply *they* post in *their own*
  // thread still counts as a comment - only the original post is excluded.
  const ownThreadOpenedAt = new Map(allThreads.map((t) => [t.id, t.createdAt]))
  const commentCandidates = allPosts.filter((p) => ownThreadOpenedAt.get(p.threadId) !== p.createdAt)

  const threadCache = new Map(allThreads.map((t) => [t.id, t]))
  async function threadFor(threadId) {
    if (threadCache.has(threadId)) return threadCache.get(threadId)
    const t = await db.findForumThread(threadId)
    threadCache.set(threadId, t)
    return t
  }

  const commentsWithThread = await Promise.all(commentCandidates.map(async (p) => ({ post: p, thread: await threadFor(p.threadId) })))
  const visibleComments = commentsWithThread.filter(({ thread }) => thread && canAccessSection(req.user, thread.section))

  // Everyone sees this user's approved modules; only the owner themselves
  // or a mod/admin also sees pending/rejected ones (same visibility rule
  // routes/marketplace.js already applies per-module, just filtered here
  // across the whole list instead of by id).
  const visibleModules = allModules.filter((m) => m.status === 'approved' || isSelfOrMod)

  const threadsOut = await Promise.all(visibleThreads.slice(0, MAX_ITEMS).map(async (t) => ({
    id: t.id,
    title: t.title,
    section: t.section,
    postCount: await db.countForumPosts(t.id),
    createdAt: t.createdAt,
    lastPostAt: t.lastPostAt,
  })))

  const COMMENT_SNIPPET_LENGTH = 160
  const commentsOut = visibleComments.slice(0, MAX_ITEMS).map(({ post, thread }) => ({
    id: post.id,
    threadId: thread.id,
    threadTitle: thread.title,
    section: thread.section,
    bodySnippet: post.body.length > COMMENT_SNIPPET_LENGTH ? `${post.body.slice(0, COMMENT_SNIPPET_LENGTH)}…` : post.body,
    createdAt: post.createdAt,
  }))

  const modulesOut = visibleModules.slice(0, MAX_ITEMS).map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    price: m.price,
    status: m.status,
    paused: !!m.paused,
    createdAt: m.createdAt,
  }))

  res.json({
    user: {
      username: target.username,
      avatarUrl: target.avatarUrl || null,
      bio: target.bio || null,
      tags: target.tags || [],
      status: target.status || 'normal',
      role: target.role,
      createdAt: target.createdAt,
      isSelf: req.user.id === target.id,
    },
    threads: threadsOut,
    threadsTotal: visibleThreads.length,
    comments: commentsOut,
    commentsTotal: visibleComments.length,
    modules: modulesOut,
    modulesTotal: visibleModules.length,
  })
}))

module.exports = router
