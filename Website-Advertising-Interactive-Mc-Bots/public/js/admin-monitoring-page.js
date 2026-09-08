(() => {
  const errorBox = document.getElementById('monitor-error')
  const statCpu = document.getElementById('stat-cpu')
  const statRam = document.getElementById('stat-ram')
  const statBotsRunning = document.getElementById('stat-bots-running')
  const statUsers = document.getElementById('stat-users')
  const diskList = document.getElementById('disk-list')
  const botAvgList = document.getElementById('bot-avg-list')
  const creditList = document.getElementById('credit-list')
  const salesSummaryList = document.getElementById('sales-summary-list')
  const salesByModuleList = document.getElementById('sales-by-module-list')

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

  function row(title, sub) {
    const div = document.createElement('div')
    div.className = 'data-row'
    div.innerHTML = `<div class="row-main"><div class="row-title">${title}</div>${sub ? `<div class="row-sub">${sub}</div>` : ''}</div>`
    return div
  }

  function pct(n) {
    return `${n.toFixed(1)}%`
  }

  function mb(n) {
    return n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${n.toFixed(1)} MB`
  }

  async function refresh() {
    clearError()
    try {
      const data = await apiFetch('/api/admin/monitoring')

      statCpu.textContent = pct(data.cpu.percent)
      statRam.textContent = `${pct(data.memory.percent)} (${mb(data.memory.usedMB)} / ${mb(data.memory.totalMB)})`
      statBotsRunning.textContent = data.bots.runningCount
      statUsers.textContent = data.users.total

      diskList.innerHTML = ''
      if (data.disks.length === 0) {
        diskList.innerHTML = '<div class="empty-note">Could not read disk usage on this platform.</div>'
      } else {
        data.disks.forEach((d) => {
          diskList.appendChild(row(
            `${escapeHtml(d.drive)} - ${pct(d.percent)} used`,
            `${d.usedGB.toFixed(1)} GB used of ${d.totalGB.toFixed(1)} GB (${d.freeGB.toFixed(1)} GB free)`
          ))
        })
      }

      botAvgList.innerHTML = ''
      if (data.bots.runningCount === 0) {
        botAvgList.innerHTML = '<div class="empty-note">No bots currently running.</div>'
      } else {
        botAvgList.appendChild(row(
          `Average CPU: ${pct(data.bots.avgCpuPercent)}`,
          `Average RAM: ${mb(data.bots.avgMemoryMB)} across ${data.bots.runningCount} running bot${data.bots.runningCount === 1 ? '' : 's'}`
        ))
      }

      creditList.innerHTML = ''
      creditList.appendChild(row(
        `${data.users.totalCredits.toLocaleString()} total credits in circulation`,
        `${data.users.averageCredits.toFixed(1)} average per user across ${data.users.total} user${data.users.total === 1 ? '' : 's'}`
      ))

      salesSummaryList.innerHTML = ''
      salesSummaryList.appendChild(row(
        `${data.moduleSales.totalSales} total sale${data.moduleSales.totalSales === 1 ? '' : 's'}`,
        `${data.moduleSales.totalRevenue.toLocaleString()} credits total revenue &middot; ${data.moduleSales.totalPayout.toLocaleString()} credits paid out to uploaders`
      ))

      salesByModuleList.innerHTML = ''
      if (data.moduleSales.byModule.length === 0) {
        salesByModuleList.innerHTML = '<div class="empty-note">No module purchases yet.</div>'
      } else {
        data.moduleSales.byModule.forEach((m) => {
          salesByModuleList.appendChild(row(
            escapeHtml(m.name),
            `${m.sales} sale${m.sales === 1 ? '' : 's'} &middot; ${m.revenue.toLocaleString()} credits revenue &middot; ${m.payout.toLocaleString()} credits paid out`
          ))
        })
      }
    } catch (err) {
      showError(err.message)
    }
  }

  // Resets the sales figures above. Purchases are archived rather than
  // deleted (see db.clearModuleSales), so nobody loses a module they bought -
  // the dialog says so, because "clear sales data" reads a lot scarier than
  // what it actually does.
  document.getElementById('clear-sales-btn')?.addEventListener('click', async () => {
    const ok = await Dialog.confirm({
      title: 'Clear the module sales figures?',
      intro: 'Total sales, revenue, and payouts all reset to zero, and the per-module breakdown empties. '
        + 'Nobody loses access to a module they bought and no credits move - the purchase records are kept, '
        + 'just excluded from these figures from now on. This cannot be undone from the UI.',
      confirmLabel: 'Clear sales data',
      danger: true,
      tone: 'warn',
    })
    if (!ok) return
    try {
      const { archived } = await apiFetch('/api/admin/module-sales/clear', { method: 'POST' })
      await Dialog.alert({
        title: 'Sales figures cleared',
        intro: `${archived} purchase record${archived === 1 ? ' was' : 's were'} archived. Ownership is unchanged.`,
        tone: null,
        confirmLabel: 'Close',
      })
      await refresh()
    } catch (err) {
      showError(err.message)
    }
  })

  refresh()
  setInterval(refresh, 10000)
})()
