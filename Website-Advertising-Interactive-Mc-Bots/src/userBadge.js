const roles = require('./roles');

// The small, safe-to-show-anyone slice of a user that the UI badges them
// with: their role ("User" / "Staff" / "Developer" / "Admin") and their
// status tier. Used anywhere another user's name is rendered - messages,
// marketplace listings, forum posts - so the label is computed in exactly
// one place rather than re-derived per page.
//
// 'mod' is deliberately surfaced as "Staff" rather than as its raw status:
// from a reader's point of view a moderator is staff, and the distinction
// between the mod tier and the developer/admin roles isn't theirs to care
// about.
function roleLabel(user) {
  if (!user) { return 'User'; }
  if (user.role === 'admin') { return 'Admin'; }
  if (user.role === 'developer') { return 'Developer'; }
  if (user.status === 'mod') { return 'Staff'; }
  return 'User';
}

// A CSS modifier the stylesheet keys off (see .role-badge in panel.css).
function roleClass(user) {
  return roleLabel(user).toLowerCase()
}

function publicUserBadge(user) {
  if (!user) return { roleLabel: 'User', roleClass: 'user', isStaff: false, status: 'normal' }
  return {
    roleLabel: roleLabel(user),
    roleClass: roleClass(user),
    isStaff: roles.isModOrAdmin(user),
    status: user.status || 'normal',
  }
}

module.exports = { roleLabel, roleClass, publicUserBadge }
