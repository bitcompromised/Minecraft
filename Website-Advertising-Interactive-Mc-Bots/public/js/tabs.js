/* Shared tab controller.

   Any `.tab-bar` on the page is wired up automatically: its buttons carry
   `data-tab="name"` and each matching section is `.tab-panel#tab-name`. The
   active tab is mirrored into location.hash, so links like /settings#invites
   (from the nav menu) and #servers (from inside the client page) land on the
   right tab, and the back button moves between them.

   Anything else on the page can jump tabs with `data-goto-tab="name"`. */
(() => {
  const bars = Array.from(document.querySelectorAll('.tab-bar'))
  if (bars.length === 0) return

  const panels = Array.from(document.querySelectorAll('.tab-panel'))
  const names = bars.flatMap((bar) =>
    Array.from(bar.querySelectorAll('button[data-tab]')).map((btn) => btn.dataset.tab))
  const defaultName = names[0]

  function select(name, { updateHash = true } = {}) {
    if (!names.includes(name)) name = defaultName
    bars.forEach((bar) => {
      Array.from(bar.querySelectorAll('button[data-tab]')).forEach((btn) => {
        const on = btn.dataset.tab === name
        btn.classList.toggle('active', on)
        btn.setAttribute('aria-selected', on ? 'true' : 'false')
      })
    })
    panels.forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`))
    if (updateHash && location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`)
  }

  bars.forEach((bar) => {
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]')
      if (btn) select(btn.dataset.tab)
    })
  })

  document.addEventListener('click', (e) => {
    const link = e.target.closest('[data-goto-tab]')
    if (!link) return
    e.preventDefault()
    select(link.dataset.gotoTab)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  })

  window.addEventListener('hashchange', () => select(location.hash.slice(1), { updateHash: false }))

  select(location.hash.slice(1) || defaultName, { updateHash: false })

  // Exposed so a page script can react to (or drive) tab changes.
  window.selectTab = select
})()
