// Single source of truth for what each role/tier is allowed to do.
//
// There are two independent axes on a user:
//   role   - 'user' | 'developer' | 'admin'   (set by an admin; structural)
//   status - 'normal' | 'vip' | 'mod'         (set by an admin; a tier)
//
// 'developer' is a second staff role: it reaches the admin panel, reviews
// modules, reads any module's source, runs unlimited concurrent bots, and
// its bots survive maintenance mode. The one thing it deliberately cannot do
// is act on an admin or another developer's account (ban/pause/password/
// email/status/credits) - see canActOnUser below. That keeps "developer" a
// working staff role without making it a silent path to taking over the
// admin account.

const STAFF_ROLES = new Set(['admin', 'developer'])
const ASSIGNABLE_ROLES = ['user', 'developer', 'admin']

function isAdmin(user) {
  return user?.role === 'admin'
}

function isDeveloper(user) {
  return user?.role === 'developer'
}

// Reaches the admin panel and everything gated by requireAdmin.
function isStaff(user) {
  return STAFF_ROLES.has(user?.role)
}

// Module review, forum admin section, password resets - the mod tier plus
// both staff roles.
function isModOrAdmin(user) {
  return isStaff(user) || user?.status === 'mod'
}

// Whose bots keep running when maintenance mode is switched on, and who can
// still start new ones while it stays on.
function isMaintenanceExempt(user) {
  return isStaff(user)
}

// Unlimited concurrent bot connections (everyone else is capped by
// config.botConcurrencyByStatus).
function hasUnlimitedBots(user) {
  return isStaff(user)
}

// Guards admin actions that target another account. Admins may act on
// anyone; developers may act on anyone who isn't themselves staff.
function canActOnUser(actor, target) {
  if (!isStaff(actor)) return false
  if (isAdmin(actor)) return true
  return !isStaff(target)
}

// Human-readable label for a role, used in badges.
function roleLabel(role) {
  return role === 'developer' ? 'dev' : role
}

module.exports = {
  STAFF_ROLES,
  ASSIGNABLE_ROLES,
  isAdmin,
  isDeveloper,
  isStaff,
  isModOrAdmin,
  isMaintenanceExempt,
  hasUnlimitedBots,
  canActOnUser,
  roleLabel,
}
