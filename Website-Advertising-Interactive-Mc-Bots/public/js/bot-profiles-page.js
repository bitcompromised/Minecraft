(() => {
  const errorBox = document.getElementById('profiles-error')
  const profileList = document.getElementById('profile-list')
  const proxyList = document.getElementById('proxy-list')
  const serverList = document.getElementById('server-list')
  const newProfileForm = document.getElementById('new-profile-form')
  const newProxyForm = document.getElementById('new-proxy-form')
  const newServerForm = document.getElementById('new-server-form')

  // Profiles, servers and proxies each page at ten per view.
  const PAGE_SIZE = 10

  let proxies = []

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

  async function loadProfiles() {
    const { bots } = await apiFetch('/api/bots?pageSize=200')
    // Paged client-side: the three lists on this page are small and already
    // arrive whole, so a pager here costs no extra requests.
    Paginate.render({
      container: profileList,
      pager: document.getElementById('profile-pager'),
      items: bots,
      pageSize: PAGE_SIZE,
      noun: 'profile',
      emptyText: 'No bot profiles yet. Create one with the New profile button above.',
      renderItem: (bot) => {
      // A profile can now be connected to more than one saved server at
      // once - manage/watch individual connections on the Bots page; this
      // list just shows a summary badge per active one.
      const activeConnections = bot.connections.filter((c) => c.status === 'online' || c.status === 'connecting')
      const badges = activeConnections.length
        ? activeConnections.map((c) => `<span class="badge ${c.status}">${c.server ? escapeHtml(c.server.name) : ''} ${c.status}</span>`).join(' ')
        : '<span class="badge offline">offline</span>'
      const row = document.createElement('div')
      row.className = 'data-row'
      row.style.flexDirection = 'column'
      row.style.alignItems = 'stretch'
      row.style.gap = '8px'
      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <div class="row-main">
            <div class="row-title">${escapeHtml(bot.name)}</div>
            <div class="row-sub">${escapeHtml(bot.mcUsername)} &middot; ${bot.mcAuth}</div>
          </div>
          ${badges}
        </div>
      `

      const notesToggle = document.createElement('button')
      // Same collapsible-handle treatment as the client page's Show
      // chat/logs toggles (see .log-toggle in panel.css).
      notesToggle.className = 'log-toggle'
      notesToggle.type = 'button'
      notesToggle.textContent = 'Notes'
      notesToggle.style.alignSelf = 'flex-start'
      // No inline display style here - an inline style would always beat
      // .log-panel.hidden's display:none, defeating the toggle below.
      const notesPanel = document.createElement('div')
      notesPanel.className = 'log-panel hidden'

      const notesTextarea = document.createElement('textarea')
      notesTextarea.value = bot.notes || ''
      notesTextarea.maxLength = 10000
      notesTextarea.rows = 4
      notesPanel.appendChild(notesTextarea)

      const notesActions = document.createElement('div')
      notesActions.style.display = 'flex'
      notesActions.style.gap = '6px'

      const saveNotesBtn = document.createElement('button')
      saveNotesBtn.className = 'btn small primary'
      saveNotesBtn.type = 'button'
      saveNotesBtn.textContent = 'Save notes'
      saveNotesBtn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/bots/${bot.id}/notes`, { method: 'POST', body: JSON.stringify({ notes: notesTextarea.value }) })
        } catch (err) {
          showError(err.message)
        }
      })
      notesActions.appendChild(saveNotesBtn)

      const downloadNotesBtn = document.createElement('button')
      downloadNotesBtn.className = 'btn small'
      downloadNotesBtn.type = 'button'
      downloadNotesBtn.textContent = 'Download notes'
      downloadNotesBtn.addEventListener('click', () => {
        const blob = new Blob([notesTextarea.value], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${bot.name.replace(/[^a-z0-9_-]+/gi, '_')}-notes.txt`
        a.click()
        URL.revokeObjectURL(url)
      })
      notesActions.appendChild(downloadNotesBtn)

      notesPanel.appendChild(notesActions)

      notesToggle.addEventListener('click', () => {
        const nowHidden = notesPanel.classList.toggle('hidden')
        notesToggle.classList.toggle('open', !nowHidden)
      })
      row.appendChild(notesToggle)
      row.appendChild(notesPanel)

      const deleteBtn = document.createElement('button')
      deleteBtn.className = 'btn danger small'
      deleteBtn.textContent = 'Delete'
      deleteBtn.style.alignSelf = 'flex-start'
      deleteBtn.addEventListener('click', async () => {
        const ok = await Dialog.confirm({
          title: `Delete profile "${bot.name}"?`,
          intro: 'Any connection it is currently running is stopped. Saved servers and proxies are not affected.',
          confirmLabel: 'Delete profile',
          danger: true,
        })
        if (!ok) return
        try {
          await apiFetch(`/api/bots/${bot.id}`, { method: 'DELETE' })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
      })
      row.appendChild(deleteBtn)
      return row
      },
    })
  }

  function renderProxyList() {
    Paginate.render({
      container: proxyList,
      pager: document.getElementById('proxy-pager'),
      items: proxies,
      pageSize: PAGE_SIZE,
      noun: 'proxy',
      emptyText: 'No proxies yet.',
      renderItem: (proxy) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">${escapeHtml(proxy.name)}</div>
            <div class="row-sub">${proxy.type} &middot; ${escapeHtml(proxy.host)}:${proxy.port}</div>
          </div>
        `
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'btn danger small'
        deleteBtn.textContent = 'Delete'
        deleteBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: `Delete proxy "${proxy.name}"?`,
            intro: 'Bots already running through it keep their connection; it just stops being offered when starting new ones.',
            confirmLabel: 'Delete proxy',
            danger: true,
          })
          if (!ok) return
          try {
            await apiFetch(`/api/proxies/${proxy.id}`, { method: 'DELETE' })
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(deleteBtn)
        return row
      },
    })
  }

  async function loadProxies() {
    const data = await apiFetch('/api/proxies')
    proxies = data.proxies
    renderProxyList()
  }

  async function loadServers() {
    const { servers } = await apiFetch('/api/servers')
    Paginate.render({
      container: serverList,
      pager: document.getElementById('server-pager'),
      items: servers,
      pageSize: PAGE_SIZE,
      noun: 'server',
      emptyText: 'No servers saved yet.',
      renderItem: (server) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">${escapeHtml(server.name)}</div>
            <div class="row-sub">${escapeHtml(server.host)}:${server.port}${server.version ? ` &middot; ${escapeHtml(server.version)}` : ' &middot; auto version'}</div>
          </div>
        `
        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'btn danger small'
        deleteBtn.textContent = 'Delete'
        deleteBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: `Delete server "${server.name}"?`,
            intro: 'Bots currently connected to it keep running. It just stops being offered when starting new ones.',
            confirmLabel: 'Delete server',
            danger: true,
          })
          if (!ok) return
          try {
            await apiFetch(`/api/servers/${server.id}`, { method: 'DELETE' })
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(deleteBtn)
        return row
      },
    })
  }

  async function refresh() {
    clearError()
    try {
      await loadProxies()
      await loadServers()
      await loadProfiles()
      // The client page's spawn composer builds its dropdowns from the same
      // three collections - tell it to reload rather than have it poll.
      window.dispatchEvent(new CustomEvent('client:data-changed'))
    } catch (err) {
      showError(err.message)
    }
  }

  // These three all live in dialogs on the client page. A rejection is
  // reported inside the dialog, with the form still filled in; only a
  // successful create closes it.
  async function submitCreateForm(formEl, url) {
    const panel = formEl.closest('[data-form]')
    clearError()
    Dialog.clearPanelError(panel)
    const submitBtn = formEl.querySelector('button[type=submit]')
    if (submitBtn) submitBtn.disabled = true
    try {
      await apiFetch(url, {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(formEl).entries())),
      })
      formEl.reset()
      Dialog.closePanel(panel)
      await refresh()
    } catch (err) {
      Dialog.panelError(panel, err.message)
    } finally {
      if (submitBtn) submitBtn.disabled = false
    }
  }

  newProfileForm.addEventListener('submit', (e) => {
    e.preventDefault()
    submitCreateForm(newProfileForm, '/api/bots')
  })

  newProxyForm.addEventListener('submit', (e) => {
    e.preventDefault()
    submitCreateForm(newProxyForm, '/api/proxies')
  })

  newServerForm.addEventListener('submit', (e) => {
    e.preventDefault()
    submitCreateForm(newServerForm, '/api/servers')
  })

  refresh()
})()
