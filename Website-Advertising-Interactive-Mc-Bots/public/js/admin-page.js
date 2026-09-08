(() => {
  const errorBox = document.getElementById('admin-error')
  const successBox = document.getElementById('admin-success')
  const userCards = document.getElementById('user-cards')
  const usersSearch = document.getElementById('users-search')
  const usersPager = document.getElementById('users-pager')
  // These two cards (and their filter/search controls) only render into the
  // page for full admins - server.js/admin.ejs already restrict the
  // underlying /api/admin/bot-profiles and /api/admin/logs endpoints to
  // requireAdmin, so a 'mod' status account (who can still reach this page
  // for the Users card) simply won't have these elements in the DOM.
  const botList = document.getElementById('admin-bot-list')
  const botProfilesSearch = document.getElementById('bot-profiles-search')
  const botProfilesStatusFilter = document.getElementById('bot-profiles-status-filter')
  const botProfilesPager = document.getElementById('bot-profiles-pager')
  const logList = document.getElementById('admin-log-list')
  const logsSearch = document.getElementById('logs-search')
  const logsPager = document.getElementById('logs-pager')
  const auditLogList = document.getElementById('audit-log-list')
  const auditLogSearch = document.getElementById('audit-log-search')
  const auditLogPager = document.getElementById('audit-log-pager')
  const moduleReportsList = document.getElementById('module-reports-list')
  const moduleReportsSearch = document.getElementById('module-reports-search')
  const moduleReportsPager = document.getElementById('module-reports-pager')
  const dmList = document.getElementById('dm-list')
  const dmSearch = document.getElementById('dm-search')
  const dmPager = document.getElementById('dm-pager')
  const forumReportsList = document.getElementById('forum-reports-list')
  const forumReportsSearch = document.getElementById('forum-reports-search')
  const forumReportsPager = document.getElementById('forum-reports-pager')
  const warningsList = document.getElementById('warnings-list')
  const warningsSearch = document.getElementById('warnings-search')
  const warningsPager = document.getElementById('warnings-pager')
  const importWhitelistList = document.getElementById('import-whitelist-list')
  const importWhitelistForm = document.getElementById('import-whitelist-form')
  const settingsForm = document.getElementById('settings-form')
  // Both staff roles reach the admin-only controls (see src/roles.js).
  const isAdmin = ['admin', 'developer'].includes(document.body.dataset.role)

  let currentUserId = null
  const usersState = { q: '', page: 1, pageSize: 25 }
  const botProfilesState = { q: '', page: 1, pageSize: 25, status: '' }
  const logsState = { q: '', page: 1, pageSize: 25 }
  const auditLogState = { q: '', page: 1, pageSize: 25 }
  const moduleReportsState = { q: '', page: 1, pageSize: 25 }
  const forumReportsState = { q: '', page: 1, pageSize: 25 }
  const warningsState = { q: '', page: 1, pageSize: 25 }
  const dmState = { q: '', page: 1, pageSize: 25 }

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

  function smallBtn(label, onClick, disabled) {
    const btn = document.createElement('button')
    btn.className = 'btn small'
    btn.textContent = label
    btn.disabled = !!disabled
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await onClick()
      } catch (err) {
        showError(err.message)
      }
      btn.disabled = false
    })
    return btn
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
    ;[10, 25, 50, 100].forEach((n) => {
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

  function bindSearch(input, state, onChange) {
    let debounce = null
    input.addEventListener('input', () => {
      clearTimeout(debounce)
      debounce = setTimeout(() => {
        state.q = input.value
        state.page = 1
        onChange()
      }, 300)
    })
  }

  async function action(url, body, successMessage) {
    await apiFetch(url, { method: 'POST', body: JSON.stringify(body) })
    showSuccess(successMessage)
    await loadUsers()
  }

  // ==========================================================================
  // Moderation dialogs
  //
  // Ban/pause/reset-password all need more than one piece of information, and
  // chaining browser prompt() calls for that was both ugly and impossible to
  // cancel halfway through without half-applying. These build a real modal,
  // resolve when it's submitted, and resolve to null when it's dismissed.
  // ==========================================================================

  function openDialog({ title, intro, fields, confirmLabel, danger }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'modal'

      const box = document.createElement('div')
      box.className = 'modal-box'

      const heading = document.createElement('h2')
      heading.textContent = title
      box.appendChild(heading)

      if (intro) {
        const p = document.createElement('p')
        p.className = 'subtitle'
        p.style.marginBottom = '16px'
        p.textContent = intro
        box.appendChild(p)
      }

      const form = document.createElement('form')
      form.className = 'form-grid wide'

      const inputs = {}
      fields.forEach((f) => {
        const label = document.createElement('label')
        label.textContent = f.label

        const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input')
        if (f.type && f.type !== 'textarea') input.type = f.type
        if (f.placeholder) input.placeholder = f.placeholder
        if (f.value !== undefined) input.value = f.value
        if (f.required) input.required = true
        if (f.min !== undefined) input.min = f.min
        if (f.minLength) input.minLength = f.minLength
        if (f.type === 'textarea') input.rows = f.rows || 3
        label.appendChild(input)

        if (f.hint) {
          const hint = document.createElement('span')
          hint.className = 'field-hint'
          hint.textContent = f.hint
          label.appendChild(hint)
        }

        inputs[f.name] = input
        form.appendChild(label)
      })

      const actions = document.createElement('div')
      actions.className = 'modal-actions'

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'btn ghost'
      cancelBtn.textContent = 'Cancel'
      actions.appendChild(cancelBtn)

      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'submit'
      confirmBtn.className = danger ? 'btn danger' : 'btn primary'
      confirmBtn.textContent = confirmLabel
      actions.appendChild(confirmBtn)

      form.appendChild(actions)
      box.appendChild(form)
      overlay.appendChild(box)
      document.body.appendChild(overlay)

      const close = (result) => {
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        resolve(result)
      }
      const onKey = (e) => { if (e.key === 'Escape') close(null) }

      document.addEventListener('keydown', onKey)
      cancelBtn.addEventListener('click', () => close(null))
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null) })
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        const values = {}
        Object.entries(inputs).forEach(([name, el]) => { values[name] = el.value })
        close(values)
      })

      // Focus the first field so the dialog is immediately typable.
      const first = Object.values(inputs)[0]
      if (first) first.focus()
    })
  }

  async function openPauseDialog(u) {
    const values = await openDialog({
      title: `Pause ${u.username}`,
      intro: 'A paused account can still log in and browse, but cannot start bots or create invites.',
      confirmLabel: 'Pause account',
      danger: true,
      fields: [{
        name: 'reason',
        label: 'Reason',
        type: 'textarea',
        required: true,
        placeholder: 'Shown to them when they try to start a bot.',
        hint: 'Up to 500 characters.',
      }],
    })
    if (!values) return
    await action(`/api/admin/users/${u.id}/pause`, { paused: true, reason: values.reason }, `Paused ${u.username}.`)
  }

  async function openBanDialog(u) {
    const values = await openDialog({
      title: `Ban ${u.username}`,
      intro: 'A ban takes effect immediately, including on any session they already have open.',
      confirmLabel: 'Ban account',
      danger: true,
      fields: [
        {
          name: 'reason',
          label: 'Reason',
          type: 'textarea',
          required: true,
          placeholder: 'Shown on the login page when they try to sign in.',
        },
        {
          name: 'hours',
          label: 'Duration in hours',
          type: 'number',
          min: '0',
          placeholder: 'Leave blank for a permanent ban',
          hint: 'Decimals are fine - 0.5 is thirty minutes.',
        },
      ],
    })
    if (!values) return

    let durationMs = null
    if (values.hours && values.hours.trim()) {
      const hours = parseFloat(values.hours)
      if (!Number.isFinite(hours) || hours <= 0) {
        showError('Ban duration must be a positive number of hours, or blank for permanent.')
        return
      }
      durationMs = Math.round(hours * 60 * 60 * 1000)
    }
    await action(
      `/api/admin/users/${u.id}/ban`,
      { banned: true, reason: values.reason, durationMs },
      `Banned ${u.username}${durationMs ? '' : ' permanently'}.`
    )
  }

  async function openPasswordDialog(u) {
    const values = await openDialog({
      title: `Reset password for ${u.username}`,
      intro: 'They are not notified. Pass the new password on yourself, through a channel you trust.',
      confirmLabel: 'Set password',
      fields: [
        {
          name: 'newPassword',
          label: 'New password',
          type: 'text',
          required: true,
          minLength: 8,
          placeholder: 'At least 8 characters',
          hint: 'Shown in the clear so you can copy it before closing this dialog.',
        },
        {
          name: 'confirmPassword',
          label: 'Confirm new password',
          type: 'text',
          required: true,
          minLength: 8,
        },
      ],
    })
    if (!values) return

    if (values.newPassword !== values.confirmPassword) {
      showError('The two passwords do not match.')
      return
    }
    await action(`/api/admin/users/${u.id}/password`, { newPassword: values.newPassword }, `Password reset for ${u.username}.`)
  }

  function roleBadge(role) {
    if (role === 'admin') return '<span class="admin-badge">admin</span>'
    if (role === 'developer') return '<span class="dev-badge">dev</span>'
    return ''
  }

  // A labelled control for the expanded panel: a caption, the field itself,
  // and the button that commits it.
  function field(labelText, inputEl, buttonLabel, onCommit) {
    const wrap = document.createElement('label')
    wrap.textContent = labelText
    wrap.appendChild(inputEl)
    const group = document.createDocumentFragment()
    group.appendChild(wrap)
    group.appendChild(smallBtn(buttonLabel, onCommit))
    return group
  }

  // Users are collapsed to a single summary line by default - a page of 25
  // expanded cards was unreadable. Which rows are open survives a reload of
  // the list (search, paging, or a refresh after an action).
  const expandedUsers = new Set()

  function userCard(u) {
    const entry = document.createElement('div')
    entry.className = 'user-entry' + (expandedUsers.has(u.id) ? ' open' : '')

    const isSelf = u.id === currentUserId
    const tagBadges = (u.tags || []).map((t) => `<span class="user-tag">${escapeHtml(t)}</span>`).join('')
    const badges =
      (u.status === 'vip' ? '<span class="tier-badge vip">vip</span>' : '') +
      (u.status === 'mod' ? '<span class="tier-badge mod">mod</span>' : '') +
      roleBadge(u.role)

    const flags = []
    if (u.paused) flags.push('<span class="badge error">paused</span>')
    if (u.banned) flags.push('<span class="badge error">banned</span>')

    // ---- collapsed summary ----
    const head = document.createElement('button')
    head.type = 'button'
    head.className = 'user-entry-head'
    head.setAttribute('aria-expanded', expandedUsers.has(u.id) ? 'true' : 'false')
    head.innerHTML = `
      ${u.avatarUrl
        ? `<img class="avatar" src="${escapeHtml(u.avatarUrl)}" alt="" width="32" height="32" />`
        : `<span class="avatar-fallback" aria-hidden="true">${escapeHtml(u.username.slice(0, 2))}</span>`}
      <span class="head-main">
        <span class="row-title">${escapeHtml(u.username)}${badges}${tagBadges}</span>
        <span class="row-sub">${u.credits} credits &middot; ${u.inviteQuota} invites${u.email ? ` &middot; ${escapeHtml(u.email)}` : ''}</span>
      </span>
      <span class="head-flags">${flags.join('')}</span>
      <span class="chevron" aria-hidden="true"></span>
    `
    head.addEventListener('click', () => {
      const nowOpen = !entry.classList.contains('open')
      entry.classList.toggle('open', nowOpen)
      head.setAttribute('aria-expanded', nowOpen ? 'true' : 'false')
      if (nowOpen) expandedUsers.add(u.id)
      else expandedUsers.delete(u.id)
    })
    entry.appendChild(head)

    // ---- expanded detail ----
    const body = document.createElement('div')
    body.className = 'user-entry-body'

    const meta = document.createElement('div')
    meta.className = 'row-sub'
    meta.style.padding = '10px 0'
    const banDetail = u.banned
      ? `banned ${u.banExpiresAt ? `until ${new Date(u.banExpiresAt).toLocaleString()}` : 'permanently'}: ${escapeHtml(u.banReason || 'no reason')}`
      : null
    const pauseDetail = u.paused ? `paused: ${escapeHtml(u.pauseReason || 'no reason')}` : null
    meta.innerHTML = [
      `Joined ${new Date(u.createdAt).toLocaleDateString()}`,
      `invited by ${u.invitedByUsername ? escapeHtml(u.invitedByUsername) : '(no invite on record)'}`,
      pauseDetail,
      banDetail,
    ].filter(Boolean).join(' &middot; ')
    body.appendChild(meta)

    // Credits/quota/status/role/tags/email stay admin-only; password reset is
    // the one action a 'mod' status account also gets (see requireModOrAdmin
    // on POST /api/admin/users/:id/password).
    if (isAdmin) {
      const numbers = document.createElement('div')
      numbers.className = 'admin-field-group'

      const creditsInput = document.createElement('input')
      creditsInput.type = 'number'
      creditsInput.min = '0'
      creditsInput.value = u.credits
      creditsInput.style.width = '110px'
      numbers.appendChild(field('Credits', creditsInput, 'Save', () =>
        action(`/api/admin/users/${u.id}/credits`, { credits: parseInt(creditsInput.value, 10) }, `Updated credits for ${u.username}.`)))

      const quotaInput = document.createElement('input')
      quotaInput.type = 'number'
      quotaInput.min = '0'
      quotaInput.value = u.inviteQuota
      quotaInput.style.width = '110px'
      numbers.appendChild(field('Invite quota', quotaInput, 'Save', () =>
        action(`/api/admin/users/${u.id}/invite-quota`, { inviteQuota: parseInt(quotaInput.value, 10) }, `Updated invite quota for ${u.username}.`)))
      body.appendChild(numbers)

      const tiers = document.createElement('div')
      tiers.className = 'admin-field-group'

      const statusSelect = document.createElement('select')
      ;['normal', 'vip', 'mod'].forEach((s) => {
        const opt = document.createElement('option')
        opt.value = s
        opt.textContent = s
        if (s === (u.status || 'normal')) opt.selected = true
        statusSelect.appendChild(opt)
      })
      tiers.appendChild(field('Tier', statusSelect, 'Save', () =>
        action(`/api/admin/users/${u.id}/status`, { status: statusSelect.value }, `Updated tier for ${u.username}.`)))

      // Role is the staff axis (see src/roles.js). Changing your own is
      // rejected server-side, so the control is disabled on your own row.
      const roleSelect = document.createElement('select')
      ;[['user', 'user'], ['developer', 'developer'], ['admin', 'admin']].forEach(([value, label]) => {
        const opt = document.createElement('option')
        opt.value = value
        opt.textContent = label
        if (value === (u.role || 'user')) opt.selected = true
        roleSelect.appendChild(opt)
      })
      roleSelect.disabled = isSelf
      const roleField = field('Role', roleSelect, 'Save', () =>
        action(`/api/admin/users/${u.id}/role`, { role: roleSelect.value }, `${u.username} is now a ${roleSelect.value}.`))
      tiers.appendChild(roleField)
      body.appendChild(tiers)

      const details = document.createElement('div')
      details.className = 'admin-field-group'

      const tagsInput = document.createElement('input')
      tagsInput.type = 'text'
      tagsInput.placeholder = 'tags, comma-separated'
      tagsInput.value = (u.tags || []).join(', ')
      tagsInput.style.minWidth = '200px'
      details.appendChild(field('Tags', tagsInput, 'Save', () =>
        action(`/api/admin/users/${u.id}/tags`, { tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean) }, `Updated tags for ${u.username}.`)))

      const emailInput = document.createElement('input')
      emailInput.type = 'email'
      emailInput.placeholder = 'email@example.com'
      emailInput.value = u.email || ''
      emailInput.style.minWidth = '210px'
      details.appendChild(field('Email', emailInput, 'Save', () =>
        action(`/api/admin/users/${u.id}/email`, { email: emailInput.value }, `Updated email for ${u.username}.`)))
      body.appendChild(details)
    }

    // ---- moderation actions (dialogs, not prompt()) ----
    const actions = document.createElement('div')
    actions.className = 'admin-field-group'

    if (isAdmin) {
      actions.appendChild(smallBtn(u.paused ? 'Unpause' : 'Pause', () => {
        if (u.paused) return action(`/api/admin/users/${u.id}/pause`, { paused: false }, `Unpaused ${u.username}.`)
        return openPauseDialog(u)
      }, isSelf))

      actions.appendChild(smallBtn(u.banned ? 'Unban' : 'Ban', () => {
        if (u.banned) return action(`/api/admin/users/${u.id}/ban`, { banned: false }, `Unbanned ${u.username}.`)
        return openBanDialog(u)
      }, isSelf))
    }

    actions.appendChild(smallBtn('Reset password', () => openPasswordDialog(u), isSelf))
    body.appendChild(actions)

    entry.appendChild(body)
    return entry
  }

  async function loadUsers() {
    const { user } = await apiFetch('/api/auth/session')
    currentUserId = user ? user.id : null
    const params = new URLSearchParams({ q: usersState.q, page: usersState.page, pageSize: usersState.pageSize })
    const { users, ...meta } = await apiFetch(`/api/admin/users?${params}`)
    userCards.innerHTML = ''
    setSectionCount('users', meta.total)
    if (users.length === 0) {
      userCards.innerHTML = '<div class="empty-note">No users match that search.</div>'
      usersPager.innerHTML = ''
      return
    }
    users.forEach((u) => userCards.appendChild(userCard(u)))
    renderPager(usersPager, meta, usersState, loadUsers)
  }

  function statusLabel(bot) {
    if (bot.status === 'error' && bot.lastError) return `error: ${bot.lastError}`
    return bot.status
  }

  async function loadBotProfiles() {
    if (!botList) return
    const params = new URLSearchParams({ q: botProfilesState.q, page: botProfilesState.page, pageSize: botProfilesState.pageSize })
    if (botProfilesState.status) params.set('status', botProfilesState.status)
    const { botProfiles, ...meta } = await apiFetch(`/api/admin/bot-profiles?${params}`)
    botList.innerHTML = ''
    if (botProfiles.length === 0) {
      botList.innerHTML = '<div class="empty-note">No bot profiles match that search.</div>'
      botProfilesPager.innerHTML = ''
      return
    }
    botProfiles.forEach((bot) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(bot.name)} <span class="row-sub">owned by ${escapeHtml(bot.ownerUsername)}</span></div>
          <div class="row-sub">${escapeHtml(bot.mcUsername)} &middot; ${bot.mcAuth} &middot; ${statusLabel(bot)}${bot.server ? ` &middot; ${escapeHtml(bot.server.host)}:${bot.server.port}` : ''}${bot.proxyName ? ` &middot; via ${escapeHtml(bot.proxyName)}` : ''}</div>
        </div>
        <span class="badge ${bot.status}">${bot.status}</span>
      `
      botList.appendChild(row)
    })
    renderPager(botProfilesPager, meta, botProfilesState, loadBotProfiles)
  }

  async function loadLogs() {
    if (!logList) return
    const params = new URLSearchParams({ q: logsState.q, page: logsState.page, pageSize: logsState.pageSize })
    const { logs, ...meta } = await apiFetch(`/api/admin/logs?${params}`)
    logList.innerHTML = ''
    if (logs.length === 0) {
      logList.innerHTML = '<div class="empty-note">No errors match that search.</div>'
      logsPager.innerHTML = ''
      return
    }
    logs.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(entry.message)}</div>
          <div class="row-sub">${new Date(entry.createdAt).toLocaleString()}${entry.username ? ` &middot; ${escapeHtml(entry.username)}` : ''}${entry.botProfileName ? ` &middot; ${escapeHtml(entry.botProfileName)}` : ''}</div>
        </div>
        <span class="badge error">${entry.level}</span>
      `
      logList.appendChild(row)
    })
    renderPager(logsPager, meta, logsState, loadLogs)
  }

  function formatAuditDetails(details) {
    if (!details || typeof details !== 'object') return ''
    return Object.entries(details)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(', ')
  }

  async function loadAuditLog() {
    if (!auditLogList) return
    const params = new URLSearchParams({ q: auditLogState.q, page: auditLogState.page, pageSize: auditLogState.pageSize })
    const { entries, ...meta } = await apiFetch(`/api/admin/audit-log?${params}`)
    auditLogList.innerHTML = ''
    if (entries.length === 0) {
      auditLogList.innerHTML = '<div class="empty-note">No audit log entries match that search.</div>'
      auditLogPager.innerHTML = ''
      return
    }
    entries.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      const targetLabel = entry.targetType ? ` <span class="row-sub">(${escapeHtml(entry.targetType)}${entry.targetId ? ` ${escapeHtml(entry.targetId)}` : ''})</span>` : ''
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(entry.action.replace(/_/g, ' '))}${targetLabel}</div>
          <div class="row-sub">${new Date(entry.createdAt).toLocaleString()} &middot; by ${escapeHtml(entry.actorUsername)}</div>
          ${entry.details ? `<div class="row-sub">${escapeHtml(formatAuditDetails(entry.details))}</div>` : ''}
        </div>
      `
      auditLogList.appendChild(row)
    })
    renderPager(auditLogPager, meta, auditLogState, loadAuditLog)
  }

  async function loadModuleReports() {
    if (!moduleReportsList) return
    const params = new URLSearchParams({ q: moduleReportsState.q, page: moduleReportsState.page, pageSize: moduleReportsState.pageSize })
    const { reports, ...meta } = await apiFetch(`/api/admin/module-reports?${params}`)
    moduleReportsList.innerHTML = ''
    setSectionCount('module-reports', meta.total, true)
    if (reports.length === 0) {
      moduleReportsList.innerHTML = '<div class="empty-note">No open reports.</div>'
      moduleReportsPager.innerHTML = ''
      return
    }
    reports.forEach((r) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title"><a href="/marketplace/module/${r.moduleId}">${escapeHtml(r.moduleName)}</a></div>
          <div class="row-sub">reported by ${escapeHtml(r.reporterUsername)} &middot; ${new Date(r.createdAt).toLocaleString()}</div>
          <div class="row-sub">${escapeHtml(r.reason)}</div>
        </div>
      `
      row.appendChild(smallBtn('Warn uploader', () => warnAbout('module', r.moduleId)))
      row.appendChild(smallBtn('Dismiss report', async () => {
        const ok = await Dialog.confirm({
          title: 'Dismiss this report?',
          intro: `The report against "${r.moduleName}" will be closed with no action taken.`,
          confirmLabel: 'Dismiss',
        })
        if (!ok) return
        await apiFetch(`/api/admin/module-reports/${r.id}/resolve`, { method: 'POST' })
        await loadModuleReports()
      }))
      moduleReportsList.appendChild(row)
    })
    renderPager(moduleReportsPager, meta, moduleReportsState, loadModuleReports)
  }

  async function loadMessages() {
    if (!dmList) return
    const params = new URLSearchParams({ q: dmState.q, page: dmState.page, pageSize: dmState.pageSize })
    const { messages, ...meta } = await apiFetch(`/api/admin/messages?${params}`)
    dmList.innerHTML = ''
    if (messages.length === 0) {
      dmList.innerHTML = '<div class="empty-note">No messages match.</div>'
      dmPager.innerHTML = ''
      return
    }
    messages.forEach((m) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(m.fromUsername)} &rarr; ${escapeHtml(m.toUsername)}</div>
          <div class="row-sub">${new Date(m.createdAt).toLocaleString()}${m.readAt ? '' : ' &middot; unread'}</div>
          <div class="row-sub" style="white-space:pre-wrap;">${escapeHtml(m.body)}</div>
        </div>
      `
      dmList.appendChild(row)
    })
    renderPager(dmPager, meta, dmState, loadMessages)
  }

  // Threads and posts users have reported. Each row quotes an excerpt so the
  // obvious calls don't need a trip to the thread page, and offers the two
  // things staff actually do next: warn the author, or dismiss the report.
  async function loadForumReports() {
    if (!forumReportsList) return
    const params = new URLSearchParams({ q: forumReportsState.q, page: forumReportsState.page, pageSize: forumReportsState.pageSize })
    const { reports, ...meta } = await apiFetch(`/api/admin/forum-reports?${params}`)
    forumReportsList.innerHTML = ''
    setSectionCount('forum-reports', meta.total, true)
    if (reports.length === 0) {
      forumReportsList.innerHTML = '<div class="empty-note">No open forum reports.</div>'
      forumReportsPager.innerHTML = ''
      return
    }
    reports.forEach((r) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.style.flexDirection = 'column'
      row.style.alignItems = 'stretch'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">
            <span class="badge info">${escapeHtml(r.targetType)}</span>
            ${escapeHtml(r.threadTitle)}
          </div>
          <div class="row-sub">by ${escapeHtml(r.authorUsername)} &middot; reported by ${escapeHtml(r.reporterUsername)} &middot; ${new Date(r.createdAt).toLocaleString()}</div>
          <div class="row-sub"><strong>Reason:</strong> ${escapeHtml(r.reason)}</div>
        </div>
        <pre class="dialog-quote" style="margin:10px 0 0;">${escapeHtml(r.excerpt)}</pre>
      `

      const actions = document.createElement('div')
      actions.className = 'btn-row'
      actions.style.marginTop = '10px'

      if (r.threadId) {
        const viewLink = document.createElement('a')
        viewLink.className = 'btn small'
        viewLink.href = `/forum/thread/${encodeURIComponent(r.threadId)}`
        viewLink.textContent = 'Open thread'
        actions.appendChild(viewLink)
      }

      actions.appendChild(smallBtn('Warn author', () => warnAbout(r.targetType, r.targetId)))
      actions.appendChild(smallBtn('Dismiss report', async () => {
        const ok = await Dialog.confirm({
          title: 'Dismiss this report?',
          intro: `The report against ${r.authorUsername}'s ${r.targetType} will be closed with no action taken.`,
          confirmLabel: 'Dismiss',
        })
        if (!ok) return
        await apiFetch(`/api/admin/forum-reports/${r.id}/resolve`, { method: 'POST' })
        await loadForumReports()
      }))

      row.appendChild(actions)
      forumReportsList.appendChild(row)
    })
    renderPager(forumReportsPager, meta, forumReportsState, loadForumReports)
  }

  async function loadWarnings() {
    if (!warningsList) return
    const params = new URLSearchParams({ q: warningsState.q, page: warningsState.page, pageSize: warningsState.pageSize })
    const { warnings, ...meta } = await apiFetch(`/api/admin/warnings?${params}`)
    warningsList.innerHTML = ''
    setSectionCount('warnings', meta.total)
    if (warnings.length === 0) {
      warningsList.innerHTML = '<div class="empty-note">No warnings have been issued.</div>'
      warningsPager.innerHTML = ''
      return
    }
    warnings.forEach((w) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.style.flexDirection = 'column'
      row.style.alignItems = 'stretch'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">
            ${escapeHtml(w.username)}
            ${w.revokedAt ? '<span class="badge offline">revoked</span>' : '<span class="badge error">active</span>'}
          </div>
          <div class="row-sub">${escapeHtml(w.targetType)} &middot; issued by ${escapeHtml(w.issuedByUsername)} &middot; ${new Date(w.createdAt).toLocaleString()}</div>
          <div class="row-sub"><strong>Note:</strong> ${escapeHtml(w.staffNote)}</div>
        </div>
        <pre class="dialog-quote" style="margin:10px 0 0;">${escapeHtml(w.quotedContent)}</pre>
      `

      const actions = document.createElement('div')
      actions.className = 'btn-row'
      actions.style.marginTop = '10px'

      if (w.link) {
        const viewLink = document.createElement('a')
        viewLink.className = 'btn small'
        viewLink.href = w.link
        viewLink.textContent = 'View content'
        actions.appendChild(viewLink)
      }

      if (isAdmin && !w.revokedAt) {
        actions.appendChild(smallBtn('Revoke', async () => {
          const ok = await Dialog.confirm({
            title: `Revoke this warning against ${w.username}?`,
            intro: 'It stays on their record but stops counting toward the automatic pause and ban thresholds.',
            confirmLabel: 'Revoke warning',
          })
          if (!ok) return
          await apiFetch(`/api/warnings/${w.id}/revoke`, { method: 'POST' })
          await loadWarnings()
        }))
      }

      row.appendChild(actions)
      warningsList.appendChild(row)
    })
    renderPager(warningsPager, meta, warningsState, loadWarnings)
  }

  // Shared by the forum-report and module-report rows: previews exactly what
  // the warning will quote, then asks for the staff note that explains it.
  async function warnAbout(targetType, targetId) {
    let preview
    try {
      preview = await apiFetch(`/api/warnings/preview?targetType=${encodeURIComponent(targetType)}&targetId=${encodeURIComponent(targetId)}`)
    } catch (err) {
      await Dialog.alert({ title: 'Cannot warn about this', intro: err.message })
      return
    }

    const { pause, ban, banHours } = preview.thresholds
    const next = preview.activeWarnings + 1
    const consequence = ban > 0 && next >= ban
      ? `This will be warning ${next}, which automatically bans ${preview.username}${banHours > 0 ? ` for ${banHours} hours` : ' permanently'}.`
      : pause > 0 && next >= pause
        ? `This will be warning ${next}, which automatically pauses ${preview.username}'s account.`
        : `This will be warning ${next} of ${pause > 0 ? pause : '-'} before an automatic pause.`

    const values = await Dialog.form({
      title: `Warn ${preview.username}`,
      intro: `About ${preview.label}. ${consequence}`,
      quote: preview.quotedContent,
      confirmLabel: 'Issue warning',
      danger: true,
      fields: [{
        name: 'staffNote',
        label: 'Staff note',
        type: 'textarea',
        rows: 4,
        required: true,
        minLength: 3,
        maxLength: 1000,
        placeholder: 'Explain what the problem is and what needs to change.',
        hint: `Shown to ${preview.username} alongside the quoted content above.`,
      }],
    })
    if (!values) return

    try {
      const result = await apiFetch('/api/warnings', {
        method: 'POST',
        body: JSON.stringify({ targetType, targetId, staffNote: values.staffNote }),
      })
      const suffix = result.applied === 'banned'
        ? ' They were automatically banned.'
        : result.applied === 'paused' ? ' Their account was automatically paused.' : ''
      showSuccess(`Warned ${preview.username} (${result.activeCount} active).${suffix}`)
      await loadWarnings().catch(() => {})
      await loadUsers().catch(() => {})
    } catch (err) {
      showError(err.message)
    }
  }
  window.__adminWarnAbout = warnAbout

  async function loadImportWhitelist() {
    if (!importWhitelistList) return
    const { entries } = await apiFetch('/api/admin/import-whitelist')
    importWhitelistList.innerHTML = ''
    if (entries.length === 0) {
      importWhitelistList.innerHTML = '<div class="empty-note">Nothing on the allowlist yet - sandboxed modules can\'t import anything outside their own files.</div>'
      return
    }
    entries.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `<div class="row-main"><div class="row-title">${escapeHtml(entry.name)}</div></div>`
      row.appendChild(smallBtn('Remove', async () => {
        await apiFetch(`/api/admin/import-whitelist/${encodeURIComponent(entry.name)}`, { method: 'DELETE' })
        await loadImportWhitelist()
      }))
      importWhitelistList.appendChild(row)
    })
  }

  if (importWhitelistForm) {
    importWhitelistForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const name = new FormData(importWhitelistForm).get('name')
      try {
        await apiFetch('/api/admin/import-whitelist', { method: 'POST', body: JSON.stringify({ name }) })
        importWhitelistForm.reset()
        await loadImportWhitelist()
      } catch (err) {
        showError(err.message)
      }
    })
  }

  // Settings whose "unset" state is a blank field rather than a zero: the
  // server stores null for these and falls back to its own default.
  const NULLABLE_NUMBER_SETTINGS = ['startingInvites', 'botLimitNormal', 'botLimitVip', 'botLimitMod']

  async function loadSettings() {
    if (!settingsForm) return
    const settings = await apiFetch('/api/admin/settings')
    const el = settingsForm.elements

    el.siteName.value = settings.siteName
    el.registrationOpen.checked = settings.registrationOpen
    el.invitelessRegistration.checked = settings.invitelessRegistration
    el.startingCredits.value = settings.startingCredits
    el.maintenanceMode.checked = settings.maintenanceMode
    el.maintenanceMessage.value = settings.maintenanceMessage
    el.announcementBanner.value = settings.announcementBanner
    el.marketplacePayoutRate.value = settings.marketplacePayoutRate
    el.warnThresholdPause.value = settings.warnThresholdPause
    el.warnThresholdBan.value = settings.warnThresholdBan
    el.warnBanDurationHours.value = settings.warnBanDurationHours

    NULLABLE_NUMBER_SETTINGS.forEach((key) => {
      el[key].value = Number.isInteger(settings[key]) ? settings[key] : ''
    })
  }

  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const el = settingsForm.elements

      // Blank stays null (use the default); anything else must parse to a
      // whole number, or the server would reject the whole save with a
      // message that doesn't say which field was at fault.
      const payload = {
        siteName: el.siteName.value,
        registrationOpen: el.registrationOpen.checked,
        invitelessRegistration: el.invitelessRegistration.checked,
        startingCredits: parseInt(el.startingCredits.value, 10) || 0,
        maintenanceMode: el.maintenanceMode.checked,
        maintenanceMessage: el.maintenanceMessage.value,
        announcementBanner: el.announcementBanner.value,
        marketplacePayoutRate: parseFloat(el.marketplacePayoutRate.value),
        warnThresholdPause: parseInt(el.warnThresholdPause.value, 10) || 0,
        warnThresholdBan: parseInt(el.warnThresholdBan.value, 10) || 0,
        warnBanDurationHours: parseInt(el.warnBanDurationHours.value, 10) || 0,
      }

      for (const key of NULLABLE_NUMBER_SETTINGS) {
        const raw = el[key].value.trim()
        if (raw === '') {
          payload[key] = null
          continue
        }
        const parsed = parseInt(raw, 10)
        if (!Number.isInteger(parsed) || parsed < 0) {
          await Dialog.alert({
            title: 'That value is not a whole number',
            intro: `"${key}" must be a whole number of 0 or more, or left blank to use the default.`,
          })
          return
        }
        payload[key] = parsed
      }

      // A ban threshold at or below the pause threshold means the pause step
      // can never fire - worth saying out loud rather than silently accepting.
      if (payload.warnThresholdBan > 0 && payload.warnThresholdPause > 0 &&
          payload.warnThresholdBan <= payload.warnThresholdPause) {
        const ok = await Dialog.confirm({
          title: 'The ban threshold is not above the pause threshold',
          intro: `Auto-ban fires at ${payload.warnThresholdBan} warnings and auto-pause at ${payload.warnThresholdPause}, so accounts will be banned without ever being paused first. Save anyway?`,
          confirmLabel: 'Save anyway',
          tone: 'warn',
        })
        if (!ok) return
      }

      try {
        const saved = await apiFetch('/api/admin/settings', { method: 'POST', body: JSON.stringify(payload) })
        if (saved.botsStopped > 0) {
          await Dialog.alert({
            title: 'Maintenance mode is on',
            intro: `${saved.botsStopped} running bot connection${saved.botsStopped === 1 ? ' was' : 's were'} stopped. Only admins and developers can start bots until you switch it back off.`,
            tone: 'warn',
            confirmLabel: 'Understood',
          })
        }
        showSuccess('Settings saved.')
      } catch (err) {
        showError(err.message)
      }
    })
  }

  bindSearch(usersSearch, usersState, loadUsers)
  if (botProfilesSearch) bindSearch(botProfilesSearch, botProfilesState, loadBotProfiles)
  if (botProfilesStatusFilter) {
    botProfilesStatusFilter.addEventListener('change', () => {
      botProfilesState.status = botProfilesStatusFilter.value
      botProfilesState.page = 1
      loadBotProfiles().catch((err) => showError(err.message))
    })
  }
  if (logsSearch) bindSearch(logsSearch, logsState, loadLogs)
  if (auditLogSearch) bindSearch(auditLogSearch, auditLogState, loadAuditLog)
  if (moduleReportsSearch) bindSearch(moduleReportsSearch, moduleReportsState, loadModuleReports)
  if (dmSearch) bindSearch(dmSearch, dmState, loadMessages)

  if (forumReportsSearch) bindSearch(forumReportsSearch, forumReportsState, loadForumReports)
  if (warningsSearch) bindSearch(warningsSearch, warningsState, loadWarnings)

  // ==========================================================================
  // Collapsible sections
  //
  // Everything on this page starts closed: there are a dozen sections, each
  // with its own list, search box and pager, and having them all open at once
  // made the page unusable. A section's data is only fetched the first time
  // it's opened, and the auto-refresh below only touches sections that are
  // currently open - so a collapsed page costs almost nothing.
  // ==========================================================================

  const SECTION_LOADERS = {
    users: loadUsers,
    'module-reports': loadModuleReports,
    'forum-reports': loadForumReports,
    warnings: loadWarnings,
    'bot-profiles': loadBotProfiles,
    logs: loadLogs,
    'audit-log': loadAuditLog,
    messages: loadMessages,
    settings: loadSettings,
    'import-whitelist': loadImportWhitelist,
  }

  // Sections that are cheap and safe to re-poll while open. Users is
  // deliberately excluded: it re-renders from scratch, which would blow away
  // whatever an admin is mid-typing into a credits or email field. It
  // refreshes after each action instead (see action()).
  const POLLED_SECTIONS = ['module-reports', 'forum-reports', 'bot-profiles', 'logs', 'audit-log']

  const STORAGE_KEY = 'admin.openSections'
  const sections = new Map()

  function readOpenSet() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return new Set(raw ? JSON.parse(raw) : [])
    } catch {
      return new Set()
    }
  }

  function persistOpenSet() {
    const open = [...sections.entries()].filter(([, s]) => s.el.classList.contains('open')).map(([name]) => name)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(open))
    } catch {
      // Private-mode or a full quota - the page still works, it just won't
      // remember which sections were open.
    }
  }

  async function openSection(name, { persist = true } = {}) {
    const section = sections.get(name)
    if (!section) return
    section.el.classList.add('open')
    section.head.setAttribute('aria-expanded', 'true')
    if (persist) persistOpenSet()
    if (!section.loaded) {
      section.loaded = true
      try {
        await section.load()
      } catch (err) {
        section.loaded = false
        showError(err.message)
      }
    }
  }

  function closeSection(name, { persist = true } = {}) {
    const section = sections.get(name)
    if (!section) return
    section.el.classList.remove('open')
    section.head.setAttribute('aria-expanded', 'false')
    if (persist) persistOpenSet()
  }

  // Called by the loaders to show "how many" on a collapsed header.
  function setSectionCount(name, count, attention = false) {
    const section = sections.get(name)
    if (!section || !section.count) return
    if (count === null || count === undefined) {
      section.count.classList.add('hidden')
      return
    }
    section.count.textContent = count
    section.count.classList.toggle('attention', !!attention && count > 0)
    section.count.classList.remove('hidden')
  }
  window.__adminSetSectionCount = setSectionCount

  document.querySelectorAll('.card.collapsible').forEach((el) => {
    const name = el.dataset.section
    const head = el.querySelector('.collapsible-head')
    const load = SECTION_LOADERS[name]
    if (!name || !head || !load) return

    sections.set(name, { el, head, load, loaded: false, count: el.querySelector('[data-count]') })
    head.addEventListener('click', () => {
      if (el.classList.contains('open')) closeSection(name)
      else openSection(name)
    })
  })

  document.getElementById('expand-all')?.addEventListener('click', () => {
    sections.forEach((_, name) => openSection(name, { persist: false }))
    persistOpenSet()
  })

  document.getElementById('collapse-all')?.addEventListener('click', () => {
    sections.forEach((_, name) => closeSection(name, { persist: false }))
    persistOpenSet()
  })

  // Restore whatever was open last time on this device.
  readOpenSet().forEach((name) => openSection(name, { persist: false }))

  // Counts for the collapsed headers, so the page still tells you at a glance
  // where the work is without opening anything. Deliberately a separate,
  // page-size-1 request per queue rather than loading the whole section.
  async function refreshHeaderCounts() {
    const peek = async (url) => {
      try {
        const data = await apiFetch(`${url}?pageSize=1`)
        return data.total ?? null
      } catch {
        return null
      }
    }
    setSectionCount('module-reports', await peek('/api/admin/module-reports'), true)
    setSectionCount('forum-reports', await peek('/api/admin/forum-reports'), true)
    if (isAdmin) {
      setSectionCount('users', await peek('/api/admin/users'))
      setSectionCount('warnings', await peek('/api/admin/warnings'))
    }
  }

  refreshHeaderCounts()

  setInterval(() => {
    POLLED_SECTIONS.forEach((name) => {
      const section = sections.get(name)
      if (section && section.loaded && section.el.classList.contains('open')) {
        section.load().catch(() => {})
      }
    })
    refreshHeaderCounts()
  }, 10000)
})()
