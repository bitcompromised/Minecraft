(() => {
  const errorBox = document.getElementById('settings-error')
  const successBox = document.getElementById('settings-success')
  const passwordForm = document.getElementById('password-form')
  const avatarForm = document.getElementById('avatar-form')
  const avatarPreview = document.getElementById('avatar-preview')
  const bioForm = document.getElementById('bio-form')
  const emailForm = document.getElementById('email-form')

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

  passwordForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const formData = new FormData(passwordForm)
    const { currentPassword, newPassword, confirmPassword } = Object.fromEntries(formData.entries())
    if (newPassword !== confirmPassword) {
      showError('New passwords do not match.')
      return
    }
    try {
      await apiFetch('/api/settings/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      passwordForm.reset()
      showSuccess('Password updated.')
    } catch (err) {
      showError(err.message)
    }
  })

  avatarForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const res = await fetch('/api/settings/avatar', { method: 'POST', body: new FormData(avatarForm) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Upload failed.')
      avatarPreview.src = `${data.avatarUrl}?t=${Date.now()}`
      avatarPreview.style.display = ''
      showSuccess('Profile picture updated.')
    } catch (err) {
      showError(err.message)
    }
  })

  emailForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = new FormData(emailForm).get('email') || ''
    try {
      const data = await apiFetch('/api/settings/email', { method: 'POST', body: JSON.stringify({ email }) })
      showSuccess(data.email ? `Email set to ${data.email}.` : 'Email address removed.')
    } catch (err) {
      showError(err.message)
    }
  })

  // ---- warnings ----
  // A warning quotes the content it was issued over, so it still makes sense
  // after the original has been edited or deleted.

  const warningsList = document.getElementById('my-warnings')
  const warningsSummary = document.getElementById('warnings-summary')
  const warningsTabCount = document.getElementById('warnings-tab-count')

  function escapeHtml(str) {
    const div = document.createElement('div')
    div.textContent = str == null ? '' : str
    return div.innerHTML
  }

  async function loadWarnings() {
    if (!warningsList) return
    try {
      const { warnings, activeCount } = await apiFetch('/api/warnings')

      if (warningsTabCount) {
        warningsTabCount.textContent = activeCount
        warningsTabCount.classList.toggle('hidden', activeCount === 0)
      }
      warningsSummary.textContent = activeCount === 0
        ? 'No active warnings'
        : `${activeCount} active warning${activeCount === 1 ? '' : 's'}`

      warningsList.innerHTML = ''
      if (warnings.length === 0) {
        warningsList.innerHTML = '<div class="empty-note">You have never been warned. Keep it that way.</div>'
        return
      }

      warnings.forEach((w) => {
        const card = document.createElement('div')
        card.className = 'warning-card' + (w.revokedAt ? ' revoked' : '')
        card.innerHTML = `
          <div class="w-head">
            <strong>Warning about your ${escapeHtml(w.targetType)}</strong>
            <span class="row-sub">
              ${new Date(w.createdAt).toLocaleString()} &middot; by ${escapeHtml(w.issuedByUsername)}
              ${w.revokedAt ? ' &middot; <span class="badge offline">revoked</span>' : ''}
            </span>
          </div>
          <div class="w-note">${escapeHtml(w.staffNote)}</div>
          <pre class="w-quote">${escapeHtml(w.quotedContent)}</pre>
        `

        const actions = document.createElement('div')
        actions.className = 'btn-row'
        actions.style.marginTop = '12px'

        if (w.link) {
          const link = document.createElement('a')
          link.className = 'btn small ghost'
          link.href = w.link
          link.textContent = 'View the content'
          actions.appendChild(link)
        }

        if (!w.acknowledgedAt && !w.revokedAt) {
          const ackBtn = document.createElement('button')
          ackBtn.className = 'btn small'
          ackBtn.type = 'button'
          ackBtn.textContent = 'I understand'
          ackBtn.addEventListener('click', async () => {
            try {
              await apiFetch(`/api/warnings/${w.id}/acknowledge`, { method: 'POST' })
              await loadWarnings()
            } catch (err) {
              showError(err.message)
            }
          })
          actions.appendChild(ackBtn)
        } else if (w.acknowledgedAt) {
          const ack = document.createElement('span')
          ack.className = 'row-sub'
          ack.textContent = `Acknowledged ${new Date(w.acknowledgedAt).toLocaleDateString()}`
          actions.appendChild(ack)
        }

        card.appendChild(actions)
        warningsList.appendChild(card)
      })
    } catch (err) {
      warningsList.innerHTML = `<div class="empty-note">${escapeHtml(err.message)}</div>`
    }
  }

  loadWarnings()

  bioForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const bio = new FormData(bioForm).get('bio') || ''
    try {
      await apiFetch('/api/settings/bio', { method: 'POST', body: JSON.stringify({ bio }) })
      showSuccess('Bio updated.')
    } catch (err) {
      showError(err.message)
    }
  })
})()
