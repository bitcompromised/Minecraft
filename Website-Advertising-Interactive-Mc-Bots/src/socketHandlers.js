const db = require('./db')

// Everything that touches the live mineflayer `bot` object now happens
// inside that connection's own child process (see botManager.js/
// botChild.js) - a socket event here just validates ownership and forwards
// a command over IPC via botManager.sendCommand(); the resulting state
// changes (inventory, position, chat, errors) come back the same way they
// always did, as socket.io events relayed from the child through
// botManager. A profile can now be connected to more than one saved server
// at once, so "which bot" always means the (profileId, serverId) pair, not
// just profileId.
function registerSocketHandlers(io, botManager) {
  io.on('connection', (socket) => {
    const userId = socket.request.session?.userId
    if (!userId) {
      socket.disconnect(true)
      return
    }
    // Lets an admin ban force-disconnect this socket immediately (see
    // POST /api/admin/users/:id/ban) instead of waiting for it to reconnect
    // and get rejected by requireApiAuth/requirePageAuth on its next request.
    socket.join(`user:${userId}`)

    let currentBotId = null
    let currentServerId = null

    function ownedProfile(botId) {
      return db.findBotProfile(botId, userId)
    }

    // Forwards this socket event straight to the subscribed connection's
    // child process as a named command, once ownership is confirmed. The
    // child silently no-ops commands it gets before its bot is ready,
    // mirroring the old in-process behavior of simply not having a bot
    // object yet.
    function withBot(command) {
      return async (payload) => {
        if (!currentBotId || !currentServerId || !await ownedProfile(currentBotId)) return
        botManager.sendCommand(currentBotId, currentServerId, command, payload)
      }
    }

    socket.on('subscribe', async ({ botId, serverId } = {}) => {
      if (!botId || !serverId) return
      const profile = await ownedProfile(botId)
      if (!profile) return
      if (currentBotId && currentServerId) socket.leave(botManager.room(currentBotId, currentServerId))
      currentBotId = botId
      currentServerId = serverId
      socket.join(botManager.room(botId, serverId))

      const status = botManager.getStatus(botId, serverId)
      const snapshot = botManager.getSnapshot(botId, serverId) || {}
      socket.emit('snapshot', {
        botId,
        serverId,
        status: status.status,
        viewerPort: status.viewerPort,
        error: status.error,
        health: snapshot.health || null,
        inventory: snapshot.inventory || null,
        position: snapshot.position || null,
        players: snapshot.players || [],
        chatLog: snapshot.chatLog || [],
        window: snapshot.window || null,
        cursorItem: snapshot.cursorItem || null,
        // What the modules loaded on this connection answer to, so the chat
        // box can complete their commands from the moment it opens rather
        // than only after the next load/unload pushes an update.
        moduleCommands: botManager.getModuleCommands(botId, serverId),
      })
    })

    // The 3D view is opt-in per connection: prismarine-viewer isn't started
    // until a client actually opens it (see botChild.js's startViewer). The
    // Play page sends this on subscribe; the client page's chat console
    // deliberately does not, so watching chat costs nothing extra.
    //
    // It carries its own ids rather than reading the subscription above.
    // Both events are emitted back to back, but 'subscribe' has to await a
    // database lookup before it can record which bot this socket is
    // watching - so this handler runs first, every time, and reading
    // currentBotId here would always find null and silently do nothing.
    socket.on('requestViewer', async (payload) => {
      const botId = payload?.botId || currentBotId
      const serverId = payload?.serverId || currentServerId
      if (!botId || !serverId || !await ownedProfile(botId)) return
      botManager.requestViewer(botId, serverId)
    })

    socket.on('unsubscribe', () => {
      if (currentBotId && currentServerId) {
        socket.leave(botManager.room(currentBotId, currentServerId))
        currentBotId = null
        currentServerId = null
      }
    })

    socket.on('chat', withBot('chat'))
    socket.on('move', withBot('move'))
    socket.on('look', withBot('look'))
    socket.on('selectSlot', withBot('selectSlot'))
    // The left button is held rather than clicked: startMining runs until
    // stopMining, so the bot breaks one block and moves to the next under
    // the crosshair (see botChild.js's runMiningLoop). 'leftClick' stays
    // routed for a browser still running a cached copy of the old page.
    socket.on('startMining', withBot('startMining'))
    socket.on('stopMining', withBot('stopMining'))
    socket.on('leftClick', withBot('leftClick'))
    socket.on('rightClick', withBot('rightClick'))
    socket.on('deactivateItem', withBot('deactivateItem'))
    // Full vanilla click/drag semantics (pickup/place/swap, shift-click,
    // double-click, number-key hotbar swap, drop, and multi-slot drag-to-
    // spread) all funnel through this one command - the client computes the
    // Minecraft protocol's {slot, mouseButton, mode} directly (it already
    // needs that logic for the UI itself), and the child process just calls
    // bot.clickWindow(slot, mouseButton, mode) with it. Replaces the old,
    // much simpler windowClick/equip click-to-transfer commands.
    socket.on('clickWindow', withBot('clickWindow'))
    socket.on('windowClose', withBot('windowClose'))
    // Q outside of hovering any open-window slot: drop the currently held
    // hotbar item, regardless of whether any inventory/container UI is even
    // open. Hovering a slot uses clickWindow's drop mode (4) instead.
    socket.on('dropSlot', withBot('dropSlot'))
    socket.on('respawn', withBot('respawn'))
    socket.on('goto', withBot('goto'))
    socket.on('stopGoto', withBot('stopGoto'))

    socket.on('disconnect', () => {
      if (!currentBotId || !currentServerId) return
      // Mining is a held button, and a closed tab never sends the mouseup.
      // Without this, closing the 3D view mid-swing leaves the bot digging
      // its way through the world with nobody watching.
      botManager.sendCommand(currentBotId, currentServerId, 'stopMining')
      socket.leave(botManager.room(currentBotId, currentServerId))
    })
  })
}

module.exports = { registerSocketHandlers }
