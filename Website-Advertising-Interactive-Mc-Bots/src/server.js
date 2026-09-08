const path = require('path')
const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const config = require('./config')
const { connectMongo, closeMongo } = require('./mongo')
const { bootstrapAdmin, bootstrapImportWhitelist, bootstrapDemoModules } = require('./bootstrap')
const { createSessionMiddleware, requirePageAuth, requireApiAuth } = require('./auth')
const roles = require('./roles')
const { asyncHandler } = require('./asyncHandler')
const { BotManager } = require('./botManager')
const { createViewerProxy } = require('./viewerProxy')
const authRoutes = require('./routes/auth')
const inviteRoutes = require('./routes/invites')
const proxyRoutes = require('./routes/proxies')
const serverRoutes = require('./routes/servers')
const settingsRoutes = require('./routes/settings')
const { createAdminRoutes } = require('./routes/admin')
const { createMarketplaceRoutes } = require('./routes/marketplace')
const forumRoutes = require('./routes/forum')
const userRoutes = require('./routes/users')
const messageRoutes = require('./routes/messages')
const notificationRoutes = require('./routes/notifications')
const warningRoutes = require('./routes/warnings')
const publicSettingsRoutes = require('./routes/publicSettings')
const { createBotRoutes } = require('./routes/bots')
const { registerSocketHandlers } = require('./socketHandlers')

async function main() {
  console.log(`Connecting to MongoDB at ${config.mongoUri} ...`)
  await connectMongo()
  console.log(`Connected to MongoDB database "${config.mongoDbName}".`)

  // db is required after the connection is established - db.js resolves
  // getDb() lazily per-call, but requiring it earlier is harmless too; this
  // ordering just keeps the "connect first" intent obvious.
  const db = require('./db')

  const sessionMiddleware = await createSessionMiddleware()

  const app = express()
  app.set('view engine', 'ejs')
  app.set('views', path.join(__dirname, '..', 'views'))
  // Templates decide what staff can see in several places; giving them the
  // same roles helper the routes use keeps those checks from drifting apart
  // as roles are added (see src/roles.js).
  app.locals.roles = roles
  app.use(express.json())
  app.use(sessionMiddleware)

  // ---- pages ----

  // The only page a logged-out visitor can reach: a public product/showcase
  // page. Anyone already signed in goes straight to the community hub
  // instead, so "/" is never a dead end for a returning user.
  app.get('/', asyncHandler(async (req, res) => {
    if (req.session?.userId) return res.redirect('/hub')
    res.render('landing', {
      siteName: await db.getSystemSetting('siteName', 'Mineflayer Web'),
      registrationOpen: await db.getSystemSetting('registrationOpen', true),
    })
  }))
  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'login.html')))
  app.get('/play', requirePageAuth, (req, res) => res.sendFile(path.join(__dirname, '..', 'views', 'game.html')))

  // Signed-in home: the forum and the module marketplace side by side.
  app.get('/hub', requirePageAuth, (req, res) => res.render('hub', { user: req.user }))
  // Everything to do with running bots - profiles, servers, proxies, live
  // connections, and per-connection chat - now lives on one tabbed page.
  app.get('/client', requirePageAuth, (req, res) => res.render('client', { user: req.user }))

  // Pre-restructure URLs. The 3D viewer (which is deliberately untouched)
  // still links to /panel and /bots, and existing bookmarks shouldn't 404.
  app.get('/panel', (req, res) => res.redirect('/hub'))
  app.get('/bots', (req, res) => res.redirect('/client#bots'))
  app.get('/bot-profiles', (req, res) => res.redirect('/client#profiles'))
  app.get('/invites', (req, res) => res.redirect('/settings#invites'))

  app.get('/marketplace', requirePageAuth, (req, res) => res.render('marketplace', { user: req.user }))
  app.get('/marketplace/api', requirePageAuth, (req, res) => res.render('marketplace-api', { user: req.user }))
  app.get('/marketplace/module/:id', requirePageAuth, (req, res) => res.render('module-detail', { user: req.user, moduleId: req.params.id }))
  app.get('/faq', requirePageAuth, (req, res) => res.render('faq', { user: req.user }))
  app.get('/settings', requirePageAuth, (req, res) => res.render('settings', { user: req.user }))
  app.get('/forum', requirePageAuth, (req, res) => res.render('forum', { user: req.user }))
  app.get('/forum/thread/:id', requirePageAuth, (req, res) => res.render('forum-thread', { user: req.user, threadId: req.params.id }))
  app.get('/user/:username', requirePageAuth, (req, res) => res.render('user-profile', { user: req.user, profileUsername: req.params.username }))
  app.get('/messages', requirePageAuth, (req, res) => res.render('messages', { user: req.user }))
  app.get('/admin', requirePageAuth, (req, res) => {
    if (!roles.isModOrAdmin(req.user)) return res.redirect('/hub')
    res.render('admin', { user: req.user })
  })
  // A separate panel from /admin, admin-only (not mod-eligible) - CPU/RAM/
  // storage, per-bot averages, users, credits, and module sales stats.
  app.get('/admin/monitoring', requirePageAuth, (req, res) => {
    if (!roles.isStaff(req.user)) return res.redirect('/admin')
    res.render('admin-monitoring', { user: req.user })
  })

  // ---- api ----

  app.use('/api/auth', authRoutes)
  app.use('/api/public-settings', publicSettingsRoutes)
  app.use('/api/invites', requireApiAuth, inviteRoutes)
  app.use('/api/proxies', requireApiAuth, proxyRoutes)
  app.use('/api/servers', requireApiAuth, serverRoutes)
  app.use('/api/settings', requireApiAuth, settingsRoutes)
  app.use('/api/forum', requireApiAuth, forumRoutes)
  app.use('/api/users', requireApiAuth, userRoutes)
  app.use('/api/messages', requireApiAuth, messageRoutes)
  app.use('/api/notifications', requireApiAuth, notificationRoutes)
  app.use('/api/warnings', requireApiAuth, warningRoutes)

  const server = http.createServer(app)
  const io = new Server(server)
  const botManager = new BotManager(io, db)

  // The 3D viewer is served through this origin rather than from its own
  // port - see src/viewerProxy.js for why, and note that the mount path has
  // to stay in step with botManager's viewerPath().
  const viewerProxy = createViewerProxy({ botManager, db, sessionMiddleware })
  app.use(viewerProxy.middleware)
  server.on('upgrade', viewerProxy.handleUpgrade)

  app.use('/api/marketplace', requireApiAuth, createMarketplaceRoutes(botManager))
  app.use('/api/bots', requireApiAuth, createBotRoutes(botManager))
  // Per-route admin/mod gating lives inside admin.js itself now - most
  // endpoints stay admin-only, but a couple (password resets) are also
  // reachable by the 'mod' status tier.
  app.use('/api/admin', requireApiAuth, createAdminRoutes(botManager))

  // Only css/js assets live here - the HTML/EJS views above are served
  // explicitly (and auth-gated) so they can never be reached directly through
  // this static mount.
  app.use(express.static(path.join(__dirname, '..', 'public')))
  // Profile pictures are public images, not sensitive - served directly,
  // same as the css/js above.
  app.use('/avatars', express.static(config.avatarsDir))
  app.use('/module-media', express.static(config.moduleMediaDir))

  // Centralized error handler: every route/middleware wrapped in
  // asyncHandler() forwards rejections here via next(err), instead of
  // silently hanging the request.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[mineflayer-web] request error:', err)
    if (res.headersSent) return
    if (req.path.startsWith('/api/')) {
      res.status(500).json({ error: 'Internal server error.' })
    } else {
      res.status(500).send('Internal server error.')
    }
  })

  io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next)
  })

  registerSocketHandlers(io, botManager)

  const { username: adminUsername, password: adminPassword } = await bootstrapAdmin()
  await bootstrapImportWhitelist()
  const demosCreated = await bootstrapDemoModules()

  server.listen(config.webPort, () => {
    console.log(`Web control panel: http://localhost:${config.webPort}`)
    if (demosCreated > 0) {
      console.log(`Seeded ${demosCreated} free demo module${demosCreated === 1 ? '' : 's'} into the marketplace.`)
    }
    console.log('')
    console.log('================================================================')
    console.log(' Admin login for this session (regenerated on every restart):')
    console.log(`   username: ${adminUsername}`)
    console.log(`   password: ${adminPassword}`)
    console.log('================================================================')
    console.log('')
  })

  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    // Bot connections run in their own child processes now - wait for them
    // to actually exit (force-killing any that don't) instead of just
    // firing a stop message and exiting immediately, which would otherwise
    // leave them orphaned and still connected after this process is gone.
    await botManager.stopAll()
    await closeMongo()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
