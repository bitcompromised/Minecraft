// Shared between routes/forum.js and routes/users.js (the user profile
// page's "threads/comments" tabs need the exact same section-visibility
// rules the forum itself uses, so a normal user browsing someone's profile
// can't see their posts in the mod-only 'admin' section).
const roles = require('./roles')

const SECTIONS = new Set(['marketplace', 'reviews', 'discussion', 'bugs', 'admin'])

// Re-exported from roles.js so this module keeps its existing surface while
// there is only one definition of "mod or staff" in the codebase.
const isModOrAdmin = roles.isModOrAdmin

// The 'admin' section (Admin/Mod Discussion) is invisible to everyone else.
function canAccessSection(user, section) {
  if (!SECTIONS.has(section)) return false
  if (section === 'admin') return isModOrAdmin(user)
  return true
}

module.exports = { SECTIONS, isModOrAdmin, canAccessSection }
