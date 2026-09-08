(() => {
  const errorBox = document.getElementById('invites-error')
  const inviteList = document.getElementById('invite-list')
  const referralList = document.getElementById('referral-list')
  const btnNewInvite = document.getElementById('btn-new-invite')

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

  function renderInvites(invites) {
    inviteList.innerHTML = ''
    if (invites.length === 0) {
      inviteList.innerHTML = '<div class="empty-note">No invites generated yet.</div>'
      return
    }
    invites.forEach((invite) => {
      const link = `${location.origin}/login?invite=${invite.code}`
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${invite.usedAt ? 'Used' : 'Unused'}</div>
          <div class="row-sub">${escapeHtml(link)}</div>
        </div>
      `
      if (!invite.usedAt) {
        const copyBtn = document.createElement('button')
        copyBtn.className = 'btn small'
        copyBtn.textContent = 'Copy'
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(link)
            copyBtn.textContent = 'Copied!'
            setTimeout(() => { copyBtn.textContent = 'Copy' }, 1500)
          } catch {
            prompt('Copy this invite link:', link)
          }
        })
        row.appendChild(copyBtn)

        const revokeBtn = document.createElement('button')
        revokeBtn.className = 'btn small danger'
        revokeBtn.textContent = 'Revoke'
        revokeBtn.addEventListener('click', async () => {
          try {
            await apiFetch(`/api/invites/${invite.id}`, { method: 'DELETE' })
            await refresh()
          } catch (err) {
            showError(err.message)
          }
        })
        row.appendChild(revokeBtn)
      }
      inviteList.appendChild(row)
    })
  }

  function renderReferrals(referrals) {
    referralList.innerHTML = ''
    if (referrals.length === 0) {
      referralList.innerHTML = '<div class="empty-note">Nobody has joined through your invites yet.</div>'
      return
    }
    referrals.forEach((r) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(r.username)}</div>
          <div class="row-sub">Joined ${new Date(r.joinedAt).toLocaleString()}</div>
        </div>
      `
      referralList.appendChild(row)
    })
  }

  async function refresh() {
    clearError()
    try {
      const data = await apiFetch('/api/invites')
      document.getElementById('stat-quota').textContent = data.quota
      document.getElementById('stat-used').textContent = data.used
      document.getElementById('stat-remaining').textContent = data.remaining
      renderInvites(data.invites)
      renderReferrals(data.referrals)
      btnNewInvite.disabled = data.remaining <= 0
    } catch (err) {
      showError(err.message)
    }
  }

  btnNewInvite.addEventListener('click', async () => {
    clearError()
    try {
      await apiFetch('/api/invites', { method: 'POST' })
      await refresh()
    } catch (err) {
      showError(err.message)
    }
  })

  refresh()
})()
