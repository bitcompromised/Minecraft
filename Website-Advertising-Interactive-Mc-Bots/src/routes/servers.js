const express = require('express')
const db = require('../db')
const { asyncHandler } = require('../asyncHandler')

const router = express.Router()

function serializeServer(s) {
  return { id: s.id, name: s.name, host: s.host, port: s.port, version: s.version }
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ servers: (await db.listServersByUser(req.user.id)).map(serializeServer) })
}))

router.post('/', asyncHandler(async (req, res) => {
  const { name, host, port, version } = req.body || {}

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' })
  }
  if (typeof host !== 'string' || !host.trim()) {
    return res.status(400).json({ error: 'Host is required.' })
  }
  const portNum = port ? parseInt(port, 10) : 25565
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'Invalid port.' })
  }

  const server = await db.createServer(req.user.id, {
    name: name.trim(),
    host: host.trim(),
    port: portNum,
    version: version && String(version).trim() !== 'auto' ? String(version).trim() : null,
  })
  res.json(serializeServer(server))
}))

router.delete('/:id', asyncHandler(async (req, res) => {
  const ok = await db.deleteServer(req.params.id, req.user.id)
  if (!ok) return res.status(404).json({ error: 'Server not found.' })
  res.json({ ok: true })
}))

module.exports = router
