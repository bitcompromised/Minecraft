/* Client-side pagination for lists that arrive whole.
 *
 * Module reviews, comments, bug reports, changelog entries and forum posts
 * all come down in one payload - they're bounded per module/thread, so
 * paging them on the server would cost a round trip per page for no benefit.
 * This slices the array and renders a matching pager.
 *
 * Usage:
 *   Paginate.render({ container, pager, items, pageSize, renderItem, emptyText })
 *
 * The current page is kept per-container, so re-rendering after an edit or a
 * new post lands the reader back where they were rather than on page 1.
 * Exposed as window.Paginate.
 */
(() => {
  const pageByContainer = new WeakMap()

  function buildPager(pagerEl, { page, totalPages, total, noun }, onGo) {
    pagerEl.innerHTML = ''
    if (totalPages <= 1) return

    const info = document.createElement('span')
    info.textContent = `${total} ${noun}${total === 1 ? '' : 's'} - page ${page} of ${totalPages}`
    pagerEl.appendChild(info)

    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'btn small'
    prev.textContent = 'Prev'
    prev.disabled = page <= 1
    prev.addEventListener('click', () => onGo(page - 1))
    pagerEl.appendChild(prev)

    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'btn small'
    next.textContent = 'Next'
    next.disabled = page >= totalPages
    next.addEventListener('click', () => onGo(page + 1))
    pagerEl.appendChild(next)
  }

  function render({ container, pager, items, pageSize, renderItem, emptyText, noun = 'item', resetPage = false }) {
    if (!container) return
    const list = items || []

    if (resetPage) pageByContainer.set(container, 1)
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize))
    // Clamp: deleting the last item on the final page shouldn't strand the
    // reader on an empty one.
    let page = Math.min(pageByContainer.get(container) || 1, totalPages)
    pageByContainer.set(container, page)

    container.innerHTML = ''
    if (list.length === 0) {
      container.innerHTML = `<div class="empty-note">${emptyText || 'Nothing here yet.'}</div>`
      if (pager) pager.innerHTML = ''
      return
    }

    const start = (page - 1) * pageSize
    list.slice(start, start + pageSize).forEach((item, i) => {
      const el = renderItem(item, start + i)
      if (el) container.appendChild(el)
    })

    if (pager) {
      buildPager(pager, { page, totalPages, total: list.length, noun }, (nextPage) => {
        pageByContainer.set(container, nextPage)
        render({ container, pager, items: list, pageSize, renderItem, emptyText, noun })
        container.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      })
    }
  }

  window.Paginate = { render }
})()
