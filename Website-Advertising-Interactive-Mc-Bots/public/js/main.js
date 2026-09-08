(() => {
  const socket = io()

  const HOTBAR_SLOTS = [36, 37, 38, 39, 40, 41, 42, 43, 44]
  const MAIN_SLOTS = Array.from({ length: 27 }, (_, i) => i + 9)
  const ARMOR_SLOTS = [
    { slot: 5, label: 'Helmet' },
    { slot: 6, label: 'Chest' },
    { slot: 7, label: 'Legs' },
    { slot: 8, label: 'Boots' },
    { slot: 45, label: 'Off-hand' },
  ]

  const state = {
    inventorySlots: [],
    quickBarSlot: 0,
    yaw: 0,
    pitch: 0,
    pointerLocked: false,
    inventoryOpen: false,
    dead: false,
    activeBotId: null,
    activeServerId: null,
    containerWindow: null,
    // What's floating on the cursor mid drag-and-drop (server-authoritative,
    // driven by the 'cursorItem' socket event - see botChild.js's
    // emitCursorItem()).
    cursorItem: null,
    // The slot currently under the mouse, whichever panel it's in - used by
    // the 1-9 hotbar-swap and Q-drop keyboard shortcuts, which act on
    // whatever slot you're hovering rather than a fixed target.
    hoveredSlot: null,
    // Whether the left button is currently held down over the world. The
    // bot keeps mining until told otherwise, so this must be released on
    // every path out - mouseup, losing the pointer, leaving the page.
    mining: false,
    // What the modules loaded on this connection declare they answer to,
    // as [{moduleId, moduleName, commands}] - the chat box's completion
    // list is built entirely from this.
    moduleCommands: [],
  }

  const el = {
    viewerFrame: document.getElementById('viewer-frame'),
    captureLayer: document.getElementById('capture-layer'),
    clickHint: document.getElementById('click-hint'),
    emptyState: document.getElementById('empty-state'),
    statusBanner: document.getElementById('status-banner'),
    coords: document.getElementById('coords'),
    healthBar: document.getElementById('health-bar'),
    foodBar: document.getElementById('food-bar'),
    hotbar: document.getElementById('hotbar'),
    playerList: document.getElementById('player-list'),
    chatLog: document.getElementById('chat-log'),
    chatInput: document.getElementById('chat-input'),
    chatSuggestions: document.getElementById('chat-suggestions'),
    inventoryPanel: document.getElementById('inventory-panel'),
    armorRow: document.getElementById('armor-row'),
    mainInventory: document.getElementById('main-inventory'),
    hotbarInventory: document.getElementById('hotbar-inventory'),
    closeInventory: document.getElementById('close-inventory'),
    deathScreen: document.getElementById('death-screen'),
    respawnBtn: document.getElementById('respawn-btn'),

    containerPanel: document.getElementById('container-panel'),
    containerTitle: document.getElementById('container-title'),
    containerGrid: document.getElementById('container-grid'),
    containerPlayerGrid: document.getElementById('container-player-grid'),
    closeContainer: document.getElementById('close-container'),
    cursorItem: document.getElementById('cursor-item'),
    itemTooltip: document.getElementById('item-tooltip'),

    activeBotName: document.getElementById('active-bot-name'),
    activeBotStatus: document.getElementById('active-bot-status'),
    currentUsername: document.getElementById('current-username'),
    btnLogout: document.getElementById('btn-logout'),
  }

  function setStatus(text) {
    el.statusBanner.textContent = text || ''
  }

  // Completion for the chat box, built from whatever the modules loaded on
  // this connection declare they answer to. The widget itself lives in
  // public/js/chatCommands.js, shared with the client page's console; it is
  // created here, next to the elements it drives, because the snapshot and
  // bot-switching handlers below both need to feed it.
  const completer = ChatCommands.create({
    input: el.chatInput,
    container: el.chatSuggestions,
  })

  function setModuleCommands(list) {
    state.moduleCommands = Array.isArray(list) ? list : []
    completer.setCommands(state.moduleCommands)
  }

  // ---- API helper ----

  async function apiFetch(url, options) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Request failed.')
    return data
  }

  // ---- Chat ----

  // How close to the bottom still counts as "following the conversation".
  // Never test this with an equality: fractional line heights and sub-pixel
  // scroll positions mean scrollTop + clientHeight usually lands a hair
  // short of scrollHeight even when the log is scrolled all the way down.
  const CHAT_PIN_SLACK_PX = 24

  function isChatPinned(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= CHAT_PIN_SLACK_PX
  }

  function addChatLine({ message, html, kind }) {
    const line = document.createElement('div')
    // 'command' is a module command typed here and handled by a module
    // rather than sent to the server (botChild.js echoes it back so there
    // is some record of it) - styled as an echo, not as a server message.
    line.className = 'line'
      + (kind && kind !== 'chat' ? ' system' : '')
      + (kind === 'command' ? ' command' : '')
    if (html) {
      // Pre-escaped by prismarine-chat's toHTML() server-side (see
      // botManager.js) - safe to insert directly, never built from raw text.
      line.innerHTML = html
    } else {
      line.textContent = message
    }
    // Whether to follow the new line is decided from where the log was
    // *before* it was added - afterwards, everything is one line further
    // from the bottom and the answer would always be no.
    const pinned = isChatPinned(el.chatLog)
    el.chatLog.appendChild(line)

    // Trimming the backlog removes lines from the top, so everything below
    // shifts up by however much they were worth. scrollTop does not move
    // with it, so without this the view jumps every time the cap is hit.
    const heightBeforeTrim = el.chatLog.scrollHeight
    while (el.chatLog.children.length > 200) {
      el.chatLog.removeChild(el.chatLog.firstChild)
    }
    const trimmedHeight = heightBeforeTrim - el.chatLog.scrollHeight

    if (pinned) {
      el.chatLog.scrollTop = el.chatLog.scrollHeight
    } else if (trimmedHeight > 0) {
      // Someone is reading back through the log. Keep the line they were
      // looking at exactly where it was.
      el.chatLog.scrollTop = Math.max(0, el.chatLog.scrollTop - trimmedHeight)
    }
  }

  // ---- HUD rendering ----

  function renderHearts(container, value, max, char) {
    container.innerHTML = ''
    const totalIcons = Math.ceil(max / 2)
    for (let i = 0; i < totalIcons; i++) {
      const remaining = value - i * 2
      const span = document.createElement('span')
      span.className = 'icon ' + (remaining >= 2 ? 'full' : remaining === 1 ? 'half' : 'empty')
      span.textContent = char
      container.appendChild(span)
    }
  }

  function renderHealth({ health, food }) {
    renderHearts(el.healthBar, Math.max(0, health ?? 20), 20, '♥')
    renderHearts(el.foodBar, Math.max(0, food ?? 20), 20, '●')
  }

  function itemLabel(item) {
    if (!item) return ''
    return item.customName || item.displayName || item.name
  }

  function enchantLabel(enchant) {
    const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
    const name = (enchant.name || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return roman[enchant.lvl] ? `${name} ${roman[enchant.lvl]}` : `${name} ${enchant.lvl}`
  }

  function buildSlotElement(slot, item, { selected = false, interactive = false } = {}) {
    const div = document.createElement('div')
    div.className = 'slot' + (selected ? ' selected' : '')
    div.dataset.slot = slot
    if (item) {
      const enchanted = item.enchants && item.enchants.length > 0
      if (enchanted) div.classList.add('enchanted')

      const name = document.createElement('div')
      name.className = 'item-name' + (item.customName ? ' custom-name' : '')
      // customNameHtml is pre-escaped markup built server-side from the
      // item's legacy section-sign colour codes (see src/itemData.js). It's
      // present only when the name actually carried any.
      if (item.customNameHtml) name.innerHTML = item.customNameHtml
      else name.textContent = itemLabel(item)
      div.appendChild(name)

      if (item.count > 1) {
        const count = document.createElement('div')
        count.className = 'item-count'
        count.textContent = item.count
        div.appendChild(count)
      }
    }

    div.addEventListener('mouseenter', () => {
      if (interactive) state.hoveredSlot = slot
      showTooltip(item)
    })
    div.addEventListener('mousemove', (e) => positionTooltip(e))
    div.addEventListener('mouseleave', () => {
      if (interactive && state.hoveredSlot === slot) state.hoveredSlot = null
      hideTooltip()
    })

    if (interactive) wireSlotInteraction(div, slot)

    return div
  }

  // ---- custom item tooltip (replaces the native title-attribute one) ----

  function showTooltip(item) {
    if (!item) {
      hideTooltip()
      return
    }
    el.itemTooltip.innerHTML = ''
    const name = document.createElement('div')
    name.className = 'tooltip-name' + (item.customName ? ' custom-name' : '')
    if (item.customNameHtml) name.innerHTML = item.customNameHtml
    else name.textContent = itemLabel(item)
    el.itemTooltip.appendChild(name)
    if (item.enchants && item.enchants.length) {
      item.enchants.forEach((enchant) => {
        const line = document.createElement('div')
        line.className = 'tooltip-enchant'
        line.textContent = enchantLabel(enchant)
        el.itemTooltip.appendChild(line)
      })
    }
    // Lore sits below the enchantments, the way it does in game. Each line
    // arrives as {text, html} - html is pre-escaped markup built server-side
    // from the line's colour codes (src/itemData.js), and is null for a line
    // that had none.
    if (item.lore && item.lore.length) {
      item.lore.forEach((line) => {
        const div = document.createElement('div')
        div.className = 'tooltip-lore'
        if (line.html) div.innerHTML = line.html
        else div.textContent = line.text
        // A blank lore line is a deliberate spacer, and an empty div would
        // collapse to nothing.
        if (!line.text) div.innerHTML = '&nbsp;'
        el.itemTooltip.appendChild(div)
      })
    }
    const count = document.createElement('div')
    count.className = 'tooltip-count'
    count.textContent = `x${item.count}`
    el.itemTooltip.appendChild(count)
    el.itemTooltip.classList.remove('hidden')
  }

  function hideTooltip() {
    el.itemTooltip.classList.add('hidden')
  }

  function positionTooltip(e) {
    if (el.itemTooltip.classList.contains('hidden')) return
    el.itemTooltip.style.left = `${e.clientX + 14}px`
    el.itemTooltip.style.top = `${e.clientY + 14}px`
  }

  // ---- cursor item (what's picked up mid drag-and-drop) ----

  function renderCursorItem() {
    const item = state.cursorItem
    el.cursorItem.innerHTML = ''
    if (!item) {
      el.cursorItem.classList.add('hidden')
      return
    }
    el.cursorItem.classList.remove('hidden')
    const name = document.createElement('div')
    name.className = 'item-name'
    name.textContent = itemLabel(item)
    el.cursorItem.appendChild(name)
    if (item.count > 1) {
      const count = document.createElement('div')
      count.className = 'item-count'
      count.textContent = item.count
      el.cursorItem.appendChild(count)
    }
  }

  document.addEventListener('mousemove', (e) => {
    if (state.cursorItem) {
      el.cursorItem.style.left = `${e.clientX}px`
      el.cursorItem.style.top = `${e.clientY}px`
    }
  })

  // ---- click / drag-to-spread, mapped to the real Minecraft protocol's
  // window_click packet shape: {slot, mouseButton, mode}. Sent to the
  // server via the single 'clickWindow' socket event; bot.clickWindow()
  // does the rest (see botChild.js). ----

  function sendClick(slot, mouseButton, mode) {
    socket.emit('clickWindow', { slot, mouseButton, mode })
  }

  let dragState = null // { button, visited: Set<slot> } while a mouse button is held over slots

  function wireSlotInteraction(div, slot) {
    div.addEventListener('mousedown', (e) => {
      if (e.button !== 0 && e.button !== 2) return
      e.preventDefault()
      dragState = { button: e.button, visited: new Set(), startSlot: slot, startShift: e.shiftKey }
    })

    div.addEventListener('mouseenter', () => {
      if (!dragState) return
      if (dragState.visited.size === 0) {
        // First move off the mousedown slot - a real drag has begun. The
        // protocol's drag start/end clicks both use slot -999 (the "outside
        // window" sentinel) regardless of which slot the drag began on -
        // only the per-slot "add" clicks in between carry a real slot index.
        sendClick(-999, dragState.button === 2 ? 4 : 0, 5)
        dragState.visited.add(dragState.startSlot)
        sendClick(dragState.startSlot, dragState.button === 2 ? 5 : 1, 5)
      }
      if (!dragState.visited.has(slot)) {
        dragState.visited.add(slot)
        sendClick(slot, dragState.button === 2 ? 5 : 1, 5)
      }
    })

    div.addEventListener('dblclick', (e) => {
      e.preventDefault()
      sendClick(slot, 0, 6)
    })
  }

  document.addEventListener('mouseup', (e) => {
    if (!dragState) return
    const { button, visited, startSlot, startShift } = dragState
    dragState = null
    if (visited.size > 1) {
      // A real multi-slot drag happened - end the paint gesture.
      sendClick(-999, button === 2 ? 6 : 2, 5)
      return
    }
    // No drag occurred - treat as a plain click on the slot the mouse went
    // down on (dblclick is handled separately via its own listener).
    if (e.detail >= 2) return
    if (startShift) {
      sendClick(startSlot, 0, 1)
    } else {
      sendClick(startSlot, button === 2 ? 1 : 0, 0)
    }
  })

  // Dragging can end (mouseup) outside any slot entirely, or the window can
  // lose focus mid-drag - either way, don't leave a half-finished paint
  // gesture hanging server-side.
  window.addEventListener('blur', () => {
    if (!dragState) return
    if (dragState.visited.size > 1) sendClick(-999, dragState.button === 2 ? 6 : 2, 5)
    dragState = null
  })

  function getSlotItem(slot) {
    return state.inventorySlots[slot] || null
  }

  function renderHotbar() {
    el.hotbar.innerHTML = ''
    HOTBAR_SLOTS.forEach((slot, i) => {
      const item = getSlotItem(slot)
      const div = buildSlotElement(slot, item, { selected: i === state.quickBarSlot })
      div.addEventListener('click', () => socket.emit('selectSlot', i))
      el.hotbar.appendChild(div)
    })
  }

  function renderInventoryPanel() {
    el.armorRow.innerHTML = ''
    ARMOR_SLOTS.forEach(({ slot, label }) => {
      const item = getSlotItem(slot)
      const div = buildSlotElement(slot, item, { interactive: true })
      if (!item) {
        const ph = document.createElement('div')
        ph.className = 'item-name'
        ph.style.opacity = '0.4'
        ph.textContent = label
        div.appendChild(ph)
      }
      el.armorRow.appendChild(div)
    })

    el.mainInventory.innerHTML = ''
    MAIN_SLOTS.forEach((slot) => {
      const item = getSlotItem(slot)
      const div = buildSlotElement(slot, item, { interactive: true })
      el.mainInventory.appendChild(div)
    })

    el.hotbarInventory.innerHTML = ''
    HOTBAR_SLOTS.forEach((slot, i) => {
      const item = getSlotItem(slot)
      const div = buildSlotElement(slot, item, { selected: i === state.quickBarSlot, interactive: true })
      el.hotbarInventory.appendChild(div)
    })
  }

  function renderPlayers(players) {
    el.playerList.innerHTML = ''
    const heading = document.createElement('h3')
    heading.textContent = `Players (${players.length})`
    el.playerList.appendChild(heading)
    players.forEach((p) => {
      const row = document.createElement('div')
      row.className = 'player-row'
      // displayNameHtml is pre-escaped markup rendered server-side from this
      // player's tab-list display name - team colours, rank prefixes, and
      // anything else the server put there (see botChild.js's emitPlayers).
      const label = p.displayNameHtml || escapeHtml(p.displayName || p.username)
      row.innerHTML = `<span>${label}</span><span>${p.ping ?? '?'}ms</span>`
      el.playerList.appendChild(row)
    })
  }

  function renderCoords(pos) {
    if (!pos) {
      el.coords.textContent = ''
      return
    }
    el.coords.textContent =
      `X ${pos.position.x.toFixed(1)}\nY ${pos.position.y.toFixed(1)}\nZ ${pos.position.z.toFixed(1)}`
  }

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  function renderContainerPanel() {
    const win = state.containerWindow
    if (!win) return
    el.containerTitle.textContent = win.title || 'Container'

    el.containerGrid.innerHTML = ''
    for (let i = 0; i < win.inventoryStart; i++) {
      el.containerGrid.appendChild(buildSlotElement(i, win.slots[i], { interactive: true }))
    }

    el.containerPlayerGrid.innerHTML = ''
    for (let i = win.inventoryStart; i < win.slots.length; i++) {
      el.containerPlayerGrid.appendChild(buildSlotElement(i, win.slots[i], { interactive: true }))
    }
  }

  function openContainerPanel() {
    el.containerPanel.classList.remove('hidden')
    renderContainerPanel()
    if (document.pointerLockElement) document.exitPointerLock()
  }

  function closeContainerPanel() {
    state.containerWindow = null
    el.containerPanel.classList.add('hidden')
  }

  function resetGameState() {
    state.inventorySlots = []
    state.quickBarSlot = 0
    state.dead = false
    state.mining = false
    state.cursorItem = null
    state.hoveredSlot = null
    // Commands belong to the modules loaded on one connection - switching
    // bots must not leave the previous one's commands completable.
    setModuleCommands([])
    completer.hide()
    el.viewerFrame.src = 'about:blank'
    renderHealth({ health: 0, food: 0 })
    renderHotbar()
    renderCursorItem()
    renderPlayers([])
    renderCoords(null)
    el.chatLog.innerHTML = ''
    el.deathScreen.classList.add('hidden')
    closeContainerPanel()
    setStatus('')
    if (document.pointerLockElement) document.exitPointerLock()
  }

  // ---- Active bot switching ----

  function updateActiveBotBadge(status) {
    el.activeBotStatus.textContent = status || 'offline'
    el.activeBotStatus.className = 'status-badge ' + (status || 'offline')
  }

  function setActiveBot(botId, serverId, name) {
    if (state.activeBotId === botId && state.activeServerId === serverId) return
    // Before unsubscribing, not after: once the subscription is gone the
    // server has no bot to route this to, and the one being left would carry
    // on mining.
    stopMining()
    if (state.activeBotId) socket.emit('unsubscribe')
    resetGameState()
    state.activeBotId = botId
    state.activeServerId = serverId

    if (!botId || !serverId) {
      el.activeBotName.textContent = 'No bot selected'
      updateActiveBotBadge('offline')
      el.emptyState.classList.remove('hidden')
      return
    }

    el.emptyState.classList.add('hidden')
    el.activeBotName.textContent = name || 'Bot'
    socket.emit('subscribe', { botId, serverId })
    // This page is the only thing that needs a prismarine-viewer, and it is
    // no longer started automatically for every connection - ask for it here.
    // The bot brings one up (or reports the port it already has) in response.
    // Sent with its own ids: the server cannot rely on the subscribe above
    // having been recorded yet (see socketHandlers.js's requestViewer).
    socket.emit('requestViewer', { botId, serverId })
    setStatus('Starting the 3D view...')
  }

  socket.on('snapshot', (data) => {
    if (data.botId !== state.activeBotId || data.serverId !== state.activeServerId) return
    updateActiveBotBadge(data.status)
    if (data.status === 'online' && data.viewerPort) {
      showViewer()
      // The viewer was already running when this page subscribed, so no
      // 'status' event is coming to clear the "Starting the 3D view..."
      // notice - it has to be cleared here or it sits over a working view.
      setStatus('')
    }
    if (data.health) renderHealth(data.health)
    if (data.inventory) {
      state.inventorySlots = data.inventory.slots
      state.quickBarSlot = data.inventory.quickBarSlot ?? 0
      renderHotbar()
      if (state.inventoryOpen) renderInventoryPanel()
    }
    if (data.position) renderCoords(data.position)
    renderPlayers(data.players || [])
    el.chatLog.innerHTML = ''
    ;(data.chatLog || []).forEach(addChatLine)
    if (data.error) setStatus(data.error)
    setModuleCommands(data.moduleCommands)
    state.cursorItem = data.cursorItem || null
    renderCursorItem()
    if (data.window) {
      state.containerWindow = data.window
      openContainerPanel()
    } else {
      closeContainerPanel()
    }
  })

  socket.on('cursorItem', (item) => {
    state.cursorItem = item
    renderCursorItem()
  })

  // The viewer is served through this origin, at a path the panel proxies
  // to that connection's own prismarine-viewer (see src/viewerProxy.js), so
  // the frame is same-origin and same-scheme and needs no second port open.
  //
  // The trailing slash is load-bearing: prismarine-viewer's bundle builds
  // its socket.io URL as window.location.pathname + 'socket.io', which only
  // lands on the right path when the page's own path ends in one.
  function viewerUrl() {
    if (!state.activeBotId || !state.activeServerId) return 'about:blank'
    return `/viewer/${encodeURIComponent(state.activeBotId)}/${encodeURIComponent(state.activeServerId)}/`
  }

  function showViewer() {
    const url = viewerUrl()
    // Re-assigning the same src reloads the frame and throws away a working
    // world view - status updates arrive far more often than the bot changes.
    if (el.viewerFrame.getAttribute('src') === url) return
    el.viewerFrame.src = url
  }

  socket.on('status', (status) => {
    updateActiveBotBadge(status.status)
    if (status.status === 'online' && status.viewerPort) {
      showViewer()
      // Clears the "Starting the 3D view..." notice put up on subscribe -
      // the viewer is started on demand now, so there's a real wait here.
      setStatus('')
    } else if (status.status !== 'online') {
      el.viewerFrame.src = 'about:blank'
    }
    if (status.error) setStatus(status.error)
  })

  // Automatically shows a window whenever the server pushes one to the bot -
  // covers both the bot opening a chest itself and a server/plugin forcing
  // a window open on it.
  socket.on('windowOpen', (data) => {
    state.containerWindow = data
    openContainerPanel()
  })

  socket.on('windowUpdate', (data) => {
    state.containerWindow = data
    if (!el.containerPanel.classList.contains('hidden')) renderContainerPanel()
  })

  socket.on('windowClose', () => {
    closeContainerPanel()
  })

  socket.on('health', renderHealth)

  socket.on('inventory', (inv) => {
    state.inventorySlots = inv.slots
    state.quickBarSlot = inv.quickBarSlot ?? 0
    renderHotbar()
    if (state.inventoryOpen) renderInventoryPanel()
  })

  socket.on('position', renderCoords)
  socket.on('players', renderPlayers)
  socket.on('chat', addChatLine)

  socket.on('spawn', () => {
    setStatus('')
  })

  socket.on('death', () => {
    state.dead = true
    el.deathScreen.classList.remove('hidden')
    if (document.pointerLockElement) document.exitPointerLock()
  })

  socket.on('kicked', ({ reason }) => setStatus(`Kicked: ${reason}`))
  socket.on('disconnected', ({ reason }) => setStatus(`Disconnected: ${reason}`))
  socket.on('botError', ({ message }) => setStatus(`Error: ${message}`))
  socket.on('actionError', ({ action, message }) => console.warn(`[action:${action}]`, message))

  el.btnLogout.addEventListener('click', async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    location.href = '/login'
  })

  // ---- Startup ----

  async function init() {
    try {
      const { user } = await apiFetch('/api/auth/session')
      if (!user) {
        location.href = '/login'
        return
      }
      el.currentUsername.textContent = user.username
    } catch {
      location.href = '/login'
      return
    }

    let bots = []
    try {
      const data = await apiFetch('/api/bots')
      bots = data.bots
    } catch (err) {
      setStatus(err.message)
    }

    // A bot profile can now have more than one connection running (one per
    // server) - ?bot=&server= picks a specific one; otherwise, fall back to
    // the first connection anywhere that's online or connecting.
    const params = new URLSearchParams(location.search)
    const requestedBotId = params.get('bot')
    const requestedServerId = params.get('server')

    let target = null
    if (requestedBotId && requestedServerId) {
      const bot = bots.find((b) => b.id === requestedBotId)
      const conn = bot?.connections.find((c) => c.serverId === requestedServerId)
      if (bot && conn) target = { bot, conn }
    }
    if (!target) {
      for (const bot of bots) {
        const conn = bot.connections.find((c) => c.status === 'online' || c.status === 'connecting')
        if (conn) {
          target = { bot, conn }
          break
        }
      }
    }

    if (target) {
      setActiveBot(target.bot.id, target.conn.serverId, target.bot.name)
    } else {
      el.emptyState.classList.remove('hidden')
    }
  }

  init()

  // ---- Chat input ----

  function openChat() {
    if (document.pointerLockElement) document.exitPointerLock()
    el.chatInput.classList.add('visible')
    el.chatInput.focus()
  }

  function closeChat() {
    el.chatInput.classList.remove('visible')
    el.chatInput.value = ''
    el.chatInput.blur()
    hideSuggestions()
  }

  // ---- module command completion ----
  //
  // The dropdown itself lives in public/js/chatCommands.js, shared with
  // the per-connection console on the client page. This page only wires it
  // up and keeps its own Enter/Escape behaviour.

  function hideSuggestions() {
    completer.hide()
  }

  el.chatInput.addEventListener('input', () => completer.refresh())

  el.chatInput.addEventListener('keydown', (e) => {
    // Always stopped: the world below this box reads raw keys for
    // movement, and typing "w" must not walk the bot forward.
    e.stopPropagation()

    // Arrow keys, Tab, Enter-on-a-selection and the first Escape belong
    // to the dropdown whenever it is showing something.
    if (completer.handleKeydown(e)) return

    if (e.key === 'Enter') {
      const message = el.chatInput.value.trim()
      if (message) socket.emit('chat', message)
      closeChat()
      return
    }

    if (e.key === 'Escape') closeChat()
  })

  socket.on('moduleCommands', setModuleCommands)

  // ---- Inventory panel ----

  function openInventory() {
    state.inventoryOpen = true
    el.inventoryPanel.classList.remove('hidden')
    renderInventoryPanel()
    if (document.pointerLockElement) document.exitPointerLock()
  }

  function closeInventory() {
    state.inventoryOpen = false
    el.inventoryPanel.classList.add('hidden')
  }

  el.closeInventory.addEventListener('click', closeInventory)

  // Clicking the dimmed backdrop (outside the inventory window itself, but
  // inside the panel overlay) while holding a cursor item drops it - the
  // same as clicking outside the window in vanilla.
  el.inventoryPanel.addEventListener('mousedown', (e) => {
    if (e.target === el.inventoryPanel && state.cursorItem) sendClick(-999, 1, 4)
  })

  // ---- Container (chest, furnace, etc.) ----

  el.closeContainer.addEventListener('click', () => {
    socket.emit('windowClose')
    closeContainerPanel()
  })

  el.containerPanel.addEventListener('mousedown', (e) => {
    if (e.target === el.containerPanel && state.cursorItem) sendClick(-999, 1, 4)
  })

  // ---- Respawn ----

  el.respawnBtn.addEventListener('click', () => {
    socket.emit('respawn')
    state.dead = false
    el.deathScreen.classList.add('hidden')
  })

  // ---- Pointer lock + mouse look ----

  const SENSITIVITY = 0.0022

  el.captureLayer.addEventListener('click', () => {
    if (state.inventoryOpen || state.containerWindow || state.dead || !state.activeBotId) return
    const result = el.captureLayer.requestPointerLock()
    if (result && typeof result.catch === 'function') {
      result.catch(() => {
        setStatus('This browser/frame blocked mouse-look (pointer lock). Try opening the page in its own tab.')
      })
    }
  })

  document.addEventListener('pointerlockchange', () => {
    state.pointerLocked = document.pointerLockElement === el.captureLayer
    el.clickHint.classList.toggle('hidden', state.pointerLocked)
    // Escape releases the pointer without ever sending a mouseup, so the
    // button has to be treated as released here too.
    if (!state.pointerLocked) stopMining()
  })

  document.addEventListener('mousemove', (e) => {
    if (!state.pointerLocked) return
    state.yaw -= e.movementX * SENSITIVITY
    state.pitch -= e.movementY * SENSITIVITY
    state.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, state.pitch))
    state.yaw = ((state.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  })

  setInterval(() => {
    if (state.pointerLocked) {
      socket.emit('look', { yaw: state.yaw, pitch: state.pitch })
    }
  }, 50)

  // Mining is held, not clicked. The button going down starts it and the
  // button coming up stops it, so one press breaks a block that takes
  // several seconds and then carries on to the next one under the crosshair
  // - the same as holding the button in the real game.
  //
  // Clicks carry the aim they were made with. Look updates go out on a 50ms
  // timer, so on a fast flick the bot's head can still be a frame behind
  // what the crosshair was over; the server points it exactly here before it
  // works out which block that is.
  function stopMining() {
    if (!state.mining) return
    state.mining = false
    socket.emit('stopMining')
  }

  el.captureLayer.addEventListener('mousedown', (e) => {
    if (!state.pointerLocked) return
    if (e.button === 0) {
      state.mining = true
      socket.emit('startMining', { yaw: state.yaw, pitch: state.pitch })
    }
    if (e.button === 2) socket.emit('rightClick', { yaw: state.yaw, pitch: state.pitch })
  })

  // On the document rather than the capture layer, and mirrored by blur:
  // releasing the button after the cursor has left the page - or alt-tabbing
  // away mid-swing - still has to stop the bot mining, or it never stops.
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) stopMining()
  })
  window.addEventListener('blur', stopMining)

  el.captureLayer.addEventListener('contextmenu', (e) => e.preventDefault())

  // ---- Keyboard controls ----

  const KEY_TO_CONTROL = {
    KeyW: 'forward',
    KeyS: 'back',
    KeyA: 'left',
    KeyD: 'right',
    Space: 'jump',
    ShiftLeft: 'sneak',
    ControlLeft: 'sprint',
  }

  const activeControls = new Set()

  function isTypingTarget() {
    const tag = document.activeElement?.tagName
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
  }

  window.addEventListener('keydown', (e) => {
    if (isTypingTarget()) return

    if (e.code === 'Enter' || e.code === 'Slash') {
      e.preventDefault()
      openChat()
      return
    }

    if (e.code === 'KeyE') {
      e.preventDefault()
      if (state.containerWindow) {
        socket.emit('windowClose')
        closeContainerPanel()
      } else if (state.inventoryOpen) {
        closeInventory()
      } else {
        openInventory()
      }
      return
    }

    if (e.code === 'Escape') {
      if (state.containerWindow) {
        socket.emit('windowClose')
        closeContainerPanel()
      }
      if (state.inventoryOpen) closeInventory()
      if (document.pointerLockElement) document.exitPointerLock()
      return
    }

    if (e.code === 'Tab') {
      e.preventDefault()
      el.playerList.classList.remove('hidden')
      return
    }

    if (e.code === 'KeyQ') {
      e.preventDefault()
      if (state.hoveredSlot !== null) {
        // Hovering a slot in an open inventory/container panel: drop one
        // (or the whole stack with Ctrl held) from that specific slot,
        // vanilla-style - not necessarily the held hotbar item.
        sendClick(state.hoveredSlot, e.ctrlKey || e.metaKey ? 1 : 0, 4)
      } else {
        const slot = HOTBAR_SLOTS[state.quickBarSlot]
        socket.emit('dropSlot', slot)
      }
      return
    }

    if (/^Digit[1-9]$/.test(e.code)) {
      const n = parseInt(e.code.replace('Digit', ''), 10) - 1
      if (state.hoveredSlot !== null) {
        // Hovering a slot in an open inventory/container panel: swap it
        // with hotbar slot n, vanilla-style.
        sendClick(state.hoveredSlot, n, 2)
      } else {
        socket.emit('selectSlot', n)
      }
      return
    }

    const control = KEY_TO_CONTROL[e.code]
    if (control && !activeControls.has(control)) {
      activeControls.add(control)
      socket.emit('move', { control, state: true })
    }
  })

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') {
      el.playerList.classList.add('hidden')
      return
    }
    const control = KEY_TO_CONTROL[e.code]
    if (control && activeControls.has(control)) {
      activeControls.delete(control)
      socket.emit('move', { control, state: false })
    }
  })

  window.addEventListener('blur', () => {
    activeControls.forEach((control) => socket.emit('move', { control, state: false }))
    activeControls.clear()
  })

  // Site-wide maintenance/announcement banner (admin-configurable, see the
  // Admin page's Website settings card) - the Play page is a standalone HTML
  // page that doesn't include partials/nav.ejs or nav.js, so without this it
  // never showed the banner shown everywhere else in the app.
  ;(async () => {
    try {
      const res = await fetch('/api/public-settings')
      const settings = await res.json()
      const lines = []
      if (settings.maintenanceMode && settings.maintenanceMessage) {
        lines.push({ cls: 'warning', text: `Maintenance mode: ${settings.maintenanceMessage}` })
      }
      if (settings.announcementBanner) {
        lines.push({ cls: 'success', text: settings.announcementBanner })
      }
      if (!lines.length) return
      const banner = document.getElementById('site-banner')
      lines.forEach(({ cls, text }) => {
        const line = document.createElement('div')
        line.className = `banner-line ${cls}`
        line.textContent = text
        banner.appendChild(line)
      })
      banner.classList.remove('hidden')
    } catch {
      // non-critical - a failed fetch just means no banner, not a broken page
    }
  })()
})()
