(() => {
  const username = document.body.dataset.profileUsername
  const errorBox = document.getElementById('profile-error')
  const headerEl = document.getElementById('profile-header')
  const threadsEl = document.getElementById('profile-threads')
  const commentsEl = document.getElementById('profile-comments')
  const modulesEl = document.getElementById('profile-modules')

  function showError(message) {
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str || ''
    return div.innerHTML
  }

  async function apiFetch(url) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Request failed.')
    return data
  }

  function renderHeader(u) {
    const badges =
      (u.status === 'vip' ? '<span class="tier-badge vip">vip</span>' : '') +
      (u.status === 'mod' ? '<span class="tier-badge mod">mod</span>' : '') +
      (u.role === 'admin' ? '<span class="admin-badge">admin</span>' : '')
    const tagBadges = (u.tags || []).map((t) => `<span class="user-tag">${escapeHtml(t)}</span>`).join('')
    const avatar = u.avatarUrl
      ? `<img class="avatar" src="${escapeHtml(u.avatarUrl)}" alt="" width="64" height="64" />`
      : '<div class="avatar" style="width:64px;height:64px;background:#333;border-radius:50%;"></div>'

    headerEl.innerHTML = `
      <div style="display:flex; align-items:flex-start; gap:16px;">
        ${avatar}
        <div>
          <div class="row-title" style="font-size:18px;">${escapeHtml(u.username)}${badges}${tagBadges}</div>
          <div class="row-sub">Joined ${new Date(u.createdAt).toLocaleDateString()}</div>
          <div class="row-sub" style="white-space:pre-wrap; margin-top:8px;">${u.bio ? escapeHtml(u.bio) : '<em>No bio yet.</em>'}</div>
          ${u.isSelf
            ? '<p class="row-sub" style="margin-top:8px;"><a href="/settings">Edit your profile</a></p>'
            : `<p style="margin-top:8px;"><a class="btn small" href="/messages?to=${encodeURIComponent(u.username)}">Message</a></p>`}
        </div>
      </div>
    `
  }

  function renderThreads(threads, total) {
    threadsEl.innerHTML = ''
    if (threads.length === 0) {
      threadsEl.innerHTML = '<div class="empty-note">No threads yet.</div>'
      return
    }
    threads.forEach((t) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title"><a href="/forum/thread/${t.id}">${escapeHtml(t.title)}</a></div>
          <div class="row-sub">${escapeHtml(t.section)} &middot; ${t.postCount} repl${t.postCount === 1 ? 'y' : 'ies'} &middot; last activity ${new Date(t.lastPostAt).toLocaleString()}</div>
        </div>
      `
      threadsEl.appendChild(row)
    })
    if (total > threads.length) {
      const note = document.createElement('div')
      note.className = 'empty-note'
      note.textContent = `+ ${total - threads.length} more`
      threadsEl.appendChild(note)
    }
  }

  function renderComments(comments, total) {
    commentsEl.innerHTML = ''
    if (comments.length === 0) {
      commentsEl.innerHTML = '<div class="empty-note">No comments on other threads yet.</div>'
      return
    }
    comments.forEach((c) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">on <a href="/forum/thread/${c.threadId}">${escapeHtml(c.threadTitle)}</a></div>
          <div class="row-sub">${escapeHtml(c.section)} &middot; ${new Date(c.createdAt).toLocaleString()}</div>
          <div class="row-sub" style="white-space:pre-wrap;">${escapeHtml(c.bodySnippet)}</div>
        </div>
      `
      commentsEl.appendChild(row)
    })
    if (total > comments.length) {
      const note = document.createElement('div')
      note.className = 'empty-note'
      note.textContent = `+ ${total - comments.length} more`
      commentsEl.appendChild(note)
    }
  }

  function renderModules(modules, total) {
    modulesEl.innerHTML = ''
    if (modules.length === 0) {
      modulesEl.innerHTML = '<div class="empty-note">No modules published yet.</div>'
      return
    }
    modules.forEach((m) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title"><a href="/marketplace/module/${m.id}">${escapeHtml(m.name)}</a></div>
          <div class="row-sub">${m.price} credits${m.paused ? ' &middot; paused' : ''}</div>
        </div>
        <span class="badge ${m.status}">${m.status}</span>
      `
      modulesEl.appendChild(row)
    })
    if (total > modules.length) {
      const note = document.createElement('div')
      note.className = 'empty-note'
      note.textContent = `+ ${total - modules.length} more`
      modulesEl.appendChild(note)
    }
  }

  async function load() {
    try {
      const data = await apiFetch(`/api/users/${encodeURIComponent(username)}`)
      document.title = `${data.user.username} - Mineflayer Web`
      renderHeader(data.user)
      renderThreads(data.threads, data.threadsTotal)
      renderComments(data.comments, data.commentsTotal)
      renderModules(data.modules, data.modulesTotal)
    } catch (err) {
      showError(err.message)
      headerEl.innerHTML = ''
    }
  }

  load()
})()
