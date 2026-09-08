// Shared by every route file that writes to the admin audit trail (see
// db.js's addAuditLogEntry/listAuditLog) - originally local to
// routes/admin.js, pulled out once routes/marketplace.js needed the same
// thing for module moderation actions (approve/reject/pause/remove/etc).
const db = require('./db')

async function logAudit(actorId, action, targetType, targetId, details = null) {
  try {
    await db.addAuditLogEntry({ actorId, action, targetType, targetId, details })
  } catch (err) {
    console.error('[mineflayer-web] failed to write audit log entry:', err)
  }
}

module.exports = { logAudit }
