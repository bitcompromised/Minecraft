(() => {
  const errorBox = document.getElementById('bots-error')
  const botsList = document.getElementById('bots-list')
  const searchInput = document.getElementById('bots-search')
  const pagerBar = document.getElementById('bots-pager')

  let ownedModules = []
  let servers = []
  let proxies = []
  let pollHandle = null
  let searchDebounce = null

  const pageState = { q: '', page: 1, pageSize: 10 }
  // The bots list re-renders from scratch on every poll - track which
  // connections' log/error panels are open so that doesn't collapse them
  // back out from under whoever's reading one. Keyed by "profileId:serverId"
  // since a profile can now have more than one connection running at once.
  const expandedLogs = new Set()
  const expandedErrors = new Set()
  const errorSearch = new Map() // connKey -> current search term
  const expandedSeen = new Set()
  const seenSearch = new Map() // connKey -> current search term
  const logLevelFilter = new Map() // connKey -> 'all' | 'error'
  // Live chat consoles, keyed the same way. These outlive the 5s re-render:
  // the DOM nodes are re-appended rather than rebuilt, so an open console
  // keeps its socket, its scroll position, and whatever is half-typed in it.
  const chatPanels = new Map() // connKey -> chat console entry

  // Which bots are minimised down to their summary line. Persisted, because
  // a preference that resets on every page load isn't a preference - and
  // survives the 5s re-render for the same reason the log panels do.
  const COLLAPSED_KEY = 'client.collapsedBots'

  function readCollapsedBots() {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch {
      return new Set()
    }
  }

  function persistCollapsedBots() {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedBots]))
    } catch {
      // Private mode or a full quota - collapsing still works for this
      // session, it just won't be remembered.
    }
  }

  const collapsedBots = readCollapsedBots()

  // Every dropdown on this page is rebuilt from scratch on the 5s poll,
  // which used to snap whatever the operator had picked back to the first
  // option mid-interaction. Their choices are remembered here, keyed by
  // something stable (bot id + purpose), and restored on each rebuild.
  const selectChoices = new Map()

  function rememberSelect(key, selectEl) {
    const previous = selectChoices.get(key)
    if (previous !== undefined && Array.from(selectEl.options).some((o) => o.value === previous)) {
      selectEl.value = previous
    } else if (previous !== undefined) {
      // The remembered option is gone (server deleted, module unloaded).
      // Drop it so a later rebuild doesn't keep trying to restore it.
      selectChoices.delete(key)
    }
    selectEl.addEventListener('change', () => selectChoices.set(key, selectEl.value))
    return selectEl
  }

  function connKey(botId, serverId) {
    return `${botId}:${serverId}`
  }

  function showError(message) {
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  function clearError() {
    errorBox.classList.add('hidden')
  }

  async function apiFetch(url, options) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Request failed.')
    return data
  }

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  function statusLabel(conn) {
    if (conn.status === 'error' && conn.error) return `error: ${conn.error}`
    return conn.status
  }

  function renderPager(meta) {
    pagerBar.innerHTML = ''
    const info = document.createElement('span')
    info.textContent = `${meta.total} bot${meta.total === 1 ? '' : 's'} - page ${meta.page} of ${meta.totalPages}`
    pagerBar.appendChild(info)

    const prevBtn = document.createElement('button')
    prevBtn.className = 'btn small'
    prevBtn.textContent = 'Prev'
    prevBtn.disabled = meta.page <= 1
    prevBtn.addEventListener('click', () => { pageState.page = Math.max(1, pageState.page - 1); refresh() })
    pagerBar.appendChild(prevBtn)

    const nextBtn = document.createElement('button')
    nextBtn.className = 'btn small'
    nextBtn.textContent = 'Next'
    nextBtn.disabled = meta.page >= meta.totalPages
    nextBtn.addEventListener('click', () => { pageState.page = Math.min(meta.totalPages, pageState.page + 1); refresh() })
    pagerBar.appendChild(nextBtn)

    const sizeSelect = document.createElement('select')
    ;[10, 25, 50].forEach((n) => {
      const opt = document.createElement('option')
      opt.value = n
      opt.textContent = `${n} / page`
      if (n === pageState.pageSize) opt.selected = true
      sizeSelect.appendChild(opt)
    })
    sizeSelect.addEventListener('change', () => {
      pageState.pageSize = parseInt(sizeSelect.value, 10)
      pageState.page = 1
      refresh()
    })
    pagerBar.appendChild(sizeSelect)
  }

  function renderLogEntry(entry) {
    const div = document.createElement('div')
    div.className = 'log-entry log-level-' + (entry.level || 'info')
    const sourceLabel = entry.source && entry.source !== 'connection' ? ` <span class="log-source">[${escapeHtml(entry.source)}]</span>` : ''
    div.innerHTML = `<span class="log-time">${new Date(entry.createdAt).toLocaleString()}</span><span class="badge ${entry.level || 'info'}">${entry.level || 'info'}</span>${sourceLabel} ${escapeHtml(entry.message)}`
    return div
  }

  // Keeps a collapsible section's handle in sync with its panel: the caret
  // and open styling come from .log-toggle/.log-toggle.open in panel.css, so
  // the label here stays plain text.
  function setToggleState(btn, label, open, count) {
    btn.classList.toggle('open', open)
    btn.textContent = label
    if (count !== undefined && count !== null) {
      const pill = document.createElement('span')
      pill.className = 'toggle-count' + (count > 0 && btn.dataset.countStyle === 'alert' ? ' alert-count' : '')
      pill.textContent = count
      btn.appendChild(pill)
    }
  }

  // A module error is usually a multi-line stack trace, which is unreadable
  // squeezed into a log row. Each one gets its own <details> box: collapsed
  // it shows a one-line headline, expanded it shows the whole message.
  function renderErrorBox(entry, { open = false } = {}) {
    const box = document.createElement('details')
    box.className = 'error-box'
    box.open = open

    const message = entry.message || ''
    // The headline is the first line; the body keeps everything.
    const headline = message.split('\n')[0].slice(0, 200) || '(no message)'
    const source = entry.source && entry.source !== 'connection' ? entry.source : null

    const summary = document.createElement('summary')
    summary.innerHTML = `
      <span class="err-time">${new Date(entry.createdAt).toLocaleTimeString()}</span>
      ${source ? `<span class="err-source">${escapeHtml(source)}</span>` : ''}
      <span class="err-headline">${escapeHtml(headline)}</span>
    `
    box.appendChild(summary)

    const body = document.createElement('pre')
    body.className = 'err-body'
    body.textContent = `${new Date(entry.createdAt).toLocaleString()}\n\n${message}`
    box.appendChild(body)

    return box
  }

  async function loadConnLogs(botId, serverId, container, level) {
    container.innerHTML = '<div class="empty-note">Loading...</div>'
    try {
      const params = new URLSearchParams({ serverId, pageSize: 50 })
      if (level === 'error') params.set('level', 'error')
      const { logs } = await apiFetch(`/api/bots/${botId}/logs?${params}`)
      container.innerHTML = ''
      if (logs.length === 0) {
        container.innerHTML = `<div class="empty-note">No${level === 'error' ? ' errors' : ' logs'} for this connection.</div>`
        return
      }
      logs.forEach((entry) => container.appendChild(renderLogEntry(entry)))
    } catch (err) {
      container.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    }
  }

  // Module errors reset every time this connection is (re)started, along
  // with the rest of its in-memory log (see botManager.js's getLog()) -
  // this is deliberate, not a bug, so a fresh start always starts clean.
  async function loadConnErrors(botId, serverId, listEl, toggleBtn) {
    listEl.innerHTML = '<div class="empty-note">Loading...</div>'
    try {
      const q = errorSearch.get(connKey(botId, serverId)) || ''
      const params = new URLSearchParams({ serverId, pageSize: 50, q })
      const { errors } = await apiFetch(`/api/bots/${botId}/errors?${params}`)
      listEl.innerHTML = ''
      if (toggleBtn) setToggleState(toggleBtn, 'Hide module errors', true, errors.length)
      if (errors.length === 0) {
        listEl.innerHTML = '<div class="empty-note">No module errors for this connection (since it was last started).</div>'
        return
      }
      // The newest error is the one you opened this panel to read, so it
      // starts expanded; older ones stay collapsed to a single headline.
      errors.forEach((entry, i) => listEl.appendChild(renderErrorBox(entry, { open: i === 0 })))
    } catch (err) {
      listEl.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    }
  }

  // ---- who this bot has seen ----
  //
  // The durable sighting history for one connection (see
  // db.recordPlayerSightings): every player this bot has met on this server,
  // across every session it has ever had there - not just the current one.

  // "3 minutes ago" reads better than a timestamp for something that may
  // have happened seconds or months ago, which is exactly this list.
  function timeAgo(timestamp) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 60) return `${seconds}s ago`
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
  }

  function renderSeenPlayer(player) {
    const row = document.createElement('div')
    row.className = 'seen-row'

    const name = document.createElement('span')
    name.className = 'seen-name' + (player.online ? ' online' : '')
    name.textContent = player.username
    row.appendChild(name)

    const last = document.createElement('span')
    last.className = 'seen-last'
    // Someone standing in front of the bot right now has a last-seen time
    // that is technically true and completely uninformative.
    last.textContent = player.online ? 'online now' : `last seen ${timeAgo(player.lastSeenAt)}`
    last.title = new Date(player.lastSeenAt).toLocaleString()
    row.appendChild(last)

    const first = document.createElement('span')
    first.className = 'seen-first'
    first.textContent = `first seen ${timeAgo(player.firstSeenAt)}`
    first.title = new Date(player.firstSeenAt).toLocaleString()
    row.appendChild(first)

    if (player.connections > 1) {
      const sessions = document.createElement('span')
      sessions.className = 'seen-sessions'
      sessions.textContent = `${player.connections} sessions`
      sessions.title = `Seen during ${player.connections} separate connections`
      row.appendChild(sessions)
    }

    return row
  }

  async function loadSeenPlayers(botId, serverId, listEl, toggleBtn) {
    listEl.innerHTML = '<div class="empty-note">Loading...</div>'
    try {
      const search = seenSearch.get(connKey(botId, serverId)) || ''
      const params = new URLSearchParams({ serverId, limit: 200, search })
      const { players, total } = await apiFetch(`/api/bots/${botId}/seen-players?${params}`)
      listEl.innerHTML = ''
      if (toggleBtn) setToggleState(toggleBtn, 'Hide seen players', true, total)
      if (players.length === 0) {
        listEl.innerHTML = search
          ? '<div class="empty-note">Nobody matching that name.</div>'
          : '<div class="empty-note">This bot has not seen anyone on this server yet.</div>'
        return
      }
      players.forEach((player) => listEl.appendChild(renderSeenPlayer(player)))
      if (total > players.length) {
        const note = document.createElement('div')
        note.className = 'empty-note'
        note.textContent = `Showing the ${players.length} most recently seen of ${total}. Search by name, or download the full list.`
        listEl.appendChild(note)
      }
    } catch (err) {
      listEl.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    }
  }

  // ==========================================================================
  // Live chat console
  //
  // The socket protocol subscribes a socket to exactly one (profile, server)
  // pair at a time (see src/socketHandlers.js), so watching two connections
  // at once genuinely needs two sockets - hence forceNew, which opts out of
  // socket.io's default habit of sharing one underlying connection.
  // ==========================================================================

  // Pins the console to the newest line. Deferred to the next frame because
  // the panel is often laid out in the same tick it's populated, and
  // scrollHeight is still 0 until the browser has measured it.
  function scrollChatToLatest(log) {
    requestAnimationFrame(() => { log.scrollTop = log.scrollHeight })
  }

  // How close to the bottom still counts as "following the conversation".
  // Never test this with an equality: fractional line heights and sub-pixel
  // scroll positions mean scrollTop + clientHeight usually lands a hair
  // short of scrollHeight even when the log is scrolled all the way down.
  const CHAT_PIN_SLACK_PX = 24

  function isChatPinned(log) {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= CHAT_PIN_SLACK_PX
  }

  // The bots list is rebuilt from scratch on every poll, which detaches every
  // row - and a detached element's scrollTop resets to 0, so an open console
  // would silently jump to the top of its backlog every few seconds. The
  // console's own nodes survive (they are cached in chatPanels and
  // re-appended), but their scroll position does not, so it is carried across
  // by hand.
  function captureChatScroll() {
    const saved = new Map()
    chatPanels.forEach((entry, key) => {
      if (!entry.open) return
      saved.set(key, { top: entry.log.scrollTop, pinned: isChatPinned(entry.log) })
    })
    return saved
  }

  function restoreChatScroll(saved) {
    saved.forEach((position, key) => {
      const entry = chatPanels.get(key)
      if (!entry || !entry.open) return
      // Someone who was following the conversation should still be following
      // it, even if lines arrived during the re-render.
      entry.log.scrollTop = position.pinned ? entry.log.scrollHeight : position.top
    })
  }

  function appendChatLine(log, { message, html, kind }) {
    const placeholder = log.querySelector('.placeholder')
    if (placeholder) placeholder.remove()
    const line = document.createElement('div')
    // 'command' is a module command typed here: handled by a module rather
    // than sent to the server, and echoed back so there is a record of it.
    line.className = 'line'
      + (kind && kind !== 'chat' ? ' system' : '')
      + (kind === 'command' ? ' command' : '')
    if (html) {
      // Pre-escaped server-side by prismarine-chat's toHTML(), or rendered
      // from legacy section-sign codes (see src/mcFormat.js) - never built
      // from raw player text on this side.
      line.innerHTML = html
    } else {
      line.textContent = message
    }
    // Whether to follow the new line is decided from where the log was
    // *before* it was added - afterwards, everything is one line further
    // from the bottom and the answer would always be no.
    const pinned = isChatPinned(log)
    log.appendChild(line)

    // Trimming the backlog removes lines from the top, so everything below
    // shifts up by however much they were worth. scrollTop does not move
    // with it, so without this the view jumps every time the cap is hit.
    const heightBeforeTrim = log.scrollHeight
    while (log.children.length > 300) log.removeChild(log.firstChild)
    const trimmedHeight = heightBeforeTrim - log.scrollHeight

    if (pinned) {
      scrollChatToLatest(log)
    } else if (trimmedHeight > 0) {
      // Someone is reading back through the log. Keep the line they were
      // looking at exactly where it was.
      log.scrollTop = Math.max(0, log.scrollTop - trimmedHeight)
    }
  }

  function setChatStatus(entry, status) {
    const online = status === 'online'
    entry.input.disabled = !online
    entry.sendBtn.disabled = !online
    entry.statusEl.textContent = online
      ? 'Connected - anything you send goes out as this bot.'
      : `Bot is ${status || 'offline'} - chat is read-only until it comes online.`
  }

  function openChat(entry) {
    entry.open = true
    entry.panel.classList.remove('hidden')
    setToggleState(entry.toggle, 'Hide chat', true)
    entry.log.innerHTML = '<div class="placeholder">Connecting to the bot...</div>'

    const socket = io({ forceNew: true })
    entry.socket = socket

    socket.on('connect', () => socket.emit('subscribe', { botId: entry.botId, serverId: entry.serverId }))

    socket.on('snapshot', (data) => {
      entry.log.innerHTML = ''
      const history = data.chatLog || []
      if (history.length === 0) {
        entry.log.innerHTML = '<div class="placeholder">No chat on this connection yet.</div>'
      } else {
        history.forEach((line) => appendChatLine(entry.log, line))
        // Opening a console lands on the newest message, not the oldest -
        // the backlog is history, the bottom is what's happening now.
        scrollChatToLatest(entry.log)
      }
      // What this connection's loaded modules answer to, so the box can
      // complete their commands from the moment the console opens.
      entry.completer.setCommands(data.moduleCommands)
      setChatStatus(entry, data.status)
    })

    socket.on('chat', (line) => appendChatLine(entry.log, line))
    // Pushed whenever a module is loaded or unloaded on this connection.
    socket.on('moduleCommands', (list) => entry.completer.setCommands(list))
    socket.on('status', (s) => setChatStatus(entry, s.status))
    socket.on('disconnect', () => {
      entry.input.disabled = true
      entry.sendBtn.disabled = true
      entry.statusEl.textContent = 'Lost the panel connection - close and reopen this console to retry.'
    })
  }

  function closeChat(entry) {
    entry.open = false
    entry.panel.classList.add('hidden')
    setToggleState(entry.toggle, 'Show chat', false)
    // The console keeps its DOM between opens, so a dropdown left showing
    // would still be there - listing commands from a socket that is gone.
    entry.completer.hide()
    entry.completer.setCommands([])
    if (entry.socket) {
      entry.socket.disconnect()
      entry.socket = null
    }
  }

  function getChatPanel(bot, conn) {
    const key = connKey(bot.id, conn.serverId)
    const existing = chatPanels.get(key)
    if (existing) return existing

    const toggle = document.createElement('button')
    toggle.className = 'log-toggle'
    toggle.type = 'button'
    setToggleState(toggle, 'Show chat', false)

    const panel = document.createElement('div')
    panel.className = 'log-panel hidden'

    const box = document.createElement('div')
    box.className = 'chat-console'

    const log = document.createElement('div')
    log.className = 'chat-log'

    // Command completion, fed by whatever the modules loaded on this
    // connection declare (see public/js/chatCommands.js). Sits between the
    // log and the input, the same way it does on the 3D view.
    const suggestions = document.createElement('div')
    suggestions.className = 'chat-suggestions hidden'

    const inputRow = document.createElement('div')
    inputRow.className = 'chat-input-row'

    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 256
    input.placeholder = 'Type a message, or / for module commands...'
    input.disabled = true
    input.autocomplete = 'off'

    const sendBtn = document.createElement('button')
    sendBtn.className = 'btn small primary'
    sendBtn.type = 'button'
    sendBtn.textContent = 'Send'
    sendBtn.disabled = true

    inputRow.appendChild(input)
    inputRow.appendChild(sendBtn)

    const statusEl = document.createElement('div')
    statusEl.className = 'chat-status'

    box.appendChild(log)
    box.appendChild(suggestions)
    box.appendChild(inputRow)
    box.appendChild(statusEl)
    panel.appendChild(box)

    const completer = ChatCommands.create({ input, container: suggestions })

    const entry = {
      key, botId: bot.id, serverId: conn.serverId,
      toggle, panel, log, input, sendBtn, statusEl, completer,
      socket: null, open: false,
    }

    function send() {
      const text = input.value.trim()
      if (!text || !entry.socket) return
      entry.socket.emit('chat', text)
      input.value = ''
      completer.hide()
    }

    sendBtn.addEventListener('click', send)
    input.addEventListener('input', () => completer.refresh())
    input.addEventListener('keydown', (e) => {
      // Arrow keys, Tab, Enter-on-a-selection and Escape belong to the
      // completion dropdown whenever it is showing something.
      if (completer.handleKeydown(e)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        send()
      }
    })

    toggle.addEventListener('click', () => {
      if (entry.open) closeChat(entry)
      else openChat(entry)
    })

    chatPanels.set(key, entry)
    return entry
  }

  // One connection = one server this profile is currently running against.
  function renderConnection(bot, conn) {
    const key = connKey(bot.id, conn.serverId)
    const row = document.createElement('div')
    row.className = 'conn-block'

    const top = document.createElement('div')
    top.className = 'conn-head'
    top.innerHTML = `
      <div class="row-main">
        <div class="row-title">${conn.server ? escapeHtml(conn.server.name) : 'Unknown server'}</div>
        <div class="row-sub">${statusLabel(conn)}${conn.server ? ` &middot; ${escapeHtml(conn.server.host)}:${conn.server.port}` : ''}${conn.proxyName ? ` &middot; via ${escapeHtml(conn.proxyName)}` : ''}</div>
      </div>
      <span class="badge ${conn.status}">${conn.status}</span>
    `

    const watchLink = document.createElement('a')
    watchLink.className = 'btn small'
    watchLink.href = `/play?bot=${encodeURIComponent(bot.id)}&server=${encodeURIComponent(conn.serverId)}`
    watchLink.textContent = 'Watch in 3D'
    top.appendChild(watchLink)

    const isRunning = conn.status === 'online' || conn.status === 'connecting'
    if (isRunning) {
      const stopBtn = document.createElement('button')
      stopBtn.className = 'btn small'
      stopBtn.textContent = 'Stop'
      stopBtn.addEventListener('click', async () => {
        stopBtn.disabled = true
        try {
          await apiFetch(`/api/bots/${bot.id}/stop`, { method: 'POST', body: JSON.stringify({ serverId: conn.serverId }) })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
        stopBtn.disabled = false
      })
      top.appendChild(stopBtn)
    } else {
      // Offline/error connections can be restarted on the same server
      // directly, without going through the "start a new connection" picker
      // below (which is for picking a *different* server).
      const restartBtn = document.createElement('button')
      restartBtn.className = 'btn small primary'
      restartBtn.textContent = 'Start'
      restartBtn.addEventListener('click', async () => {
        restartBtn.disabled = true
        try {
          await apiFetch(`/api/bots/${bot.id}/start`, { method: 'POST', body: JSON.stringify({ serverId: conn.serverId }) })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
        restartBtn.disabled = false
      })
      top.appendChild(restartBtn)

      // Cleanly-stopped connections are pruned automatically when the profile
      // starts somewhere else; ones that ended in an error are kept so their
      // status and logs stay readable. This is how you clear those out once
      // you've finished with them.
      const removeBtn = document.createElement('button')
      removeBtn.className = 'btn small danger'
      removeBtn.textContent = 'Remove'
      removeBtn.title = 'Remove this server from the connection list. The saved server itself is not deleted.'
      removeBtn.addEventListener('click', async () => {
        const serverName = conn.server ? conn.server.name : 'this server'
        const ok = await Dialog.confirm({
          title: `Remove ${serverName} from this bot?`,
          intro: 'Only the connection row and its logs go away. The saved server stays on the Servers tab, and you can start the bot on it again at any time.',
          confirmLabel: 'Remove connection',
          danger: true,
        })
        if (!ok) return
        try {
          await apiFetch(`/api/bots/${bot.id}/connections/${encodeURIComponent(conn.serverId)}`, { method: 'DELETE' })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
      })
      top.appendChild(removeBtn)
    }

    row.appendChild(top)

    // ---- first-time Microsoft sign-in prompt ----
    if (conn.authPrompt) {
      const prompt = document.createElement('div')
      prompt.className = 'alert warning'
      prompt.style.marginTop = '10px'
      prompt.innerHTML = `
        <strong>First-time sign-in required for ${escapeHtml(bot.mcUsername)}.</strong>
        Open <a href="${escapeHtml(conn.authPrompt.url)}" target="_blank" rel="noopener">${escapeHtml(conn.authPrompt.url)}</a>
        and enter the code <strong>${escapeHtml(conn.authPrompt.code)}</strong>.
      `
      row.appendChild(prompt)
    }

    // ---- modules ----
    const modulesBox = document.createElement('div')
    modulesBox.style.marginTop = '10px'

    const loadedTitle = document.createElement('div')
    loadedTitle.className = 'row-sub'
    loadedTitle.style.marginBottom = '6px'
    loadedTitle.textContent = conn.loadedModules.length
      ? `Loaded modules: ${conn.loadedModules.map((m) => m.name).join(', ')}`
      : 'No modules loaded on this connection.'
    modulesBox.appendChild(loadedTitle)

    if (conn.loadedModules.length > 0) {
      const unloadRow = document.createElement('div')
      unloadRow.style.display = 'flex'
      unloadRow.style.gap = '6px'
      unloadRow.style.flexWrap = 'wrap'
      unloadRow.style.marginBottom = '8px'
      conn.loadedModules.forEach((m) => {
        const unloadBtn = document.createElement('button')
        unloadBtn.className = 'btn small danger'
        unloadBtn.textContent = `Unload ${m.name}`
        unloadBtn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/bots/${bot.id}/modules/${m.id}/unload`, { method: 'POST', body: JSON.stringify({ serverId: conn.serverId }) })
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        unloadRow.appendChild(unloadBtn)
      })
      modulesBox.appendChild(unloadRow)
    }

    const loadedIds = new Set(conn.loadedModules.map((m) => m.id))
    const available = ownedModules.filter((m) => !loadedIds.has(m.id))

    if (conn.status === 'online' && available.length > 0) {
      const loadRow = document.createElement('div')
      loadRow.style.display = 'flex'
      loadRow.style.gap = '6px'

      const select = document.createElement('select')
      available.forEach((m) => {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.name
        select.appendChild(opt)
      })
      rememberSelect(`${key}:module`, select)
      loadRow.appendChild(select)

      const loadBtn = document.createElement('button')
      loadBtn.className = 'btn small primary'
      loadBtn.textContent = 'Load module'
      loadBtn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/bots/${bot.id}/modules/${select.value}/load`, { method: 'POST', body: JSON.stringify({ serverId: conn.serverId }) })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
      })
      loadRow.appendChild(loadBtn)
      modulesBox.appendChild(loadRow)
    } else if (conn.status !== 'online') {
      const hint = document.createElement('div')
      hint.className = 'row-sub'
      hint.textContent = 'Bot must be online to load modules.'
      modulesBox.appendChild(hint)
    } else if (ownedModules.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'row-sub'
      hint.innerHTML = 'You don\'t own any modules yet. Visit the <a href="/marketplace">Marketplace</a>.'
      modulesBox.appendChild(hint)
    }

    row.appendChild(modulesBox)

    // All three section handles sit together on one row; their panels are
    // appended below it in the order they're opened.
    const toggleRow = document.createElement('div')
    toggleRow.className = 'toggle-row'
    row.appendChild(toggleRow)

    // ---- live chat, minimized by default ----
    // Re-appending the existing nodes (rather than rebuilding them) is what
    // keeps an open console alive across the list's periodic re-render.
    const chat = getChatPanel(bot, conn)
    toggleRow.appendChild(chat.toggle)
    row.appendChild(chat.panel)

    // ---- logs / error logs, minimized by default ----
    // One panel, two views (all logs vs. errors only) via the pills below -
    // the errors-only view still always includes the four lifecycle
    // milestones (process started/connecting/client created/connected;
    // see routes/bots.js's /:id/logs) so you can always tell how far a
    // connection got even while filtered down to errors.
    const isExpanded = expandedLogs.has(key)
    const logToggle = document.createElement('button')
    logToggle.className = 'log-toggle'
    logToggle.type = 'button'
    setToggleState(logToggle, isExpanded ? 'Hide logs' : 'Show logs', isExpanded)
    const logPanel = document.createElement('div')
    logPanel.className = 'log-panel' + (isExpanded ? '' : ' hidden')

    const logFilterBar = document.createElement('div')
    logFilterBar.style.marginBottom = '6px'
    logFilterBar.style.display = 'flex'
    logFilterBar.style.gap = '6px'
    const currentLevel = logLevelFilter.get(key) || 'all'
    const logContent = document.createElement('div')
    ;['all', 'error'].forEach((level) => {
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'btn small' + (currentLevel === level ? ' primary' : '')
      pill.textContent = level === 'all' ? 'All' : 'Errors only'
      pill.addEventListener('click', async () => {
        logLevelFilter.set(key, level)
        Array.from(logFilterBar.children).forEach((btn, i) => {
          btn.classList.toggle('primary', ['all', 'error'][i] === level)
        })
        await loadConnLogs(bot.id, conn.serverId, logContent, level)
      })
      logFilterBar.appendChild(pill)
    })
    logPanel.appendChild(logFilterBar)
    logPanel.appendChild(logContent)

    logToggle.addEventListener('click', async () => {
      const nowHidden = logPanel.classList.toggle('hidden')
      setToggleState(logToggle, nowHidden ? 'Show logs' : 'Hide logs', !nowHidden)
      if (nowHidden) {
        expandedLogs.delete(key)
      } else {
        expandedLogs.add(key)
        await loadConnLogs(bot.id, conn.serverId, logContent, logLevelFilter.get(key) || 'all')
      }
    })
    toggleRow.appendChild(logToggle)
    row.appendChild(logPanel)
    if (isExpanded) loadConnLogs(bot.id, conn.serverId, logContent, currentLevel)

    // ---- module errors, minimized by default, searchable ----
    const errorsExpanded = expandedErrors.has(key)
    const errorsToggle = document.createElement('button')
    errorsToggle.className = 'log-toggle'
    errorsToggle.type = 'button'
    // Its count pill is a warning colour when non-zero, unlike the others.
    errorsToggle.dataset.countStyle = 'alert'
    setToggleState(errorsToggle, errorsExpanded ? 'Hide module errors' : 'Show module errors', errorsExpanded)
    const errorsPanel = document.createElement('div')
    errorsPanel.className = 'log-panel' + (errorsExpanded ? '' : ' hidden')

    const errorsSearchInput = document.createElement('input')
    errorsSearchInput.type = 'search'
    errorsSearchInput.placeholder = 'Search module errors...'
    errorsSearchInput.value = errorSearch.get(key) || ''
    errorsSearchInput.style.marginBottom = '6px'
    errorsSearchInput.style.width = '100%'
    let errorsSearchDebounce = null
    errorsSearchInput.addEventListener('input', () => {
      clearTimeout(errorsSearchDebounce)
      errorsSearchDebounce = setTimeout(() => {
        errorSearch.set(key, errorsSearchInput.value)
        loadConnErrors(bot.id, conn.serverId, errorsList, errorsToggle)
      }, 300)
    })
    const errorsList = document.createElement('div')
    errorsPanel.appendChild(errorsSearchInput)
    errorsPanel.appendChild(errorsList)

    errorsToggle.addEventListener('click', async () => {
      const nowHidden = errorsPanel.classList.toggle('hidden')
      if (nowHidden) {
        expandedErrors.delete(key)
        setToggleState(errorsToggle, 'Show module errors', false)
      } else {
        expandedErrors.add(key)
        // loadConnErrors sets the open label + count once it knows how many
        // there are, and expands the newest error inside the panel.
        setToggleState(errorsToggle, 'Hide module errors', true)
        await loadConnErrors(bot.id, conn.serverId, errorsList, errorsToggle)
      }
    })
    toggleRow.appendChild(errorsToggle)
    row.appendChild(errorsPanel)
    if (errorsExpanded) loadConnErrors(bot.id, conn.serverId, errorsList, errorsToggle)

    // ---- seen players, minimized by default, searchable ----
    // Unlike the log and error panels above, this one survives restarts: it
    // is read from the database, not from the running connection.
    const seenExpanded = expandedSeen.has(key)
    const seenToggle = document.createElement('button')
    seenToggle.className = 'log-toggle'
    seenToggle.type = 'button'
    setToggleState(seenToggle, seenExpanded ? 'Hide seen players' : 'Show seen players', seenExpanded)
    const seenPanel = document.createElement('div')
    seenPanel.className = 'log-panel' + (seenExpanded ? '' : ' hidden')

    const seenSearchInput = document.createElement('input')
    seenSearchInput.type = 'search'
    seenSearchInput.placeholder = 'Search by username...'
    seenSearchInput.value = seenSearch.get(key) || ''
    seenSearchInput.style.marginBottom = '6px'
    seenSearchInput.style.width = '100%'
    let seenSearchDebounce = null
    seenSearchInput.addEventListener('input', () => {
      clearTimeout(seenSearchDebounce)
      seenSearchDebounce = setTimeout(() => {
        seenSearch.set(key, seenSearchInput.value)
        loadSeenPlayers(bot.id, conn.serverId, seenList, seenToggle)
      }, 300)
    })
    const seenList = document.createElement('div')
    seenList.className = 'seen-list'
    seenPanel.appendChild(seenSearchInput)
    seenPanel.appendChild(seenList)

    seenToggle.addEventListener('click', async () => {
      const nowHidden = seenPanel.classList.toggle('hidden')
      if (nowHidden) {
        expandedSeen.delete(key)
        setToggleState(seenToggle, 'Show seen players', false)
      } else {
        expandedSeen.add(key)
        setToggleState(seenToggle, 'Hide seen players', true)
        await loadSeenPlayers(bot.id, conn.serverId, seenList, seenToggle)
      }
    })
    toggleRow.appendChild(seenToggle)
    row.appendChild(seenPanel)
    if (seenExpanded) loadSeenPlayers(bot.id, conn.serverId, seenList, seenToggle)

    // ---- downloads: chat history, connected-users history ----
    const downloadsRow = document.createElement('div')
    downloadsRow.style.marginTop = '6px'
    downloadsRow.style.display = 'flex'
    downloadsRow.style.gap = '6px'

    const downloadChatBtn = document.createElement('a')
    downloadChatBtn.className = 'btn small'
    downloadChatBtn.textContent = 'Download chat history'
    downloadChatBtn.href = `/api/bots/${bot.id}/chat-history?serverId=${encodeURIComponent(conn.serverId)}`
    downloadsRow.appendChild(downloadChatBtn)

    const downloadUsersBtn = document.createElement('a')
    downloadUsersBtn.className = 'btn small'
    downloadUsersBtn.textContent = 'Download seen players'
    downloadUsersBtn.href = `/api/bots/${bot.id}/connected-users?serverId=${encodeURIComponent(conn.serverId)}`
    downloadsRow.appendChild(downloadUsersBtn)

    // The sighting history is a record of other people, kept across every
    // session - so there has to be a way to throw it away.
    const forgetSeenBtn = document.createElement('button')
    forgetSeenBtn.type = 'button'
    forgetSeenBtn.className = 'btn small danger'
    forgetSeenBtn.textContent = 'Forget seen players'
    forgetSeenBtn.addEventListener('click', async () => {
      const ok = await Dialog.confirm({
        title: 'Forget seen players?',
        intro: `This deletes every record of who ${bot.name} has seen on this server, including from sessions before this one. It cannot be undone.`,
        confirmLabel: 'Forget them',
        danger: true,
      })
      if (!ok) return
      try {
        await apiFetch(`/api/bots/${bot.id}/seen-players?serverId=${encodeURIComponent(conn.serverId)}`, { method: 'DELETE' })
        if (expandedSeen.has(key)) await loadSeenPlayers(bot.id, conn.serverId, seenList, seenToggle)
        else setToggleState(seenToggle, 'Show seen players', false)
      } catch (err) {
        showError(err.message)
      }
    })
    downloadsRow.appendChild(forgetSeenBtn)

    row.appendChild(downloadsRow)

    return row
  }

  function renderBot(bot) {
    const row = document.createElement('div')
    row.className = 'data-row'
    row.dataset.botId = bot.id
    row.style.flexDirection = 'column'
    row.style.alignItems = 'stretch'

    const activeCount = bot.connections.filter((c) => c.status === 'online' || c.status === 'connecting').length
    // Collapsed, a bot shows only what you need to triage at a glance: how
    // it's doing, how many servers it's on, and whether anything has gone
    // wrong. Expanded, it shows every connection in full.
    const collapsed = collapsedBots.has(bot.id)
    if (collapsed) row.classList.add('bot-collapsed')

    const errorCount = bot.connections.reduce((sum, c) => sum + (c.errorCount || 0), 0)
    // One badge per distinct status rather than per connection - four bots on
    // four servers shouldn't produce four identical "online" pills.
    const statusCounts = bot.connections.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] || 0) + 1
      return acc
    }, {})
    const statusBadges = Object.entries(statusCounts)
      .map(([status, count]) => `<span class="badge ${status}">${count > 1 ? `${count} ` : ''}${status}</span>`)
      .join(' ')

    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'bot-head'
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
    header.innerHTML = `
      <span class="head-main">
        <span class="row-title">${escapeHtml(bot.name)}</span>
        <span class="row-sub">${escapeHtml(bot.mcUsername)} &middot; ${bot.mcAuth} &middot; ${activeCount} of ${bot.connections.length} server${bot.connections.length === 1 ? '' : 's'} running</span>
      </span>
      <span class="head-flags">
        ${bot.connections.length ? statusBadges : '<span class="badge offline">not started</span>'}
        ${errorCount ? `<span class="badge error">${errorCount} error${errorCount === 1 ? '' : 's'}</span>` : ''}
      </span>
      <span class="chevron" aria-hidden="true"></span>
    `
    header.addEventListener('click', () => {
      const nowCollapsed = !row.classList.contains('bot-collapsed')
      row.classList.toggle('bot-collapsed', nowCollapsed)
      header.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true')
      if (nowCollapsed) collapsedBots.add(bot.id)
      else collapsedBots.delete(bot.id)
      persistCollapsedBots()
    })
    row.appendChild(header)

    // The detail is always built - collapsing hides it in CSS rather than
    // skipping it, so an open chat console inside a connection survives being
    // minimised and re-expanded (its socket lives in chatPanels either way).
    const body = document.createElement('div')
    body.className = 'bot-body'
    row.appendChild(body)

    bot.connections.forEach((conn) => body.appendChild(renderConnection(bot, conn)))

    // ---- start a new connection - a profile can run against more than one
    // saved server at once, so this stays available even with connections
    // already running, offering only servers it isn't already live on.
    const activeServerIds = new Set(
      bot.connections.filter((c) => c.status === 'online' || c.status === 'connecting').map((c) => c.serverId)
    )
    const startableServers = servers.filter((s) => !activeServerIds.has(s.id))

    const startBox = document.createElement('div')
    startBox.className = 'start-box'

    if (servers.length === 0) {
      startBox.innerHTML = '<span class="row-sub">Add a server on the <a href="#servers" data-goto-tab="servers">Servers</a> tab to start this.</span>'
    } else if (startableServers.length === 0) {
      startBox.innerHTML = '<span class="row-sub">Already running on every saved server.</span>'
    } else {
      const startRow = document.createElement('div')
      startRow.style.display = 'flex'
      startRow.style.gap = '6px'
      startRow.style.flexWrap = 'wrap'
      startRow.style.alignItems = 'center'

      const serverSelect = document.createElement('select')
      startableServers.forEach((s) => {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = `${s.name} (${s.host}:${s.port})`
        serverSelect.appendChild(opt)
      })
      rememberSelect(`${bot.id}:startServer`, serverSelect)
      startRow.appendChild(serverSelect)

      const proxySelect = document.createElement('select')
      const noneOpt = document.createElement('option')
      noneOpt.value = ''
      noneOpt.textContent = 'No proxy'
      proxySelect.appendChild(noneOpt)
      proxies.forEach((p) => {
        const opt = document.createElement('option')
        opt.value = p.id
        opt.textContent = `via ${p.name} (${p.type})`
        proxySelect.appendChild(opt)
      })
      rememberSelect(`${bot.id}:startProxy`, proxySelect)
      startRow.appendChild(proxySelect)

      const startBtn = document.createElement('button')
      startBtn.className = 'btn small primary'
      startBtn.textContent = bot.connections.length > 0 ? 'Start on another server' : 'Start'
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true
        try {
          await apiFetch(`/api/bots/${bot.id}/start`, {
            method: 'POST',
            body: JSON.stringify({ serverId: serverSelect.value, proxyId: proxySelect.value || null }),
          })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
        startBtn.disabled = false
      })
      startRow.appendChild(startBtn)
      startBox.appendChild(startRow)
    }
    body.appendChild(startBox)

    return row
  }

  function pruneChatPanels(stillRendered) {
    chatPanels.forEach((entry, key) => {
      if (stillRendered.has(key)) return
      if (entry.socket) entry.socket.disconnect()
      chatPanels.delete(key)
    })
  }

  async function loadOwnedModules() {
    const data = await apiFetch('/api/marketplace/modules')
    ownedModules = (data.owned || []).filter((m) => !m.paused)
  }

  async function loadServers() {
    const data = await apiFetch('/api/servers')
    servers = data.servers
  }

  async function loadProxies() {
    const data = await apiFetch('/api/proxies')
    proxies = data.proxies
  }

  async function refresh() {
    clearError()
    try {
      await Promise.all([loadOwnedModules(), loadServers(), loadProxies()])
      const params = new URLSearchParams({ q: pageState.q, page: pageState.page, pageSize: pageState.pageSize })
      const { bots, ...meta } = await apiFetch(`/api/bots?${params}`)
      // Taken before the wipe below detaches everything, and put back once
      // the rows are in the document again.
      const chatScroll = captureChatScroll()
      botsList.innerHTML = ''
      if (bots.length === 0) {
        botsList.innerHTML = pageState.q
          ? '<div class="empty-note">No bots match that search.</div>'
          : '<div class="empty-note">No bot profiles yet. Create one on the <a href="#profiles" data-goto-tab="profiles">Profiles</a> tab.</div>'
        pagerBar.innerHTML = ''
        pruneChatPanels(new Set())
        return
      }
      const rendered = new Set()
      bots.forEach((bot) => {
        bot.connections.forEach((conn) => rendered.add(connKey(bot.id, conn.serverId)))
        botsList.appendChild(renderBot(bot))
      })
      // A connection can vanish between polls (profile deleted, or it fell
      // off this page of results). Its console is no longer in the document,
      // so close the socket instead of leaking it.
      pruneChatPanels(rendered)
      restoreChatScroll(chatScroll)
      renderPager(meta)
    } catch (err) {
      showError(err.message)
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      pageState.q = searchInput.value
      pageState.page = 1
      refresh()
    }, 300)
  })

  // Bulk minimise/restore, so a long list can be flattened in one click.
  document.getElementById('bots-collapse-all')?.addEventListener('click', () => {
    document.querySelectorAll('#bots-list .data-row').forEach((row) => {
      if (row.dataset.botId) collapsedBots.add(row.dataset.botId)
    })
    persistCollapsedBots()
    refresh()
  })

  document.getElementById('bots-expand-all')?.addEventListener('click', () => {
    collapsedBots.clear()
    persistCollapsedBots()
    refresh()
  })

  // Fired by the spawn composer on the client page, so a newly started bot
  // shows up immediately instead of on the next poll tick.
  window.addEventListener('bots:refresh', () => refresh())

  refresh()
  pollHandle = setInterval(refresh, 5000)
  window.addEventListener('beforeunload', () => {
    clearInterval(pollHandle)
    pruneChatPanels(new Set())
  })
})()
