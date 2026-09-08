const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const db = require('./db')
const { DEMO_MODULES } = require('./demoModules')
const { hashPassword } = require('./auth')

function generatePassword() {
  return crypto.randomBytes(9).toString('base64url')
}

// Ensures the admin account exists and always gets a fresh random password
// on every server start - there is no persistent, guessable, or
// user-chosen admin password lying around between restarts. Regular user
// sessions are stored in MongoDB and do survive a restart; only the admin's
// password is rotated every time, so the admin still needs to grab the new
// one from the terminal each restart.
async function bootstrapAdmin() {
  const username = config.adminUsername
  const password = generatePassword()
  const passwordHash = hashPassword(password)

  const existing = await db.findUserByUsername(username)
  if (existing) {
    await db.updateUserPassword(existing.id, passwordHash)
  } else {
    await db.createUser({ username, passwordHash, role: 'admin' })
  }

  return { username, password }
}

// Deliberately small and conservative - anything here is importable by
// every sandboxed module (see src/sandboxWorker.js) on every bot. Node
// builtins that grant filesystem/process/network access (fs, child_process,
// net, http, vm, process, ...) are intentionally NOT seeded here; an admin
// can still add them later via the Admin page if they understand and accept
// what that means, but the out-of-the-box default should not reopen the
// sandbox by default.
const DEFAULT_ALLOWED_IMPORTS = ['assert', 'util', 'events']

async function bootstrapImportWhitelist() {
  const existing = await db.listImportWhitelist()
  if (existing.length > 0) return
  for (const name of DEFAULT_ALLOWED_IMPORTS) {
    await db.addImportWhitelistEntry(name, null)
  }
}

// Seeds the free, readable-by-anyone example modules (src/demoModules.js)
// into the marketplace, owned by the admin account. Idempotent: each one is
// matched by its demoKey, so restarting doesn't create duplicates, and an
// admin who deletes one gets it back on the next boot (deliberate - they're
// documentation, not user content). Bumping a demo's source means bumping
// its demoKey; existing copies on disk are left alone.
async function bootstrapDemoModules() {
  const owner = await db.findUserByUsername(config.adminUsername)
  if (!owner) return 0

  fs.mkdirSync(config.modulesDir, { recursive: true })
  let created = 0

  for (const demo of DEMO_MODULES) {
    if (await db.findModuleByDemoKey(demo.demoKey)) continue

    const filePath = path.join(config.modulesDir, `${demo.demoKey}.js`)
    await fs.promises.writeFile(filePath, demo.source, 'utf8')

    await db.createModule(owner.id, {
      name: demo.name,
      description: demo.description,
      price: 0,
      fileName: demo.fileName,
      filePath,
      isDemo: true,
      demoKey: demo.demoKey,
      // Seeded already-approved: an admin reviewing first-party sample code
      // they shipped themselves would just be ceremony.
      status: 'approved',
    })
    created += 1
  }

  return created
}

module.exports = { bootstrapAdmin, bootstrapImportWhitelist, bootstrapDemoModules }
