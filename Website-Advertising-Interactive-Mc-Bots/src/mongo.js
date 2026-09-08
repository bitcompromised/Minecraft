const crypto = require('crypto')
const { MongoClient } = require('mongodb')
const config = require('./config')

let client = null
let db = null
let resolveClientPromise
const clientPromise = new Promise((resolve) => {
  resolveClientPromise = resolve
})

async function connectMongo() {
  client = new MongoClient(config.mongoUri)
  await client.connect()
  db = client.db(config.mongoDbName)
  await ensureIndexes(db)
  resolveClientPromise(client)
  return db
}

async function ensureIndexes(database) {
  await Promise.all([
    database.collection('users').createIndex({ id: 1 }, { unique: true }),
    database.collection('users').createIndex({ usernameLower: 1 }, { unique: true }),
    database.collection('invites').createIndex({ id: 1 }, { unique: true }),
    database.collection('invites').createIndex({ code: 1 }, { unique: true }),
    database.collection('invites').createIndex({ createdByUserId: 1 }),
    database.collection('invites').createIndex({ usedByUserId: 1 }),
    database.collection('proxies').createIndex({ id: 1 }, { unique: true }),
    database.collection('proxies').createIndex({ userId: 1 }),
    database.collection('servers').createIndex({ id: 1 }, { unique: true }),
    database.collection('servers').createIndex({ userId: 1 }),
    database.collection('botProfiles').createIndex({ id: 1 }, { unique: true }),
    database.collection('botProfiles').createIndex({ userId: 1 }),
    database.collection('modules').createIndex({ id: 1 }, { unique: true }),
    database.collection('modules').createIndex({ ownerId: 1 }),
    database.collection('modules').createIndex({ status: 1 }),
    database.collection('purchases').createIndex({ id: 1 }, { unique: true }),
    database.collection('purchases').createIndex({ moduleId: 1, buyerId: 1 }),
    database.collection('moduleUpdates').createIndex({ id: 1 }, { unique: true }),
    database.collection('moduleUpdates').createIndex({ moduleId: 1 }),
    database.collection('moduleUpdates').createIndex({ status: 1 }),
    database.collection('errorLogs').createIndex({ id: 1 }, { unique: true }),
    database.collection('errorLogs').createIndex({ createdAt: -1 }),
    database.collection('errorLogs').createIndex({ botProfileId: 1 }),
    database.collection('forumThreads').createIndex({ id: 1 }, { unique: true }),
    database.collection('forumThreads').createIndex({ section: 1, createdAt: -1 }),
    database.collection('forumPosts').createIndex({ id: 1 }, { unique: true }),
    database.collection('forumPosts').createIndex({ threadId: 1, createdAt: 1 }),
    database.collection('systemConfig').createIndex({ key: 1 }, { unique: true }),
    database.collection('importWhitelist').createIndex({ name: 1 }, { unique: true }),
    // One document per (connection, player). The unique key is what makes
    // recording a sighting an upsert rather than a read-modify-write, so
    // concurrent connections to the same server cannot duplicate a player.
    database.collection('playerSightings').createIndex(
      { botProfileId: 1, serverId: 1, usernameLower: 1 },
      { unique: true },
    ),
    // The two orderings the seen-players list is read in: most recently
    // seen first, and by name for the search box.
    database.collection('playerSightings').createIndex({ botProfileId: 1, serverId: 1, lastSeenAt: -1 }),
    database.collection('playerSightings').createIndex({ userId: 1, lastSeenAt: -1 }),
  ])
}

function getDb() {
  if (!db) throw new Error('MongoDB not connected yet - call connectMongo() before using the database.')
  return db
}

// Generates a value once (e.g. a session-signing secret) and persists it in
// a tiny systemConfig collection so it survives restarts - used where a
// random-per-boot value would defeat the point of persisting something else
// (like sessions) across restarts.
async function getOrCreatePersistedValue(key, generate) {
  const col = getDb().collection('systemConfig')
  const existing = await col.findOne({ key })
  if (existing) return existing.value
  const value = generate()
  await col.insertOne({ key, value })
  return value
}

async function closeMongo() {
  if (client) await client.close()
}

module.exports = {
  connectMongo,
  getDb,
  closeMongo,
  clientPromise,
  getOrCreatePersistedValue,
  randomSecret: () => crypto.randomBytes(32).toString('hex'),
}
