(() => {
  const errorBox = document.getElementById('messages-error')
  const conversationList = document.getElementById('conversation-list')
  const threadTitle = document.getElementById('thread-title')
  const threadMessages = document.getElementById('thread-messages')
  const threadReplyForm = document.getElementById('thread-reply-form')
  const newMessageForm = document.getElementById('new-message-form')
  const newMessageTo = document.getElementById('new-message-to')

  let activePartner = null
  let pollHandle = null

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
    div.textContent = str || ''
    return div.innerHTML
  }

  // Marks the other person out as Staff/Developer/Admin - worth knowing who
  // you're actually talking to before you act on a message. Plain users get
  // nothing back (see .role-badge.user in panel.css); the label is computed
  // server-side in src/userBadge.js.
  function roleBadge(user) {
    if (!user || !user.roleClass || user.roleClass === 'user') return ''
    return ` <span class="role-badge ${user.roleClass}">${escapeHtml(user.roleLabel)}</span>`
  }

  async function loadConversations() {
    const { conversations } = await apiFetch('/api/messages/conversations')
    conversationList.innerHTML = ''
    if (conversations.length === 0) {
      conversationList.innerHTML = '<div class="empty-note">No conversations yet.</div>'
      return
    }
    conversations.forEach((c) => {
      const row = document.createElement('div')
      row.className = 'data-row' + (activePartner === c.username ? ' selected' : '')
      row.style.cursor = 'pointer'
      const avatar = c.avatarUrl ? `<img class="avatar" src="${escapeHtml(c.avatarUrl)}" alt="" width="24" height="24" style="margin-right:6px;vertical-align:middle;" />` : ''
      const preview = `${c.lastMessageFromMe ? 'You: ' : ''}${c.lastMessage}`
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${avatar}${escapeHtml(c.username)}${roleBadge(c)}${c.unreadCount > 0 ? ` <span class="badge error">${c.unreadCount}</span>` : ''}</div>
          <div class="row-sub">${escapeHtml(preview.length > 60 ? `${preview.slice(0, 60)}…` : preview)} &middot; ${new Date(c.lastMessageAt).toLocaleString()}</div>
        </div>
      `
      row.addEventListener('click', () => openThread(c.username))
      conversationList.appendChild(row)
    })
  }

  async function openThread(username) {
    activePartner = username
    clearError()
    try {
      const { partner, messages } = await apiFetch(`/api/messages/with/${encodeURIComponent(username)}`)
      threadTitle.innerHTML = `<a href="/user/${encodeURIComponent(partner.username)}">${escapeHtml(partner.username)}</a>${roleBadge(partner)}`
      threadMessages.innerHTML = ''
      if (messages.length === 0) {
        threadMessages.innerHTML = '<div class="empty-note">No messages yet - say hello.</div>'
      } else {
        messages.forEach((m) => {
          const row = document.createElement('div')
          row.className = 'data-row'
          row.style.flexDirection = 'column'
          row.style.alignItems = m.fromMe ? 'flex-end' : 'flex-start'
          row.innerHTML = `
            <div class="row-sub">${m.fromMe ? 'You' : escapeHtml(partner.username)} &middot; ${new Date(m.createdAt).toLocaleString()}</div>
            <div class="row-title" style="white-space:pre-wrap; font-weight:normal;">${escapeHtml(m.body)}</div>
          `
          threadMessages.appendChild(row)
        })
        threadMessages.scrollTop = threadMessages.scrollHeight
      }
      threadReplyForm.classList.remove('hidden')
      await loadConversations()
    } catch (err) {
      showError(err.message)
    }
  }

  newMessageForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()
    const formData = new FormData(newMessageForm)
    const to = formData.get('to')
    const body = formData.get('body')
    try {
      await apiFetch(`/api/messages/with/${encodeURIComponent(to)}`, { method: 'POST', body: JSON.stringify({ body }) })
      newMessageForm.reset()
      await openThread(to)
    } catch (err) {
      showError(err.message)
    }
  })

  threadReplyForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!activePartner) return
    clearError()
    const body = new FormData(threadReplyForm).get('body')
    try {
      await apiFetch(`/api/messages/with/${encodeURIComponent(activePartner)}`, { method: 'POST', body: JSON.stringify({ body }) })
      threadReplyForm.reset()
      await openThread(activePartner)
    } catch (err) {
      showError(err.message)
    }
  })

  // Deep link from a profile's "Message" button (?to=username) - prefills
  // the new-message form and opens that thread directly.
  const params = new URLSearchParams(window.location.search)
  const prefillTo = params.get('to')
  if (prefillTo) {
    newMessageTo.value = prefillTo
    openThread(prefillTo).catch((err) => showError(err.message))
  }

  loadConversations().catch((err) => showError(err.message))

  // Light polling so a reply shows up without a manual refresh - matches
  // the polling pattern the Bots page already uses.
  pollHandle = setInterval(() => {
    loadConversations().catch(() => {})
    if (activePartner) openThread(activePartner).catch(() => {})
  }, 8000)
  window.addEventListener('beforeunload', () => clearInterval(pollHandle))
})()
