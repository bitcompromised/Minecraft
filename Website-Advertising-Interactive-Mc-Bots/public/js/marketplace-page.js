(() => {
  const errorBox = document.getElementById('market-error')
  const successBox = document.getElementById('market-success')
  const approvedList = document.getElementById('approved-list')
  const approvedSearch = document.getElementById('approved-search')
  const approvedPager = document.getElementById('approved-pager')
  const mineList = document.getElementById('mine-list')
  const earningsSummary = document.getElementById('earnings-summary')
  const pendingCard = document.getElementById('admin-review-card')
  const pendingList = document.getElementById('pending-list')
  const uploadForm = document.getElementById('upload-form')

  const sourceModal = document.getElementById('source-modal')
  const sourceModalTitle = document.getElementById('source-modal-title')
  const sourceModalCode = document.getElementById('source-modal-code')
  document.getElementById('source-modal-close').addEventListener('click', () => sourceModal.classList.add('hidden'))

  // Pause/unpause stays admin-only (mods can approve/reject/reset passwords,
  // per the backend's requireModOrAdmin routes, but not pause an already
  // approved module) - read straight from the server-rendered role rather
  // than inferring it from whether the pending-review data came back, since
  // mods get that data too now.
  const isAdmin = ['admin', 'developer'].includes(document.body.dataset.role)
  const approvedSort = document.getElementById('approved-sort')
  // Five per page by default, and ordered by whichever module was discussed
  // most recently - see MODULE_SORTS in src/routes/marketplace.js.
  const approvedState = { q: '', page: 1, pageSize: 5, sort: 'discussion' }

  // The forms on this page open as dialogs from their header buttons.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-open-form]')
    if (!trigger) return
    const panel = document.querySelector(`[data-form="${trigger.dataset.openForm}"]`)
    if (panel) Dialog.openPanel(panel, { title: panel.dataset.formTitle })
  })

  function showError(message) {
    successBox.classList.add('hidden')
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  function showSuccess(message) {
    errorBox.classList.add('hidden')
    successBox.textContent = message
    successBox.classList.remove('hidden')
  }

  function clearMessages() {
    errorBox.classList.add('hidden')
    successBox.classList.add('hidden')
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

  // Marks an uploader out as Staff/Developer/Admin next to their name. Plain
  // users get nothing back (see .role-badge.user in panel.css). The label
  // itself is computed server-side, in src/userBadge.js.
  function roleBadge(owner) {
    if (!owner || !owner.roleClass || owner.roleClass === 'user') return ''
    return ` <span class="role-badge ${owner.roleClass}">${escapeHtml(owner.roleLabel)}</span>`
  }

  async function viewSource(moduleId, name) {
    try {
      const { source } = await apiFetch(`/api/marketplace/modules/${moduleId}/source`)
      sourceModalTitle.textContent = `${name} - source`
      sourceModalCode.textContent = source
      sourceModal.classList.remove('hidden')
    } catch (err) {
      showError(err.message)
    }
  }

  function renderPager(container, meta, state, onChange) {
    container.innerHTML = ''
    const info = document.createElement('span')
    info.textContent = `${meta.total} total - page ${meta.page} of ${meta.totalPages}`
    container.appendChild(info)

    const prevBtn = document.createElement('button')
    prevBtn.className = 'btn small'
    prevBtn.textContent = 'Prev'
    prevBtn.disabled = meta.page <= 1
    prevBtn.addEventListener('click', () => { state.page = Math.max(1, state.page - 1); onChange() })
    container.appendChild(prevBtn)

    const nextBtn = document.createElement('button')
    nextBtn.className = 'btn small'
    nextBtn.textContent = 'Next'
    nextBtn.disabled = meta.page >= meta.totalPages
    nextBtn.addEventListener('click', () => { state.page = Math.min(meta.totalPages, state.page + 1); onChange() })
    container.appendChild(nextBtn)

    const sizeSelect = document.createElement('select')
    ;[5, 10, 25, 50].forEach((n) => {
      const opt = document.createElement('option')
      opt.value = n
      opt.textContent = `${n} / page`
      if (n === state.pageSize) opt.selected = true
      sizeSelect.appendChild(opt)
    })
    sizeSelect.addEventListener('change', () => {
      state.pageSize = parseInt(sizeSelect.value, 10)
      state.page = 1
      onChange()
    })
    container.appendChild(sizeSelect)
  }

  function renderApproved(list, credits, meta) {
    approvedList.innerHTML = ''
    if (list.length === 0) {
      approvedList.innerHTML = '<div class="empty-note">No modules match.</div>'
      approvedPager.innerHTML = ''
      return
    }
    list.forEach((m) => {
      const row = document.createElement('div')
      row.className = 'data-row' + (m.isDemo ? ' pinned' : '')
      const flags = [
        m.isDemo ? '<span class="badge demo">demo</span>' : '',
        m.isDemo || m.price === 0 ? '<span class="badge free">free</span>' : '',
        m.atRisk ? '<span class="badge error">at risk</span>' : '',
      ].filter(Boolean).join(' ')
      const discussion = m.commentCount
        ? ` &middot; ${m.commentCount} comment${m.commentCount === 1 ? '' : 's'}`
        : ''
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title"><a href="/marketplace/module/${m.id}">${escapeHtml(m.name)}</a> <span class="row-sub">by ${escapeHtml(m.ownerUsername)}${roleBadge(m.owner)} &middot; v${escapeHtml(m.version)}</span> ${flags}</div>
          <div class="row-sub">${escapeHtml(m.description || 'No description.')}</div>
          <div class="row-sub">${m.price} credits &middot; ${m.usersCount} user${m.usersCount === 1 ? '' : 's'}${m.reviewCount ? ` &middot; ${m.avgRating.toFixed(1)}★ (${m.reviewCount})` : ''}${discussion}${m.paused ? ` &middot; <span class="badge error">paused: ${escapeHtml(m.pauseReason || 'no reason')}</span>` : ''}</div>
        </div>
      `

      // Demo modules lead with their source, since reading them is the point.
      if (m.isDemo && m.canViewSource) {
        const readBtn = document.createElement('button')
        readBtn.className = 'btn small'
        readBtn.textContent = 'Read source'
        readBtn.addEventListener('click', () => viewSource(m.id, m.name))
        row.appendChild(readBtn)
      }

      if (m.owned) {
        const owned = document.createElement('span')
        owned.className = 'badge approved'
        owned.textContent = 'owned'
        row.appendChild(owned)
      } else {
        const buyBtn = document.createElement('button')
        buyBtn.className = 'btn small primary'
        buyBtn.textContent = m.price > 0 ? `Buy (${m.price})` : 'Add'
        buyBtn.disabled = credits < m.price || m.paused
        buyBtn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/marketplace/modules/${m.id}/buy`, { method: 'POST' })
            showSuccess(m.price > 0 ? `Bought "${m.name}".` : `Added "${m.name}".`)
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(buyBtn)
      }

      if (isAdmin) {
        const pauseBtn = document.createElement('button')
        pauseBtn.className = 'btn small' + (m.paused ? '' : ' danger')
        pauseBtn.textContent = m.paused ? 'Unpause' : 'Pause'
        pauseBtn.addEventListener('click', async () => {
          try {
            if (m.paused) {
              await apiFetch(`/api/marketplace/modules/${m.id}/unpause`, { method: 'POST' })
              showSuccess(`"${m.name}" is available again.`)
            } else {
              const values = await Dialog.form({
                title: `Pause "${m.name}"`,
                intro: 'A paused module stays approved but cannot be bought or loaded onto a bot. Everyone who owns it sees the reason below.',
                confirmLabel: 'Pause module',
                danger: true,
                fields: [{
                  name: 'reason',
                  label: 'Reason',
                  type: 'textarea',
                  rows: 3,
                  required: true,
                  maxLength: 500,
                  placeholder: 'Shown to anyone who tries to buy or load it.',
                }],
              })
              if (!values) return
              await apiFetch(`/api/marketplace/modules/${m.id}/pause`, {
                method: 'POST',
                body: JSON.stringify({ reason: values.reason }),
              })
              showSuccess(`"${m.name}" is paused.`)
            }
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(pauseBtn)
      }

      approvedList.appendChild(row)
    })
    renderPager(approvedPager, meta, approvedState, refresh)
  }

  function renderMine(mine) {
    mineList.innerHTML = ''
    if (mine.length === 0) {
      mineList.innerHTML = '<div class="empty-note">You haven\'t uploaded any modules yet.</div>'
      return
    }
    mine.forEach((m) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title"><a href="/marketplace/module/${m.id}">${escapeHtml(m.name)}</a>${m.hasPendingUpdate ? ' <span class="badge pending">update pending</span>' : ''}${m.atRisk ? ' <span class="badge error">at risk</span>' : ''}${m.isPrivate ? ' <span class="badge private">private</span>' : ''}</div>
          <div class="row-sub">${m.price} credits${m.rejectionReason ? ` · rejected: ${escapeHtml(m.rejectionReason)}` : ''}</div>
        </div>
        <span class="badge ${m.status}">${m.status}</span>
      `
      const viewBtn = document.createElement('button')
      viewBtn.className = 'btn small'
      viewBtn.textContent = 'View source'
      viewBtn.addEventListener('click', () => viewSource(m.id, m.name))
      row.appendChild(viewBtn)

      // Hide/unhide from the marketplace without deleting. Demo modules are
      // always public, so they don't get the control at all.
      if (!m.isDemo) {
        const privacyBtn = document.createElement('button')
        privacyBtn.className = 'btn small'
        privacyBtn.textContent = m.isPrivate ? 'Make public' : 'Make private'
        privacyBtn.title = m.isPrivate
          ? 'List this module in the marketplace again.'
          : 'Hide from the marketplace. Existing owners keep it; nobody new can buy it.'
        privacyBtn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/marketplace/modules/${m.id}/private`, {
              method: 'POST',
              body: JSON.stringify({ isPrivate: !m.isPrivate }),
            })
            showSuccess(m.isPrivate ? `"${m.name}" is listed again.` : `"${m.name}" is now private.`)
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(privacyBtn)
      }

      mineList.appendChild(row)
    })
  }

  function renderPending(pending) {
    if (!pending) {
      pendingCard.style.display = 'none'
      return
    }
    pendingCard.style.display = ''
    pendingList.innerHTML = ''
    if (pending.length === 0) {
      pendingList.innerHTML = '<div class="empty-note">Nothing waiting for review.</div>'
      return
    }
    pending.forEach((m) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(m.name)} <span class="row-sub">by ${escapeHtml(m.ownerUsername)}${roleBadge(m.owner)}</span></div>
          <div class="row-sub">${escapeHtml(m.description || 'No description.')} · ${m.price} credits</div>
        </div>
      `
      const viewBtn = document.createElement('button')
      viewBtn.className = 'btn small'
      viewBtn.textContent = 'View source'
      viewBtn.addEventListener('click', () => viewSource(m.id, m.name))
      row.appendChild(viewBtn)

      const approveBtn = document.createElement('button')
      approveBtn.className = 'btn small primary'
      approveBtn.textContent = 'Approve'
      approveBtn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/marketplace/modules/${m.id}/approve`, { method: 'POST' })
          await refresh()
        } catch (err) {
          showError(err.message)
        }
      })
      row.appendChild(approveBtn)

      const rejectBtn = document.createElement('button')
      rejectBtn.className = 'btn small danger'
      rejectBtn.textContent = 'Reject'
      rejectBtn.addEventListener('click', async () => {
        const values = await Dialog.form({
          title: `Reject "${m.name}"`,
          intro: `Uploaded by ${m.ownerUsername}. The reason is shown to them on the module's page.`,
          confirmLabel: 'Reject module',
          danger: true,
          fields: [{
            name: 'reason',
            label: 'Reason',
            type: 'textarea',
            rows: 3,
            maxLength: 500,
            placeholder: 'What needs to change before this can be approved?',
            hint: 'Optional, but a rejection without one is hard to act on.',
          }],
        })
        if (!values) return
        try {
          await apiFetch(`/api/marketplace/modules/${m.id}/reject`, {
            method: 'POST',
            body: JSON.stringify({ reason: values.reason }),
          })
          showSuccess(`Rejected "${m.name}".`)
          await refresh()
        } catch (err) {
          showError(err.message)
        }
      })
      row.appendChild(rejectBtn)

      pendingList.appendChild(row)
    })
  }

  async function refresh() {
    const params = new URLSearchParams({
      q: approvedState.q,
      page: approvedState.page,
      pageSize: approvedState.pageSize,
      sort: approvedState.sort,
    })
    const data = await apiFetch(`/api/marketplace/modules?${params}`)
    renderApproved(data.modules, data.credits, {
      total: data.total, page: data.page, pageSize: data.pageSize, totalPages: data.totalPages,
    })
    renderMine(data.mine)
    renderPending(data.pending)
    earningsSummary.textContent = `Total earned across your modules: ${data.totalEarned} credits.`
  }

  let approvedSearchDebounce = null
  approvedSearch.addEventListener('input', () => {
    clearTimeout(approvedSearchDebounce)
    approvedSearchDebounce = setTimeout(() => {
      approvedState.q = approvedSearch.value
      approvedState.page = 1
      refresh().catch((err) => showError(err.message))
    }, 300)
  })

  approvedSort?.addEventListener('change', () => {
    approvedState.sort = approvedSort.value
    approvedState.page = 1
    refresh().catch((err) => showError(err.message))
  })

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearMessages()
    // The panel this form is sitting in, so failures can be reported inside
    // it rather than behind it.
    const panel = uploadForm.closest('[data-form]')
    Dialog.clearPanelError(panel)

    const formData = new FormData(uploadForm)

    // Checked here as well as server-side so the obvious mistakes are caught
    // without a round trip, and so every problem is listed at once rather
    // than bouncing off the server one at a time.
    const problems = validateUpload(formData)
    if (problems.length) {
      Dialog.panelError(
        panel,
        problems.length === 1 ? problems[0] : `This module can't be uploaded yet - ${problems.length} problems:`,
        problems
      )
      return
    }

    const submitBtn = uploadForm.querySelector('button[type=submit]')
    if (submitBtn) submitBtn.disabled = true

    try {
      // The module is typed into the page, so this is a plain JSON post -
      // there's no file to send.
      const res = await fetch('/api/marketplace/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.get('name'),
          description: formData.get('description'),
          price: parseInt(formData.get('price'), 10),
          source: formData.get('source'),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        // The server also compiles the file and checks its exports (see
        // src/moduleValidator.js), returning every problem it found.
        const err = new Error(data.error || 'Upload failed.')
        err.problems = data.problems
        throw err
      }
      // Only a successful upload closes the dialog and clears the form.
      uploadForm.reset()
      Dialog.closePanel(panel)
      showSuccess(`"${data.name}" uploaded and waiting for admin review.`)
      await refresh()
    } catch (err) {
      Dialog.panelError(panel, err.message, err.problems)
    } finally {
      if (submitBtn) submitBtn.disabled = false
    }
  })

  const MAX_MODULE_BYTES = 2 * 1024 * 1024

  function validateUpload(formData) {
    const problems = []
    const name = String(formData.get('name') || '').trim()
    const price = formData.get('price')
    const source = String(formData.get('source') || '')

    if (name.length < 3 || name.length > 64) {
      problems.push('The name must be between 3 and 64 characters.')
    }

    const priceNum = parseInt(price, 10)
    if (!Number.isInteger(priceNum) || priceNum < 0) {
      problems.push('The price must be a whole number of credits, 0 or more.')
    }

    if (source.trim().length === 0) {
      problems.push('The module code is empty.')
    } else if (new Blob([source]).size > MAX_MODULE_BYTES) {
      problems.push('The module code is larger than 2MB.')
    } else if (source.trim() === String(window.MODULE_TEMPLATE || '').trim()) {
      // Submitting the untouched starter template is almost always an
      // accident, and it would otherwise pass every other check.
      problems.push('This is still the starter template - write the module before uploading it.')
    }

    return problems
  }

  refresh().catch((err) => showError(err.message))
})()
