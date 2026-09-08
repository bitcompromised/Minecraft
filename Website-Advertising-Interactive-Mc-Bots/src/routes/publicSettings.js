const express = require('express')
const db = require('../db')
const { asyncHandler } = require('../asyncHandler')

const router = express.Router()

// Deliberately unauthenticated (unlike /api/settings) - the login page and
// the maintenance/announcement banner need to work before anyone is signed
// in. Only exposes the safe-to-show-anyone subset of website settings.
router.get('/', asyncHandler(async (req, res) => {
  res.json({
    siteName: await db.getSystemSetting('siteName', 'Mineflayer Web'),
    maintenanceMode: await db.getSystemSetting('maintenanceMode', false),
    maintenanceMessage: await db.getSystemSetting('maintenanceMessage', ''),
    announcementBanner: await db.getSystemSetting('announcementBanner', ''),
    registrationOpen: await db.getSystemSetting('registrationOpen', true),
    // Lets the register form drop the "invite code required" wording (and the
    // required marker) when an admin has opened registration up.
    invitelessRegistration: await db.getSystemSetting('invitelessRegistration', false),
  })
}))

module.exports = router
