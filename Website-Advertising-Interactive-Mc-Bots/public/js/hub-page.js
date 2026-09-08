/* Signed-in home page: a combined view of the forum and the marketplace.
   Everything here is read-only - posting and buying still happen on the
   dedicated /forum and /marketplace pages, which this links into. */
(() => {
  const errorBox = document.getElementById('hub-error')
  const threadList = document.getElementById('hub-threads')
  const sectionBar = document.getElementById('hub-sections')
  const newModules = document.getElementById('hub-new-modules')
  const topModules = document.getElementById('hub-top-modules')
  const myModules = document.getElementById('hub-my-modules')

  function showError(message) {
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  async function apiFetch(url) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Request failed.')
    return data
  }

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str == null ? '' : str
    return div.innerHTML
  }

  // "3 minutes ago" style stamps - forum rows are much easier to scan at a
  // glance with relative times than with full locale date strings.
  function relativeTime(ts) {
    const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const units = [
      [60, 'minute'],
      [24, 'hour'],
      [7, 'day'],
      [4.35, 'week'],
      [12, 'month'],
    ]
    let value = seconds / 60
    let label = 'minute'
    for (let i = 0; i < units.length; i += 1) {
      if (value < units[i][0]) break
      value /= units[i][0]
      label = units[i + 1] ? units[i + 1][1] : 'year'
    }
    const rounded = Math.floor(value)
    return `${rounded} ${label}${rounded === 1 ? '' : 's'} ago`
  }

  function rowLink(href, title, sub, trailingHtml) {
    const row = document.createElement('a')
    row.className = 'data-row'
    row.href = href
    row.style.textDecoration = 'none'
    row.style.color = 'inherit'
    row.innerHTML = `
      <div class="row-main">
        <div class="row-title">${title}</div>
        <div class="row-sub">${sub}</div>
      </div>
      ${trailingHtml || ''}
    `
    return row
  }

  function fillList(container, items, emptyText, build) {
    container.innerHTML = ''
    if (!items.length) {
      container.innerHTML = `<div class="empty-note">${escapeHtml(emptyText)}</div>`
      return
    }
    items.forEach((item) => container.appendChild(build(item)))
  }

  // ---- forum ----

  let currentSection = 'discussion'

  async function loadThreads(section) {
    threadList.innerHTML = '<div class="empty-note">Loading threads...</div>'
    try {
      const { threads } = await apiFetch(`/api/forum/sections/${encodeURIComponent(section)}/threads?sort=activity&pageSize=6`)
      fillList(threadList, threads, 'No threads in this section yet.', (t) => {
        const pin = t.pinned ? '<span class="badge info">pinned</span>' : ''
        const lock = t.locked ? '<span class="badge offline">locked</span>' : ''
        return rowLink(
          `/forum/thread/${encodeURIComponent(t.id)}`,
          escapeHtml(t.title),
          `${escapeHtml(t.authorUsername)} &middot; ${t.postCount} repl${t.postCount === 1 ? 'y' : 'ies'} &middot; ${t.views} view${t.views === 1 ? '' : 's'} &middot; ${relativeTime(t.lastPostAt)}`,
          `${pin}${lock}`
        )
      })
    } catch (err) {
      threadList.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    }
  }

  sectionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('.section-btn')
    if (!btn) return
    currentSection = btn.dataset.section
    Array.from(sectionBar.querySelectorAll('.section-btn')).forEach((b) => b.classList.toggle('active', b === btn))
    loadThreads(currentSection)
  })

  // ---- marketplace ----

  function moduleRow(m) {
    const price = m.price > 0 ? `${m.price} credits` : 'Free'
    const rating = m.avgRating ? `&#9733; ${m.avgRating.toFixed(1)} (${m.reviewCount})` : 'No ratings yet'
    const owned = m.owned ? '<span class="badge approved">owned</span>' : `<span class="badge info">${escapeHtml(price)}</span>`
    return rowLink(
      `/marketplace/module/${encodeURIComponent(m.id)}`,
      escapeHtml(m.name),
      `${escapeHtml(m.ownerUsername)} &middot; v${escapeHtml(m.version)} &middot; ${rating} &middot; ${m.usersCount} user${m.usersCount === 1 ? '' : 's'}`,
      owned
    )
  }

  async function loadMarketplace() {
    // One request feeds all three module lists - /api/marketplace/modules
    // already returns the approved page, this user's uploads, and what they
    // own, so there is nothing to gain from three round trips.
    const data = await apiFetch('/api/marketplace/modules?pageSize=100')
    const approved = data.modules || []

    const newest = [...approved].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5)
    fillList(newModules, newest, 'No approved modules yet.', moduleRow)

    const rated = approved
      .filter((m) => m.avgRating != null)
      .sort((a, b) => b.avgRating - a.avgRating || b.reviewCount - a.reviewCount)
      .slice(0, 4)
    fillList(topModules, rated, 'Nothing rated yet - be the first to review a module.', moduleRow)

    fillList(myModules, (data.mine || []).slice(0, 4), 'You have not uploaded a module yet.', (m) => {
      const statusBadge = `<span class="badge ${m.status}">${escapeHtml(m.status)}</span>`
      return rowLink(
        `/marketplace/module/${encodeURIComponent(m.id)}`,
        escapeHtml(m.name),
        `v${escapeHtml(m.version)} &middot; ${m.usersCount} user${m.usersCount === 1 ? '' : 's'}`,
        statusBadge
      )
    })

    document.getElementById('stat-owned').textContent = (data.owned || []).length
    document.getElementById('stat-uploads').textContent =
      `${(data.mine || []).length} upload${(data.mine || []).length === 1 ? '' : 's'}`
    if (data.totalEarned) {
      document.getElementById('stat-earned').textContent = `${data.totalEarned} earned from sales`
    }
  }

  // ---- stats ----

  async function loadStats() {
    const [botsRes, invitesRes] = await Promise.all([apiFetch('/api/bots'), apiFetch('/api/invites')])
    const running = botsRes.bots.reduce(
      (sum, b) => sum + b.connections.filter((c) => c.status === 'online' || c.status === 'connecting').length,
      0
    )
    document.getElementById('stat-running').textContent = running
    document.getElementById('stat-profiles').textContent =
      `${botsRes.bots.length} profile${botsRes.bots.length === 1 ? '' : 's'}`
    document.getElementById('stat-invites').textContent = invitesRes.remaining
  }

  loadThreads(currentSection)
  // Each of these fails independently - a marketplace hiccup shouldn't blank
  // out the stat cards, and vice versa.
  loadMarketplace().catch((err) => {
    showError(err.message)
    // Otherwise the three module lists sit on "Loading..." forever, which
    // reads as a hang rather than as the failure the alert is describing.
    ;[newModules, topModules, myModules].forEach((list) => {
      list.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    })
  })
  loadStats().catch(() => {
    // Stat cards just stay at "-".
  })
})()
