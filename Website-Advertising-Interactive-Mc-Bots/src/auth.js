const bcrypt = require('bcryptjs')
const session = require('express-session')
const { MongoStore } = require('connect-mongo')
const config = require('./config')
const db = require('./db')
const mongo = require('./mongo')
const roles = require('./roles')
const { asyncHandler } = require('./asyncHandler')

function hashPassword(password) {
  return bcrypt.hashSync(password, 10)
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash)
}

function banMessage(user) {
  const expiry = user.banExpiresAt ? ` until ${new Date(user.banExpiresAt).toLocaleString()}` : ' permanently'
  const reason = user.banReason ? `: ${user.banReason}` : '.'
  return `You are banned${expiry}${reason}`
}

// Sessions are stored in MongoDB (connect-mongo) so logins survive server
// restarts. That only works if the signing secret is also stable across
// restarts - a random-per-boot secret (the old behavior) would silently
// invalidate every existing session cookie on every restart, defeating the
// point. The secret itself is generated once and persisted in MongoDB
// (see mongo.getOrCreatePersistedValue), unless SESSION_SECRET is set.
// Must be called after connectMongo() has resolved.
async function createSessionMiddleware() {
  const secret = config.sessionSecret || await mongo.getOrCreatePersistedValue('sessionSecret', mongo.randomSecret)
  return session({
    secret,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      clientPromise: mongo.clientPromise,
      dbName: config.mongoDbName,
      collectionName: 'sessions',
      ttl: 60 * 60 * 24 * 7, // seconds
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
}

// For server-rendered pages: redirects to /login and loads the full user
// record onto req.user so templates can show username/role/credits. A ban
// takes effect immediately, even on an already-live session.
const requirePageAuth = asyncHandler(async (req, res, next) => {
  const user = req.session?.userId && await db.findUserById(req.session.userId)
  if (!user) return res.redirect('/login')
  if (db.isBannedNow(user)) {
    const message = banMessage(user)
    req.session.destroy(() => res.redirect(`/login?error=${encodeURIComponent(message)}`))
    return
  }
  req.user = user
  next()
})

// For JSON API routes: 401/403s instead of redirecting, otherwise identical.
const requireApiAuth = asyncHandler(async (req, res, next) => {
  const user = req.session?.userId && await db.findUserById(req.session.userId)
  if (!user) return res.status(401).json({ error: 'Not authenticated' })
  if (db.isBannedNow(user)) {
    const message = banMessage(user)
    req.session.destroy(() => {})
    return res.status(403).json({ error: message, banned: true })
  }
  req.user = user
  next()
})

// Must run after requirePageAuth/requireApiAuth (needs req.user set).
// Both staff roles pass: 'admin' and 'developer' (see src/roles.js for why
// developer is admin-equivalent here, and where it deliberately isn't).
function requireAdmin(req, res, next) {
  if (!roles.isStaff(req.user)) {
    return res.status(403).json({ error: 'Admins only.' })
  }
  next()
}

// Staff retain full access; users with the 'mod' status tier get a narrow
// slice of privileges (module approval, password resets) - see individual
// route usage for exactly which endpoints this guards.
function requireModOrAdmin(req, res, next) {
  if (!roles.isModOrAdmin(req.user)) {
    return res.status(403).json({ error: 'Moderators or admins only.' })
  }
  next()
}

module.exports = {
  hashPassword,
  verifyPassword,
  banMessage,
  createSessionMiddleware,
  requirePageAuth,
  requireApiAuth,
  requireAdmin,
  requireModOrAdmin,
}
