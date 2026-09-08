(() => {
  const threadId = document.body.dataset.threadId
  const errorBox = document.getElementById('thread-error')
  const titleEl = document.getElementById('thread-title')
  const metaEl = document.getElementById('thread-meta')
  const postList = document.getElementById('post-list')
  // Replies page at ten per view; the whole thread arrives in one payload
  // and is sliced client-side (see public/js/paginate.js).
  const POSTS_PER_PAGE = 10
  const replyCard = document.getElementById('reply-card')
  const replyForm = document.getElementById('reply-form')
  const isModOrAdmin = ['admin', 'developer'].includes(document.body.dataset.role) || document.body.dataset.status === 'mod'

  // Set when replying to a specific post (see wireReplyButton()) - cleared
  // after a successful submit or when the user cancels the quote.
  let replyingTo = null

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

  async function modAction(url, body) {
    try {
      await apiFetch(url, { method: 'POST', body: JSON.stringify(body) })
      await load()
    } catch (err) {
      showError(err.message)
    }
  }

  function editedLabel(editedAt) {
    return editedAt ? ` <span class="row-sub" title="${new Date(editedAt).toLocaleString()}">(edited)</span>` : ''
  }

  // ---- reply-to-post quoting ----

  function renderReplyPreview() {
    let bar = document.getElementById('reply-preview')
    if (!replyingTo) {
      bar?.remove()
      return
    }
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'reply-preview'
      bar.className = 'alert success'
      bar.style.display = 'flex'
      bar.style.justifyContent = 'space-between'
      bar.style.alignItems = 'center'
      bar.style.gap = '8px'
      replyForm.prepend(bar)
    }
    bar.innerHTML = `
      <span>Replying to <strong>${escapeHtml(replyingTo.authorUsername)}</strong>: "${escapeHtml(replyingTo.bodySnippet)}"</span>
    `
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn small'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => {
      replyingTo = null
      renderReplyPreview()
    })
    bar.appendChild(cancelBtn)
  }

  function wireReplyButton(container, post) {
    const btn = document.createElement('button')
    btn.className = 'btn small'
    btn.textContent = 'Reply'
    btn.addEventListener('click', () => {
      replyingTo = { id: post.id, authorUsername: post.authorUsername, bodySnippet: post.body.length > 80 ? `${post.body.slice(0, 80)}…` : post.body }
      renderReplyPreview()
      replyForm.querySelector('textarea[name="body"]').focus()
      replyForm.scrollIntoView({ behavior: 'smooth', block: 'end' })
    })
    container.appendChild(btn)
  }

  // ---- inline editing ----

  function wireEditButton(container, { getBody, submit, onSaved }) {
    const btn = document.createElement('button')
    btn.className = 'btn small'
    btn.textContent = 'Edit'
    btn.addEventListener('click', () => {
      if (container.querySelector('.edit-form')) return
      const wrap = document.createElement('div')
      wrap.className = 'edit-form'
      wrap.style.marginTop = '6px'
      const textarea = document.createElement('textarea')
      textarea.value = getBody()
      textarea.maxLength = 5000
      textarea.style.width = '100%'
      textarea.rows = 4
      wrap.appendChild(textarea)

      const actions = document.createElement('div')
      actions.style.display = 'flex'
      actions.style.gap = '6px'
      actions.style.marginTop = '4px'

      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'btn small primary'
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', async () => {
        try {
          await submit(textarea.value)
          onSaved()
        } catch (err) {
          showError(err.message)
        }
      })
      actions.appendChild(saveBtn)

      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'btn small'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => wrap.remove())
      actions.appendChild(cancelBtn)

      wrap.appendChild(actions)
      container.appendChild(wrap)
    })
    container.appendChild(btn)
  }

  function renderThread(thread) {
    titleEl.textContent = `${thread.pinned ? '📌 ' : ''}${thread.locked ? '🔒 ' : ''}${thread.title}`
    metaEl.innerHTML = `by <a href="/user/${encodeURIComponent(thread.authorUsername)}">${escapeHtml(thread.authorUsername)}</a> in ${escapeHtml(thread.section)} &middot; ${thread.views} view${thread.views === 1 ? '' : 's'}${editedLabel(thread.editedAt)}`

    // This bar used to be staff/author only. Reporting is open to everyone,
    // so it's always built now and each button decides for itself.
    let controls = document.getElementById('thread-mod-controls')
    {
      if (!controls) {
        controls = document.createElement('div')
        controls.id = 'thread-mod-controls'
        controls.className = 'btn-row'
        controls.style.marginTop = '10px'
        metaEl.after(controls)
      }
      controls.innerHTML = ''

      if (thread.canEdit) {
        wireEditButton(controls, {
          getBody: () => thread.title,
          submit: (newTitle) => apiFetch(`/api/forum/threads/${thread.id}/edit`, { method: 'POST', body: JSON.stringify({ title: newTitle }) }),
          onSaved: load,
        })
      }

      if (isModOrAdmin) {
        const pinBtn = document.createElement('button')
        pinBtn.className = 'btn small'
        pinBtn.textContent = thread.pinned ? 'Unpin' : 'Pin'
        pinBtn.addEventListener('click', () => modAction(`/api/forum/threads/${thread.id}/pin`, { pinned: !thread.pinned }))
        controls.appendChild(pinBtn)

        const lockBtn = document.createElement('button')
        lockBtn.className = 'btn small'
        lockBtn.textContent = thread.locked ? 'Unlock' : 'Lock'
        lockBtn.addEventListener('click', () => modAction(`/api/forum/threads/${thread.id}/lock`, { locked: !thread.locked }))
        controls.appendChild(lockBtn)

        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'btn small danger'
        deleteBtn.textContent = 'Delete thread'
        deleteBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: 'Delete this thread?',
            intro: `"${thread.title}" and every reply in it are removed. This cannot be undone.`,
            confirmLabel: 'Delete thread',
            danger: true,
          })
          if (!ok) return
          try {
            await apiFetch(`/api/forum/threads/${thread.id}`, { method: 'DELETE' })
            window.location.href = '/forum'
          } catch (err) {
            showError(err.message)
          }
        })
        controls.appendChild(deleteBtn)
      }

      if (!thread.canEdit || isModOrAdmin) {
        wireReportButton(controls, {
          kind: 'thread',
          id: thread.id,
          author: thread.authorUsername,
          excerpt: thread.title,
        })
      }

      if (isModOrAdmin) {
        wireWarnButton(controls, { targetType: 'thread', targetId: thread.id, author: thread.authorUsername })
      }
    }

    replyCard.style.display = thread.locked && !isModOrAdmin ? 'none' : ''
  }

  // ---- reporting and warning ----

  function excerptFor(text) {
    const str = String(text || '')
    return str.length > 800 ? `${str.slice(0, 800)}…` : str
  }

  // Sends a thread or post to the staff queue (Admin -> Forum reports).
  function wireReportButton(container, { kind, id, author, excerpt }) {
    const btn = document.createElement('button')
    btn.className = 'btn small ghost'
    btn.type = 'button'
    btn.textContent = 'Report'
    btn.addEventListener('click', async () => {
      const values = await Dialog.form({
        title: `Report this ${kind}`,
        intro: `Goes to staff, not to ${author}. They are not told who reported it.`,
        quote: excerptFor(excerpt),
        confirmLabel: 'Send report',
        danger: true,
        fields: [{
          name: 'reason',
          label: 'What is the problem?',
          type: 'textarea',
          rows: 4,
          required: true,
          minLength: 3,
          maxLength: 1000,
          placeholder: 'Spam, harassment, off-topic, something else?',
        }],
      })
      if (!values) return
      try {
        await apiFetch(`/api/forum/${kind === 'thread' ? 'threads' : 'posts'}/${id}/report`, {
          method: 'POST',
          body: JSON.stringify({ reason: values.reason }),
        })
        await Dialog.alert({
          title: 'Report sent',
          intro: 'Staff will take a look. Thanks for flagging it.',
          tone: null,
          confirmLabel: 'Close',
        })
      } catch (err) {
        showError(err.message)
      }
    })
    container.appendChild(btn)
  }

  // Staff-only: issues a warning quoting this exact content.
  function wireWarnButton(container, { targetType, targetId, author }) {
    const btn = document.createElement('button')
    btn.className = 'btn small danger'
    btn.type = 'button'
    btn.textContent = 'Warn'
    btn.addEventListener('click', async () => {
      let preview
      try {
        preview = await apiFetch(`/api/warnings/preview?targetType=${targetType}&targetId=${encodeURIComponent(targetId)}`)
      } catch (err) {
        await Dialog.alert({ title: `Cannot warn ${author}`, intro: err.message })
        return
      }

      const values = await Dialog.form({
        title: `Warn ${preview.username}`,
        intro: `About ${preview.label}. This will be warning ${preview.activeWarnings + 1} on their account.`,
        quote: preview.quotedContent,
        confirmLabel: 'Issue warning',
        danger: true,
        fields: [{
          name: 'staffNote',
          label: 'Staff note',
          type: 'textarea',
          rows: 4,
          required: true,
          minLength: 3,
          maxLength: 1000,
          placeholder: 'Explain what the problem is and what needs to change.',
          hint: `Shown to ${preview.username} with the quoted content above.`,
        }],
      })
      if (!values) return

      try {
        const result = await apiFetch('/api/warnings', {
          method: 'POST',
          body: JSON.stringify({ targetType, targetId, staffNote: values.staffNote }),
        })
        const suffix = result.applied === 'banned'
          ? ' They were automatically banned.'
          : result.applied === 'paused' ? ' Their account was automatically paused.' : ''
        await Dialog.alert({
          title: `Warned ${preview.username}`,
          intro: `That is ${result.activeCount} active warning${result.activeCount === 1 ? '' : 's'}.${suffix}`,
          tone: null,
          confirmLabel: 'Close',
        })
      } catch (err) {
        showError(err.message)
      }
    })
    container.appendChild(btn)
  }

  function renderPosts(posts, threadLocked) {
    Paginate.render({
      container: postList,
      pager: document.getElementById('post-pager'),
      items: posts,
      pageSize: POSTS_PER_PAGE,
      noun: 'post',
      emptyText: 'No posts.',
      renderItem: (p) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.style.flexDirection = 'column'
      row.style.alignItems = 'stretch'
      row.style.gap = '6px'
      const avatar = p.authorAvatarUrl ? `<img class="avatar" src="${escapeHtml(p.authorAvatarUrl)}" alt="" width="28" height="28" style="margin-right:8px;vertical-align:middle;" />` : ''
      const tagBadges = (p.authorTags || []).map((tag) => `<span class="user-tag">${escapeHtml(tag)}</span>`).join('')
      const pinnedBadge = p.pinned ? '<span class="badge approved">pinned</span> ' : ''
      const quote = p.replyTo
        ? `<div class="row-sub" style="border-left:3px solid #555;padding-left:8px;margin-bottom:2px;">↪ Replying to <strong>${escapeHtml(p.replyTo.authorUsername)}</strong>: "${escapeHtml(p.replyTo.bodySnippet)}"</div>`
        : ''
      row.innerHTML = `
        <div class="row-title">${pinnedBadge}${avatar}<a href="/user/${encodeURIComponent(p.authorUsername)}">${escapeHtml(p.authorUsername)}</a>${tagBadges} <span class="row-sub">${new Date(p.createdAt).toLocaleString()}</span>${editedLabel(p.editedAt)}</div>
        ${quote}
        <div class="row-sub post-body" style="white-space:pre-wrap;">${escapeHtml(p.body)}</div>
      `
      const controls = document.createElement('div')
      controls.style.display = 'flex'
      controls.style.gap = '6px'

      if (!(threadLocked && !isModOrAdmin)) {
        wireReplyButton(controls, p)
      }

      if (p.canEdit) {
        wireEditButton(controls, {
          getBody: () => p.body,
          submit: (newBody) => apiFetch(`/api/forum/posts/${p.id}/edit`, { method: 'POST', body: JSON.stringify({ body: newBody }) }),
          onSaved: load,
        })
      }

      // Anyone can report someone else's post to staff.
      if (!p.canEdit || isModOrAdmin) {
        wireReportButton(controls, {
          kind: 'post',
          id: p.id,
          author: p.authorUsername,
          excerpt: p.body,
        })
      }

      if (isModOrAdmin) {
        wireWarnButton(controls, { targetType: 'post', targetId: p.id, author: p.authorUsername })
      }

      if (isModOrAdmin) {
        const pinBtn = document.createElement('button')
        pinBtn.className = 'btn small'
        pinBtn.textContent = p.pinned ? 'Unpin' : 'Pin'
        pinBtn.addEventListener('click', () => modAction(`/api/forum/posts/${p.id}/pin`, { pinned: !p.pinned }))
        controls.appendChild(pinBtn)

        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'btn small danger'
        deleteBtn.textContent = 'Delete post'
        deleteBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: 'Delete this post?',
            intro: `Posted by ${p.authorUsername}. This cannot be undone.`,
            quote: p.body,
            confirmLabel: 'Delete post',
            danger: true,
          })
          if (!ok) return
          try {
            await apiFetch(`/api/forum/posts/${p.id}`, { method: 'DELETE' })
            await load()
          } catch (err) {
            showError(err.message)
          }
        })
        controls.appendChild(deleteBtn)
      }

      row.appendChild(controls)
      return row
      },
    })
  }

  async function load() {
    clearError()
    try {
      const { thread, posts } = await apiFetch(`/api/forum/threads/${threadId}`)
      renderThread(thread)
      renderPosts(posts, !!thread.locked)
    } catch (err) {
      showError(err.message)
    }
  }

  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()
    const formData = new FormData(replyForm)
    try {
      await apiFetch(`/api/forum/threads/${threadId}/posts`, {
        method: 'POST',
        body: JSON.stringify({ body: formData.get('body'), replyToId: replyingTo ? replyingTo.id : null }),
      })
      replyForm.reset()
      replyingTo = null
      renderReplyPreview()
      await load()
    } catch (err) {
      showError(err.message)
    }
  })

  load()
})()
