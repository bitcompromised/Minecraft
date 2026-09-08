/* Shared top-bar behaviour: the user menu, the mobile nav drawer, the
   site-wide announcement/maintenance banners, and the unread-message badge.
   Loaded by every signed-in page. */
(() => {
  // ---- user dropdown ----

  const userBtn = document.getElementById('nav-user-btn')
  const userMenu = document.getElementById('nav-menu')

  if (userBtn && userMenu) {
    const setOpen = (open) => {
      userMenu.classList.toggle('hidden', !open)
      userBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    }

    userBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      setOpen(userMenu.classList.contains('hidden'))
    })

    document.addEventListener('click', (e) => {
      if (!userMenu.contains(e.target)) setOpen(false)
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false)
    })
  }

  // ---- mobile nav drawer ----

  const navToggle = document.getElementById('nav-toggle')
  const navLinks = document.getElementById('nav-links')

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const open = navLinks.classList.toggle('open')
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
  }

  // ---- notifications bell ----
  // Forum replies, replies to your posts, and staff warnings. The count is
  // fetched on every page load; the list itself only when the menu is opened,
  // so the per-page cost stays a single small request.

  const bellBtn = document.getElementById('nav-bell-btn')
  const bellCount = document.getElementById('nav-bell-count')
  const notifMenu = document.getElementById('notif-menu')
  const notifList = document.getElementById('notif-list')

  function relativeTime(ts) {
    const seconds = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 30) return `${days}d ago`
    return new Date(ts).toLocaleDateString()
  }

  // Tracked so a single dismissal can decrement the badge without another
  // round trip.
  let currentUnread = 0

  function setCount(count) {
    currentUnread = count
    if (!bellCount) return
    if (count > 0) {
      bellCount.textContent = count > 99 ? '99+' : count
      bellCount.classList.remove('hidden')
    } else {
      bellCount.classList.add('hidden')
    }
  }

  async function loadNotifications() {
    if (!notifList) return
    try {
      const res = await fetch('/api/notifications')
      const { notifications } = await res.json()
      notifList.innerHTML = ''
      if (!notifications || notifications.length === 0) {
        notifList.innerHTML = '<div class="empty-note">Nothing yet.</div>'
        return
      }
      notifications.forEach((n) => {
        const item = document.createElement('a')
        item.className = 'notif-item'
        if (!n.readAt) item.classList.add('unread')
        if (n.type === 'warning') item.classList.add('warning')
        item.href = n.link || '#'

        const title = document.createElement('div')
        title.className = 'n-title'
        title.textContent = n.title
        item.appendChild(title)

        if (n.body) {
          const body = document.createElement('div')
          body.className = 'n-body'
          body.textContent = n.body
          item.appendChild(body)
        }

        const time = document.createElement('div')
        time.className = 'n-time'
        time.textContent = relativeTime(n.createdAt)
        item.appendChild(time)

        // Clicking a notification consumes it: it's dismissed server-side and
        // removed from the list right away, so the bell only ever shows
        // things that still need attention. Done before navigating rather
        // than on the destination page, so it also holds for links opened in
        // a new tab.
        item.addEventListener('click', () => {
          fetch('/api/notifications/dismiss', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [n.id] }),
          }).catch(() => {})

          item.remove()
          setCount(Math.max(0, currentUnread - 1))
          currentUnread = Math.max(0, currentUnread - 1)
          if (!notifList.children.length) {
            notifList.innerHTML = '<div class="empty-note">Nothing yet.</div>'
          }
        })

        notifList.appendChild(item)
      })
    } catch {
      notifList.innerHTML = '<div class="empty-note">Could not load notifications.</div>'
    }
  }

  if (bellBtn && notifMenu) {
    const setOpen = (open) => {
      notifMenu.classList.toggle('hidden', !open)
      bellBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
      if (open) loadNotifications()
    }

    bellBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      setOpen(notifMenu.classList.contains('hidden'))
    })

    document.addEventListener('click', (e) => {
      if (!notifMenu.contains(e.target) && e.target !== bellBtn) setOpen(false)
    })

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false)
    })

    document.getElementById('notif-mark-all')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await fetch('/api/notifications/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        setCount(0)
        await loadNotifications()
      } catch {
        // non-critical
      }
    })

    fetch('/api/notifications/unread-count')
      .then((r) => r.json())
      .then(({ count }) => setCount(count))
      .catch(() => {})
  }

  // ---- logout ----

  document.getElementById('nav-logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    location.href = '/login'
  })
})()

// Site-wide maintenance/announcement banner (admin-configurable, see the
// Admin page's Website settings card) - shown directly under the nav on
// every page that loads this script.
;(async () => {
  try {
    const res = await fetch('/api/public-settings')
    const settings = await res.json()
    const nav = document.querySelector('.panel-nav')
    if (!nav) return

    const addBanner = (text, kind) => {
      const banner = document.createElement('div')
      banner.className = `site-banner ${kind}`
      banner.textContent = text
      nav.after(banner)
    }

    if (settings.announcementBanner) addBanner(settings.announcementBanner, 'info')
    // Added last so it ends up on top - a maintenance notice outranks an
    // announcement when both are set.
    if (settings.maintenanceMode && settings.maintenanceMessage) {
      addBanner(`Maintenance mode: ${settings.maintenanceMessage}`, 'warning')
    }
  } catch {
    // non-critical - a failed fetch just means no banner, not a broken page
  }
})()

// Unread private-message count badge next to the Messages nav link.
;(async () => {
  const badge = document.getElementById('nav-unread-badge')
  if (!badge) return
  try {
    const res = await fetch('/api/messages/unread-count')
    const { count } = await res.json()
    if (count > 0) {
      badge.textContent = count
      badge.classList.remove('hidden')
    }
  } catch {
    // non-critical
  }
})()
