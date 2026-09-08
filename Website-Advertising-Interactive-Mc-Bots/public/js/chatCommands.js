/* Command completion for a chat input.
 *
 * Every command it offers was declared by a module, through its `commands`
 * export, and arrives over the socket (see src/sandboxWorker.js, which
 * sanitises it, and botChild.js's moduleCommands). Nothing here is known
 * ahead of time: load a module and its commands appear, unload it and they
 * go.
 *
 * The bot uses the same list to decide that a "/" line belongs to a module
 * rather than to the server, so anything completed here is handled locally
 * instead of being sent on as a server command.
 *
 * Used by both chat boxes - the 3D view's (public/js/main.js) and the
 * per-connection console on the client page (public/js/bots-page.js) - which
 * is why it lives in its own file rather than in either of them. Exposed as
 * window.ChatCommands, the same way dialog.js exposes window.Dialog.
 */
(function () {
  // Flattens [{moduleName, commands: [...]}] to one row per command, keeping
  // the module that owns it for display.
  function commandIndex(moduleCommands) {
    const list = []
    for (const entry of moduleCommands || []) {
      for (const command of entry.commands || []) {
        list.push(Object.assign({}, command, { moduleName: entry.moduleName }))
      }
    }
    return list
  }

  function findCommand(moduleCommands, name) {
    const needle = String(name || '').toLowerCase()
    return commandIndex(moduleCommands).find((command) => (
      command.name === needle || (command.aliases || []).indexOf(needle) !== -1
    )) || null
  }

  function subcommandRow(command, sub) {
    return {
      complete: `/${command.name} ${sub.name} `,
      label: sub.usage || `/${command.name} ${sub.name}`,
      detail: sub.description,
      source: command.moduleName,
    }
  }

  // Works out what to offer for the text currently in the box. `rows` can be
  // completed; `hint` is only shown. Both are empty for anything that is not
  // a "/" line, so ordinary chat is never interrupted by a dropdown.
  function completionsFor(moduleCommands, value) {
    const empty = { rows: [], hint: null }
    if (typeof value !== 'string' || !value.startsWith('/')) return empty

    const parts = value.slice(1).split(/\s+/)
    const endsWithSpace = /\s$/.test(value)

    // Still typing the command name itself.
    if (parts.length === 1 && !endsWithSpace) {
      const needle = parts[0].toLowerCase()
      const rows = commandIndex(moduleCommands)
        .filter((command) => command.name.indexOf(needle) === 0
          || (command.aliases || []).some((alias) => alias.indexOf(needle) === 0))
        .map((command) => ({
          complete: `/${command.name} `,
          label: command.usage || `/${command.name}`,
          detail: command.description,
          source: command.moduleName,
        }))
      return { rows, hint: null }
    }

    const command = findCommand(moduleCommands, parts[0])
    if (!command) return empty

    const commandHint = {
      label: command.usage || `/${command.name}`,
      detail: command.description,
      source: command.moduleName,
    }

    // On (or about to start) the subcommand.
    if (parts.length <= 2) {
      const needle = (endsWithSpace ? '' : (parts[1] || '')).toLowerCase()
      const rows = (command.subcommands || [])
        .filter((sub) => sub.name.indexOf(needle) === 0)
        .map((sub) => subcommandRow(command, sub))
      return { rows, hint: rows.length ? null : commandHint }
    }

    // Past the subcommand: there is nothing left to complete, but showing
    // what it expects is the whole point of having usage strings.
    const sub = (command.subcommands || []).find((entry) => entry.name === parts[1].toLowerCase())
    return { rows: [], hint: sub ? subcommandRow(command, sub) : commandHint }
  }

  /* Attaches completion to one input.
   *
   *   input      the text field being typed into
   *   container  an element to render the dropdown into (hidden when empty)
   *
   * The caller keeps its own keydown handler and calls handleKeydown first:
   * it returns true when it has consumed the key, so page-specific keys
   * (send, close the box) only run when the dropdown did not want them.
   */
  function create({ input, container }) {
    let moduleCommands = []
    let rows = []
    // -1 means nothing is picked, which is what keeps Enter sending rather
    // than completing.
    let index = -1

    function hide() {
      rows = []
      index = -1
      container.classList.add('hidden')
      container.innerHTML = ''
    }

    function isOpen() {
      return !container.classList.contains('hidden')
    }

    function apply(which) {
      const entry = rows[which]
      if (!entry) return
      input.value = entry.complete
      input.focus()
      refresh()
    }

    function highlight() {
      Array.prototype.forEach.call(container.children, (row, i) => {
        row.classList.toggle('selected', i === index)
      })
    }

    function refresh() {
      const result = completionsFor(moduleCommands, input.value)
      rows = result.rows
      // The selection resets on every keystroke: the row that was second a
      // moment ago is rarely the row that is second now.
      index = -1

      container.innerHTML = ''
      const entries = rows.length ? rows : (result.hint ? [result.hint] : [])
      if (entries.length === 0) {
        container.classList.add('hidden')
        return
      }

      entries.forEach((entry, i) => {
        const row = document.createElement('div')
        row.className = 'suggestion' + (rows.length ? '' : ' hint-only')

        const label = document.createElement('span')
        label.className = 'suggestion-label'
        label.textContent = entry.label
        row.appendChild(label)

        if (entry.detail) {
          const detail = document.createElement('span')
          detail.className = 'suggestion-detail'
          detail.textContent = entry.detail
          row.appendChild(detail)
        }

        if (entry.source) {
          const source = document.createElement('span')
          source.className = 'suggestion-source'
          source.textContent = entry.source
          row.appendChild(source)
        }

        if (rows.length) {
          // mousedown, not click: the input loses focus first on click, and
          // one of the two chat boxes closes itself when that happens.
          row.addEventListener('mousedown', (e) => {
            e.preventDefault()
            apply(i)
          })
        }
        container.appendChild(row)
      })

      container.classList.remove('hidden')
    }

    function move(delta) {
      if (rows.length === 0) return
      const next = index + delta
      // Stepping back off the top returns to "nothing picked" rather than
      // wrapping, so Enter still sends what was typed.
      index = next < -1 ? rows.length - 1 : next >= rows.length ? -1 : next
      highlight()
    }

    // Returns true when the key was consumed and the caller should stop.
    function handleKeydown(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (rows.length === 0) return false
        e.preventDefault()
        move(e.key === 'ArrowDown' ? 1 : -1)
        return true
      }

      // Tab completes the highlighted row, or the only sensible one when
      // nothing is highlighted - the usual shell behaviour.
      if (e.key === 'Tab') {
        if (rows.length === 0) return false
        e.preventDefault()
        apply(index >= 0 ? index : 0)
        return true
      }

      // Enter only completes when a row was deliberately picked; otherwise
      // it falls through to the caller's send, so a complete command is
      // never held back by its own dropdown.
      if (e.key === 'Enter') {
        if (index < 0) return false
        e.preventDefault()
        apply(index)
        return true
      }

      // Escape dismisses the dropdown. Only then - a second press is the
      // caller's to handle (closing the chat box, say).
      if (e.key === 'Escape') {
        if (!isOpen()) return false
        e.preventDefault()
        hide()
        return true
      }

      return false
    }

    return {
      refresh,
      hide,
      isOpen,
      handleKeydown,
      setCommands(list) {
        moduleCommands = Array.isArray(list) ? list : []
        // A module loading while the box is open should change what it
        // offers immediately, not on the next keystroke.
        if (document.activeElement === input) refresh()
      },
    }
  }

  window.ChatCommands = { create, completionsFor }
}())
