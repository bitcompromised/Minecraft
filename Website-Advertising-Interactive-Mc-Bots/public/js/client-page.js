/* Client page glue: the "spawn a bot" composer, and the buttons that open
   the page's four forms as dialogs.

   Tab switching is handled by the shared tabs.js, and the per-tab content is
   still rendered by the two original scripts (bot-profiles-page.js and
   bots-page.js) that this page loads first - so this file only adds what is
   genuinely new to the consolidated layout. */
(() => {
  // ---- popup forms ----
  // The forms live hidden in #form-vault; each button moves its own into a
  // modal (see Dialog.openPanel) so the page scripts keep their bindings.
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-open-form]')
    if (!trigger) return
    const name = trigger.dataset.openForm
    const panel = document.querySelector(`[data-form="${name}"]`)
    if (!panel) return
    // Reloading the dropdowns first means a profile or server added moments
    // ago is already in the list when the spawn dialog opens.
    if (name === 'spawn') loadOptions()
    Dialog.openPanel(panel, { title: panel.dataset.formTitle })
  })

  const form = document.getElementById('spawn-form')
  const profileSelect = document.getElementById('spawn-profile')
  const serverSelect = document.getElementById('spawn-server')
  const proxySelect = document.getElementById('spawn-proxy')
  const spawnBtn = document.getElementById('spawn-btn')
  const hint = document.getElementById('spawn-hint')
  const errorBox = document.getElementById('spawn-error')
  const successBox = document.getElementById('spawn-success')

  function setMessage(box, message) {
    box.textContent = message
    box.classList.remove('hidden')
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

  function fillSelect(select, items, { placeholder, label, value }) {
    const previous = select.value
    select.innerHTML = ''
    if (placeholder != null) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = placeholder
      select.appendChild(opt)
    }
    items.forEach((item) => {
      const opt = document.createElement('option')
      opt.value = value(item)
      opt.textContent = label(item)
      select.appendChild(opt)
    })
    // Keep the operator's current pick across the periodic reloads below.
    if (previous && Array.from(select.options).some((o) => o.value === previous)) select.value = previous
  }

  async function loadOptions() {
    try {
      const [{ bots }, { servers }, { proxies }] = await Promise.all([
        apiFetch('/api/bots?pageSize=200'),
        apiFetch('/api/servers'),
        apiFetch('/api/proxies'),
      ])

      fillSelect(profileSelect, bots, {
        label: (b) => `${b.name} (${b.mcUsername})`,
        value: (b) => b.id,
      })
      fillSelect(serverSelect, servers, {
        label: (s) => `${s.name} - ${s.host}:${s.port}`,
        value: (s) => s.id,
      })
      fillSelect(proxySelect, proxies, {
        placeholder: 'No proxy (direct)',
        label: (p) => `${p.name} (${p.type})`,
        value: (p) => p.id,
      })

      // The composer is only usable once there's at least one of each; say
      // which piece is missing rather than failing silently on submit.
      const missing = []
      if (!bots.length) missing.push('a bot profile')
      if (!servers.length) missing.push('a server')
      spawnBtn.disabled = missing.length > 0
      hint.innerHTML = missing.length
        ? `Add ${missing.join(' and ')} first.`
        : `${bots.length} profile${bots.length === 1 ? '' : 's'} &middot; ${servers.length} server${servers.length === 1 ? '' : 's'} &middot; ${proxies.length} prox${proxies.length === 1 ? 'y' : 'ies'}`
    } catch (err) {
      setMessage(errorBox, err.message)
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearMessages()
    // The dialog stays open on failure so the picks aren't lost - it closes
    // itself below only once the bot has actually started.
    const panel = form.closest('[data-form]')
    Dialog.clearPanelError(panel)

    if (!profileSelect.value || !serverSelect.value) {
      Dialog.panelError(panel, 'Pick a profile and a server first.')
      return
    }
    const profileName = profileSelect.options[profileSelect.selectedIndex].textContent
    const serverName = serverSelect.options[serverSelect.selectedIndex].textContent
    spawnBtn.disabled = true
    try {
      await apiFetch(`/api/bots/${profileSelect.value}/start`, {
        method: 'POST',
        body: JSON.stringify({ serverId: serverSelect.value, proxyId: proxySelect.value || null }),
      })
      Dialog.closePanel(panel)
      setMessage(successBox, `Starting ${profileName} on ${serverName}. Watch its status below.`)
      // Nudge bots-page.js to re-render now instead of waiting out its poll.
      window.dispatchEvent(new CustomEvent('bots:refresh'))
    } catch (err) {
      // Maintenance mode, the tier bot limit, a paused account - all worth
      // reading with the form still in front of you.
      Dialog.panelError(panel, err.message)
    }
    spawnBtn.disabled = false
  })

  // bot-profiles-page.js fires this after every create/delete, so the
  // composer's dropdowns never go stale behind a tab switch.
  window.addEventListener('client:data-changed', loadOptions)
  loadOptions()
})()
