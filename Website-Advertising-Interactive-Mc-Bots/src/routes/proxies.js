const express = require('express')
const db = require('../db')
const { asyncHandler } = require('../asyncHandler')

const router = express.Router()
const TYPES = new Set(['socks5', 'socks4', 'http'])

function serializeProxy(p) {
  return { id: p.id, name: p.name, type: p.type, host: p.host, port: p.port, username: p.username }
}

router.get('/', asyncHandler(async (req, res) => {
  res.json({ proxies: (await db.listProxiesByUser(req.user.id)).map(serializeProxy) })
}))

router.post('/', asyncHandler(async (req, res) => {
  const { name, type, host, port, username, password } = req.body || {}

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' })
  }
  if (!TYPES.has(type)) {
    return res.status(400).json({ error: 'Type must be socks5, socks4, or http.' })
  }
  if (typeof host !== 'string' || !host.trim()) {
    return res.status(400).json({ error: 'Host is required.' })
  }
  const portNum = parseInt(port, 10)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    return res.status(400).json({ error: 'Invalid port.' })
  }

  const proxy = await db.createProxy(req.user.id, {
    name: name.trim(),
    type,
    host: host.trim(),
    port: portNum,
    username: username ? String(username).trim() : null,
    password: password ? String(password) : null,
  })
  res.json(serializeProxy(proxy))
}))

router.delete('/:id', asyncHandler(async (req, res) => {
  const ok = await db.deleteProxy(req.params.id, req.user.id)
  if (!ok) return res.status(404).json({ error: 'Proxy not found.' })
  res.json({ ok: true })
}))

module.exports = router
