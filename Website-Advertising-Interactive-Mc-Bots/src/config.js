require('dotenv').config()
const path = require('path')

module.exports = {
  webPort: parseInt(process.env.WEB_PORT || '3000', 10),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDbName: process.env.MONGODB_DB || 'mineflayer_web',
  // Sessions are persisted in MongoDB (see src/auth.js createSessionMiddleware),
  // so this must be stable across restarts. Leave unset to have one
  // generated once and persisted in MongoDB automatically; only set this if
  // you want to control/rotate it yourself.
  sessionSecret: process.env.SESSION_SECRET || null,
  viewFirstPerson: process.env.VIEW_FIRST_PERSON !== 'false',
  // Default invite quota granted when a user's status is set (including at
  // registration, where everyone starts at 'normal'). Admins can still
  // manually override an individual user's quota afterward.
  inviteQuotaByStatus: {
    normal: parseInt(process.env.INVITE_QUOTA_NORMAL || '1', 10),
    vip: parseInt(process.env.INVITE_QUOTA_VIP || '5', 10),
    mod: parseInt(process.env.INVITE_QUOTA_MOD || '1', 10),
  },
  // Max concurrent running bot connections per user, by tier - counts every
  // (profile, server) connection currently 'connecting' or 'online' across
  // all of a user's bot profiles, not just distinct profiles (a single
  // profile can run against several servers at once). Admins (role
  // 'admin', checked separately from status) are always unlimited,
  // regardless of their status tier.
  botConcurrencyByStatus: {
    normal: parseInt(process.env.BOT_CONCURRENCY_NORMAL || '1', 10),
    vip: parseInt(process.env.BOT_CONCURRENCY_VIP || '3', 10),
    mod: parseInt(process.env.BOT_CONCURRENCY_MOD || '3', 10),
  },
  modulesDir: process.env.MODULES_DIR || path.join(__dirname, '..', 'data', 'modules'),
  avatarsDir: process.env.AVATARS_DIR || path.join(__dirname, '..', 'data', 'avatars'),
  moduleMediaDir: process.env.MODULE_MEDIA_DIR || path.join(__dirname, '..', 'data', 'module-media'),
  // The admin account is bootstrapped (and its password re-randomized) on
  // every server start - see src/bootstrap.js.
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
}
