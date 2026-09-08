/* Shared modal dialogs.
 *
 * Replaces window.prompt/alert/confirm across the app. The browser ones can't
 * be styled, can't show more than a single line of context, and chaining two
 * of them (a reason, then a duration) has no way to cancel halfway without
 * half-applying the action.
 *
 * Every function returns a Promise:
 *   Dialog.form({...})    -> field values, or null if dismissed
 *   Dialog.confirm({...}) -> true / false
 *   Dialog.alert({...})   -> undefined once acknowledged
 *
 * Loaded by any page that needs one; exposed as window.Dialog.
 */
(() => {
  function buildShell({ title, intro, quote, tone }) {
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

    // An optional read-only excerpt of whatever is being acted on - the post
    // being reported, the module being flagged, the content a warning cites.
    if (quote) {
      const blockquote = document.createElement('pre')
      blockquote.className = 'dialog-quote'
      blockquote.textContent = quote
      box.appendChild(blockquote)
    }

    if (tone) box.classList.add(`tone-${tone}`)

    overlay.appendChild(box)
    return { overlay, box }
  }

  function attach(overlay, resolve, onDismiss) {
    const close = (result) => {
      document.removeEventListener('keydown', onKey)
      overlay.remove()
      resolve(result)
    }
    const onKey = (e) => { if (e.key === 'Escape') close(onDismiss) }

    document.addEventListener('keydown', onKey)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(onDismiss) })
    document.body.appendChild(overlay)
    return close
  }

  function buildField(f) {
    const label = document.createElement('label')
    label.textContent = f.label

    let input
    if (f.type === 'textarea') {
      input = document.createElement('textarea')
      input.rows = f.rows || 3
    } else if (f.type === 'select') {
      input = document.createElement('select')
      ;(f.options || []).forEach((opt) => {
        const option = document.createElement('option')
        option.value = opt.value
        option.textContent = opt.label
        if (opt.value === f.value) option.selected = true
        input.appendChild(option)
      })
    } else {
      input = document.createElement('input')
      input.type = f.type || 'text'
    }

    if (f.placeholder) input.placeholder = f.placeholder
    if (f.value !== undefined && f.type !== 'select') input.value = f.value
    if (f.required) input.required = true
    if (f.min !== undefined) input.min = f.min
    if (f.max !== undefined) input.max = f.max
    if (f.maxLength) input.maxLength = f.maxLength
    if (f.minLength) input.minLength = f.minLength

    label.appendChild(input)

    if (f.hint) {
      const hint = document.createElement('span')
      hint.className = 'field-hint'
      hint.textContent = f.hint
      label.appendChild(hint)
    }

    return { label, input }
  }

  /* A dialog with one or more fields. Resolves to an object of field values
   * keyed by name, or null when dismissed. */
  function form({ title, intro, quote, fields = [], confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, tone }) {
    return new Promise((resolve) => {
      const { overlay, box } = buildShell({ title, intro, quote, tone })
      const formEl = document.createElement('form')
      formEl.className = 'form-grid wide'

      const inputs = {}
      fields.forEach((f) => {
        const { label, input } = buildField(f)
        inputs[f.name] = input
        formEl.appendChild(label)
      })

      const actions = document.createElement('div')
      actions.className = 'modal-actions'

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'btn ghost'
      cancelBtn.textContent = cancelLabel
      actions.appendChild(cancelBtn)

      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'submit'
      confirmBtn.className = danger ? 'btn danger' : 'btn primary'
      confirmBtn.textContent = confirmLabel
      actions.appendChild(confirmBtn)

      formEl.appendChild(actions)
      box.appendChild(formEl)

      const close = attach(overlay, resolve, null)
      cancelBtn.addEventListener('click', () => close(null))
      formEl.addEventListener('submit', (e) => {
        e.preventDefault()
        const values = {}
        Object.entries(inputs).forEach(([name, el]) => { values[name] = el.value })
        close(values)
      })

      const first = Object.values(inputs)[0]
      if (first) first.focus()
      else confirmBtn.focus()
    })
  }

  /* Yes/no. Resolves true only on the confirm button. */
  function confirm({ title, intro, quote, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, tone }) {
    return new Promise((resolve) => {
      const { overlay, box } = buildShell({ title, intro, quote, tone })

      const actions = document.createElement('div')
      actions.className = 'modal-actions'

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'btn ghost'
      cancelBtn.textContent = cancelLabel
      actions.appendChild(cancelBtn)

      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.className = danger ? 'btn danger' : 'btn primary'
      confirmBtn.textContent = confirmLabel
      actions.appendChild(confirmBtn)

      box.appendChild(actions)

      const close = attach(overlay, resolve, false)
      cancelBtn.addEventListener('click', () => close(false))
      confirmBtn.addEventListener('click', () => close(true))
      confirmBtn.focus()
    })
  }

  /* Acknowledge-only. Used for upload rejections and other "here is exactly
   * what went wrong" messages that used to be a one-line inline alert. */
  function alert({ title, intro, quote, confirmLabel = 'Got it', tone = 'error', details = [] }) {
    return new Promise((resolve) => {
      const { overlay, box } = buildShell({ title, intro, quote, tone })

      if (details.length) {
        const list = document.createElement('ul')
        list.className = 'dialog-list'
        details.forEach((d) => {
          const li = document.createElement('li')
          li.textContent = d
          list.appendChild(li)
        })
        box.appendChild(list)
      }

      const actions = document.createElement('div')
      actions.className = 'modal-actions'
      const okBtn = document.createElement('button')
      okBtn.type = 'button'
      okBtn.className = 'btn primary'
      okBtn.textContent = confirmLabel
      actions.appendChild(okBtn)
      box.appendChild(actions)

      const close = attach(overlay, resolve, undefined)
      okBtn.addEventListener('click', () => close(undefined))
      okBtn.focus()
    })
  }

  /* Full-size image/video viewer. Module screenshots are rendered small on
   * the page; clicking one opens it here at its natural size, bounded by the
   * viewport. Click anywhere, or press Escape, to close. */
  function lightbox({ src, type = 'image', caption }) {
    const overlay = document.createElement('div')
    overlay.className = 'modal lightbox'

    const figure = document.createElement('figure')
    figure.className = 'lightbox-figure'

    const media = document.createElement(type === 'video' ? 'video' : 'img')
    media.src = src
    if (type === 'video') {
      media.controls = true
      media.autoplay = true
    } else {
      media.alt = caption || ''
    }
    figure.appendChild(media)

    if (caption) {
      const figcaption = document.createElement('figcaption')
      figcaption.textContent = caption
      figure.appendChild(figcaption)
    }

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'lightbox-close'
    closeBtn.setAttribute('aria-label', 'Close')
    closeBtn.textContent = '×'
    figure.appendChild(closeBtn)

    overlay.appendChild(figure)

    return new Promise((resolve) => {
      const close = attach(overlay, resolve, undefined)
      closeBtn.addEventListener('click', () => close(undefined))
      // Clicking the backdrop closes; clicking the media itself does not, so
      // video controls stay usable.
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target === figure) close(undefined)
      })
      closeBtn.focus()
    })
  }

  /* Opens a chunk of markup that already exists on the page as a dialog.
   *
   * Used for forms that post files or whose submit handlers are bound by a
   * page script to specific element ids (the client page's spawn/new-profile/
   * new-server/new-proxy forms, the marketplace upload form, the module
   * Manage panel). The element is *moved* into the modal and moved back on
   * close - rebuilding it inside the dialog would drop both the handlers and
   * any selected file.
   *
   * The dialog does NOT close when a form inside it is submitted. Submitting
   * is not the same as succeeding: closing on submit meant a rejected upload
   * threw away everything the user had typed and reported the problem to a
   * page they could no longer see. The page script decides, calling
   * Dialog.closePanel(el) once the request actually worked, and
   * Dialog.panelError(el, ...) when it didn't.
   *
   * Returns a close() function; the dialog also closes on Escape and on the
   * backdrop.
   */
  function openPanel(el, { title, wide = true } = {}) {
    if (!el) return () => {}

    // Remember where it lives so it can go home again.
    const home = el.parentNode
    const anchor = document.createComment('panel-home')
    home.insertBefore(anchor, el)

    const overlay = document.createElement('div')
    overlay.className = 'modal'

    const box = document.createElement('div')
    box.className = `modal-box${wide ? ' wide' : ''} panel-dialog`

    if (title) {
      const heading = document.createElement('h2')
      heading.textContent = title
      box.appendChild(heading)
    }

    el.classList.remove('hidden')
    box.appendChild(el)
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const close = () => {
      document.removeEventListener('keydown', onKey)
      clearPanelError(el)
      el.classList.add('hidden')
      home.insertBefore(el, anchor)
      anchor.remove()
      overlay.remove()
      delete el.__dialogClose
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }

    // Stored on the element so the page script can close this exact panel
    // without having to thread the return value through its own state.
    el.__dialogClose = close

    document.addEventListener('keydown', onKey)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close() })

    const firstField = el.querySelector('input:not([type=hidden]), select, textarea')
    if (firstField) firstField.focus()

    return close
  }

  function closePanel(el) {
    el?.__dialogClose?.()
  }

  /* Shows a failure inside an open panel, above its form, keeping whatever
   * the user entered. `problems` is an optional list - the module validator
   * returns every reason a file was rejected, not just the first, and all of
   * them are worth showing at once. */
  function panelError(el, message, problems) {
    if (!el) return
    let box = el.querySelector(':scope > .panel-error')
    if (!box) {
      box = document.createElement('div')
      box.className = 'panel-error alert error'
      el.insertBefore(box, el.firstChild)
    }
    box.innerHTML = ''

    const heading = document.createElement('strong')
    heading.textContent = message
    box.appendChild(heading)

    if (Array.isArray(problems) && problems.length > 1) {
      const list = document.createElement('ul')
      list.className = 'dialog-list'
      list.style.margin = '8px 0 0'
      problems.forEach((p) => {
        const li = document.createElement('li')
        li.textContent = p
        list.appendChild(li)
      })
      box.appendChild(list)
    }

    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  function clearPanelError(el) {
    el?.querySelector(':scope > .panel-error')?.remove()
  }

  window.Dialog = { form, confirm, alert, lightbox, openPanel, closePanel, panelError, clearPanelError }
})()
