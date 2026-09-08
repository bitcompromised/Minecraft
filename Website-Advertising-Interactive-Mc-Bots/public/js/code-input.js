/* Makes a plain <textarea class="code-input"> behave enough like an editor
 * to write a module in: Tab indents instead of leaving the field, and a
 * running line count sits underneath it.
 *
 * Wired up automatically for anything matching .code-input, including
 * textareas that appear later (the upload and update forms live hidden in
 * the page and are moved into dialogs), so pages don't have to call it.
 */
(() => {
  const INDENT = '  '

  function handleKeydown(e) {
    const el = e.target
    if (!el.classList || !el.classList.contains('code-input')) return

    // Tab in a form normally moves focus. In a code box that makes it
    // impossible to indent, so it inserts spaces instead - Escape first, then
    // Tab, still gets you out of the field for keyboard navigation.
    if (e.key === 'Tab') {
      e.preventDefault()
      const { selectionStart: start, selectionEnd: end, value } = el

      if (e.shiftKey) {
        // Outdent: strip one indent from the start of the current line.
        const lineStart = value.lastIndexOf('\n', start - 1) + 1
        if (value.startsWith(INDENT, lineStart)) {
          el.value = value.slice(0, lineStart) + value.slice(lineStart + INDENT.length)
          el.selectionStart = Math.max(lineStart, start - INDENT.length)
          el.selectionEnd = Math.max(lineStart, end - INDENT.length)
        }
      } else {
        el.value = value.slice(0, start) + INDENT + value.slice(end)
        el.selectionStart = el.selectionEnd = start + INDENT.length
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }

    // Enter keeps the current line's indentation, which is most of what an
    // editor's auto-indent is actually for.
    if (e.key === 'Enter') {
      const { selectionStart: start, value } = el
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const indent = (value.slice(lineStart, start).match(/^[ \t]*/) || [''])[0]
      if (!indent) return
      e.preventDefault()
      const insert = `\n${indent}`
      el.value = value.slice(0, start) + insert + value.slice(el.selectionEnd)
      el.selectionStart = el.selectionEnd = start + insert.length
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  function lineCountFor(el) {
    return el.value ? el.value.split('\n').length : 0
  }

  function updateCounts() {
    document.querySelectorAll('.code-input').forEach((el) => {
      const field = el.closest('.code-field')
      const counter = field?.querySelector('.line-count')
      if (!counter) return
      const lines = lineCountFor(el)
      counter.textContent = `${lines} line${lines === 1 ? '' : 's'}`
    })
  }

  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('input', (e) => {
    if (e.target.classList && e.target.classList.contains('code-input')) updateCounts()
  })

  // "Reset to template" buttons next to a code box.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-reset-template]')
    if (!btn) return
    const field = btn.closest('.code-field')
    const el = field?.querySelector('.code-input')
    if (!el) return
    el.value = window.MODULE_TEMPLATE || ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.focus()
  })

  // Prefill any box that asked for the starter template and is still empty.
  function applyTemplates() {
    document.querySelectorAll('.code-input[data-template]').forEach((el) => {
      if (el.value.trim() === '') el.value = window.MODULE_TEMPLATE || ''
    })
    updateCounts()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTemplates)
  } else {
    applyTemplates()
  }
})()
