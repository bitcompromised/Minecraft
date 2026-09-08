(() => {
  const errorBox = document.getElementById('forum-error')
  const sectionTitle = document.getElementById('section-title')
  const threadList = document.getElementById('thread-list')
  const threadsSearch = document.getElementById('threads-search')
  const threadsSort = document.getElementById('threads-sort')
  const threadsPager = document.getElementById('threads-pager')
  const newThreadForm = document.getElementById('new-thread-form')
  const sectionButtons = document.querySelectorAll('.section-btn')

  const SECTION_LABELS = {
    marketplace: 'Marketplace',
    reviews: 'Reviews',
    discussion: 'Discussion',
    bugs: 'Bugs/Errors',
    admin: 'Admin/Mod Discussion',
  }

  let currentSection = 'discussion'
  const state = { q: '', page: 1, pageSize: 25, sort: 'activity' }

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

  function renderPager(container, meta, pagerState, onChange) {
    container.innerHTML = ''
    const info = document.createElement('span')
    info.textContent = `${meta.total} total - page ${meta.page} of ${meta.totalPages}`
    container.appendChild(info)

    const prevBtn = document.createElement('button')
    prevBtn.className = 'btn small'
    prevBtn.textContent = 'Prev'
    prevBtn.disabled = meta.page <= 1
    prevBtn.addEventListener('click', () => { pagerState.page = Math.max(1, pagerState.page - 1); onChange() })
    container.appendChild(prevBtn)

    const nextBtn = document.createElement('button')
    nextBtn.className = 'btn small'
    nextBtn.textContent = 'Next'
    nextBtn.disabled = meta.page >= meta.totalPages
    nextBtn.addEventListener('click', () => { pagerState.page = Math.min(meta.totalPages, pagerState.page + 1); onChange() })
    container.appendChild(nextBtn)

    const sizeSelect = document.createElement('select')
    ;[10, 25, 50, 100].forEach((n) => {
      const opt = document.createElement('option')
      opt.value = n
      opt.textContent = `${n} / page`
      if (n === pagerState.pageSize) opt.selected = true
      sizeSelect.appendChild(opt)
    })
    sizeSelect.addEventListener('change', () => {
      pagerState.pageSize = parseInt(sizeSelect.value, 10)
      pagerState.page = 1
      onChange()
    })
    container.appendChild(sizeSelect)
  }

  function bindSearch(input, searchState, onChange) {
    let debounce = null
    input.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        searchState.q = input.value
        searchState.page = 1
        onChange()
      }, 300)
    })
  }

  function renderThreads(threads) {
    threadList.innerHTML = ''
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-note">No threads yet - start one below.</div>'
      return
    }
    threads.forEach((t) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      const flags = (t.pinned ? '<span class="badge approved">pinned</span> ' : '') +
        (t.locked ? '<span class="badge error">locked</span> ' : '')
      const avatar = t.authorAvatarUrl ? `<img class="avatar" src="${escapeHtml(t.authorAvatarUrl)}" alt="" width="28" height="28" style="margin-right:8px;" />` : ''
      const tagBadges = (t.authorTags || []).map((tag) => `<span class="user-tag">${escapeHtml(tag)}</span>`).join('')
      row.innerHTML = `
        ${avatar}
        <div class="row-main">
          <div class="row-title">${flags}${escapeHtml(t.title)}</div>
          <div class="row-sub">by <a href="/user/${encodeURIComponent(t.authorUsername)}">${escapeHtml(t.authorUsername)}</a>${tagBadges} &middot; ${t.postCount} repl${t.postCount === 1 ? 'y' : 'ies'} &middot; ${t.views} view${t.views === 1 ? '' : 's'} &middot; last activity ${new Date(t.lastPostAt).toLocaleString()}</div>
        </div>
        <a class="btn small" href="/forum/thread/${t.id}">Open</a>
      `
      threadList.appendChild(row)
    })
  }

  async function loadThreads() {
    clearError()
    try {
      const params = new URLSearchParams({ q: state.q, page: state.page, pageSize: state.pageSize, sort: state.sort })
      const { threads, ...meta } = await apiFetch(`/api/forum/sections/${currentSection}/threads?${params}`)
      renderThreads(threads)
      renderPager(threadsPager, meta, state, loadThreads)
    } catch (err) {
      showError(err.message)
    }
  }

  function selectSection(section) {
    currentSection = section
    sectionTitle.textContent = SECTION_LABELS[section] || section
    state.q = ''
    state.page = 1
    threadsSearch.value = ''
    sectionButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.section === section))
    loadThreads()
  }

  sectionButtons.forEach((btn) => btn.addEventListener('click', () => selectSection(btn.dataset.section)))
  bindSearch(threadsSearch, state, loadThreads)
  threadsSort.addEventListener('change', () => {
    state.sort = threadsSort.value
    state.page = 1
    loadThreads()
  })

  newThreadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()
    const formData = new FormData(newThreadForm)
    try {
      const thread = await apiFetch(`/api/forum/sections/${currentSection}/threads`, {
        method: 'POST',
        body: JSON.stringify({ title: formData.get('title'), body: formData.get('body') }),
      })
      newThreadForm.reset()
      window.location.href = `/forum/thread/${thread.id}`
    } catch (err) {
      showError(err.message)
    }
  })

  selectSection('discussion')
})()
