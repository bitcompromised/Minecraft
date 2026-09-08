(() => {
  const moduleId = document.body.dataset.moduleId
  const isModOrAdmin = ['admin', 'developer'].includes(document.body.dataset.role) || document.body.dataset.status === 'mod'
  const isAdmin = ['admin', 'developer'].includes(document.body.dataset.role)
  const errorBox = document.getElementById('module-error')
  const successBox = document.getElementById('module-success')
  const atRiskBanner = document.getElementById('module-at-risk-banner')
  const titleEl = document.getElementById('module-title')
  const metaEl = document.getElementById('module-meta')
  const mediaEl = document.getElementById('module-media')
  const descriptionEl = document.getElementById('module-description')
  const actionsEl = document.getElementById('module-actions')
  const changelogEl = document.getElementById('module-changelog')

  // How many of each sub-list fit on a page before it gets a pager. These
  // lists arrive whole in the module payload and are sliced client-side (see
  // public/js/paginate.js).
  const PAGE_SIZES = { reviews: 5, comments: 10, bugReports: 5, changelog: 5 }

  const reviewsEl = document.getElementById('module-reviews')
  const reviewsPager = document.getElementById('module-reviews-pager')
  const reviewActions = document.getElementById('review-actions')
  const ratingSummaryEl = document.getElementById('module-rating-summary')
  const reviewForm = document.getElementById('review-form')
  const reviewGateNote = document.getElementById('review-gate-note')

  const commentsEl = document.getElementById('module-comments')
  const commentsPager = document.getElementById('module-comments-pager')
  const commentForm = document.getElementById('comment-form')

  const bugReportsEl = document.getElementById('module-bug-reports')
  const bugReportsPager = document.getElementById('module-bug-reports-pager')
  const changelogPager = document.getElementById('module-changelog-pager')

  const transactionsCard = document.getElementById('transactions-card')
  const transactionsEl = document.getElementById('module-transactions')
  const earningsSummaryEl = document.getElementById('earnings-summary')

  const manageCard = document.getElementById('manage-card')
  const mediaForm = document.getElementById('media-form')
  const updateForm = document.getElementById('update-form')
  const atRiskControls = document.getElementById('at-risk-controls')
  const visibilityControls = document.getElementById('visibility-controls')

  const moderationCard = document.getElementById('moderation-card')
  const updateList = document.getElementById('update-list')
  const deleteModuleBtn = document.getElementById('delete-module-btn')
  const adminAtRiskControls = document.getElementById('admin-at-risk-controls')

  const sourceModal = document.getElementById('source-modal')
  const sourceModalTitle = document.getElementById('source-modal-title')
  const sourceModalCode = document.getElementById('source-modal-code')
  document.getElementById('source-modal-close').addEventListener('click', () => sourceModal.classList.add('hidden'))

  const diffModal = document.getElementById('diff-modal')
  const diffModalCode = document.getElementById('diff-modal-code')
  document.getElementById('diff-modal-close').addEventListener('click', () => diffModal.classList.add('hidden'))

  function showError(message) {
    successBox.classList.add('hidden')
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  function showSuccess(message) {
    errorBox.classList.add('hidden')
    successBox.textContent = message
    successBox.classList.remove('hidden')
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

  async function viewSource(url, title) {
    try {
      const { source } = await apiFetch(url)
      sourceModalTitle.textContent = title
      sourceModalCode.textContent = source
      sourceModal.classList.remove('hidden')
    } catch (err) {
      showError(err.message)
    }
  }

  async function viewDiff(updateId) {
    try {
      const diff = await apiFetch(`/api/marketplace/modules/${moduleId}/updates/${updateId}/diff`)
      if (diff.tooLarge) {
        diffModalCode.textContent = `File too large to diff line-by-line (${diff.oldLineCount} -> ${diff.newLineCount} lines).`
      } else {
        diffModalCode.innerHTML = diff.hunks.map((h) => {
          const prefix = h.type === 'add' ? '+ ' : h.type === 'remove' ? '- ' : '  '
          const cls = h.type === 'add' ? 'diff-add' : h.type === 'remove' ? 'diff-remove' : 'diff-context'
          return `<span class="${cls}">${escapeHtml(prefix + h.line)}</span>`
        }).join('\n')
        diffModalCode.prepend(`+${diff.additions} / -${diff.removals}\n\n`)
      }
      diffModal.classList.remove('hidden')
    } catch (err) {
      showError(err.message)
    }
  }

  function renderMedia(media, moduleName) {
    mediaEl.innerHTML = ''
    if (!media || media.length === 0) return
    mediaEl.style.display = 'flex'
    mediaEl.style.gap = '10px'
    mediaEl.style.marginBottom = '16px'
    mediaEl.style.flexWrap = 'wrap'

    media.forEach((item, index) => {
      const wrap = document.createElement('div')

      // Thumbnails are cropped to a consistent size; the real thing opens in
      // a lightbox at its natural resolution, which is the only way to
      // actually read a screenshot of a module's output.
      const thumb = document.createElement('button')
      thumb.type = 'button'
      thumb.className = 'media-thumb'
      thumb.title = 'Click to view full size'

      const el = item.type === 'video' ? document.createElement('video') : document.createElement('img')
      el.src = item.url
      if (item.type === 'video') {
        el.muted = true
        el.preload = 'metadata'
      } else {
        el.alt = `${moduleName || 'Module'} screenshot ${index + 1}`
      }
      thumb.appendChild(el)

      const hint = document.createElement('span')
      hint.className = 'zoom-hint'
      hint.textContent = item.type === 'video' ? 'Play' : 'View'
      thumb.appendChild(hint)

      thumb.addEventListener('click', () => Dialog.lightbox({
        src: item.url,
        type: item.type,
        caption: `${moduleName || 'Module'} - ${index + 1} of ${media.length}`,
      }))
      wrap.appendChild(thumb)

      if (window.__canManageThisModule) {
        const removeBtn = document.createElement('button')
        removeBtn.className = 'btn small danger'
        removeBtn.textContent = 'Remove'
        removeBtn.style.display = 'block'
        removeBtn.style.marginTop = '6px'
        removeBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: 'Remove this media?',
            intro: 'It is deleted from the module page for everyone.',
            confirmLabel: 'Remove',
            danger: true,
          })
          if (!ok) return
          try {
            await apiFetch(`/api/marketplace/modules/${moduleId}/media/${encodeURIComponent(item.filename)}`, { method: 'DELETE' })
            await load()
          } catch (err) {
            showError(err.message)
          }
        })
        wrap.appendChild(removeBtn)
      }
      mediaEl.appendChild(wrap)
    })
  }

  // Staff-side warning flow, shared with the admin panel's report queue:
  // preview exactly what will be quoted, then ask for the staff note.
  async function warnAboutModule(m) {
    let preview
    try {
      preview = await apiFetch(`/api/warnings/preview?targetType=module&targetId=${encodeURIComponent(moduleId)}`)
    } catch (err) {
      await Dialog.alert({ title: 'Cannot warn about this module', intro: err.message })
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
        body: JSON.stringify({ targetType: 'module', targetId: moduleId, staffNote: values.staffNote }),
      })
      const suffix = result.applied === 'banned'
        ? ' They were automatically banned.'
        : result.applied === 'paused' ? ' Their account was automatically paused.' : ''
      showSuccess(`Warned ${preview.username} (${result.activeCount} active).${suffix}`)
    } catch (err) {
      showError(err.message)
    }
  }

  function renderActions(m, credits) {
    actionsEl.innerHTML = ''
    const statusBadge = document.createElement('span')
    statusBadge.className = `badge ${m.status}`
    statusBadge.textContent = m.status
    actionsEl.appendChild(statusBadge)

    if (m.paused) {
      const pausedBadge = document.createElement('span')
      pausedBadge.className = 'badge error'
      pausedBadge.textContent = `paused: ${m.pauseReason || 'no reason'}`
      actionsEl.appendChild(pausedBadge)
    }

    if (m.hasPendingUpdate && (m.canManage || m.canReview)) {
      const pendingBadge = document.createElement('span')
      pendingBadge.className = 'badge pending'
      pendingBadge.textContent = 'update pending review'
      actionsEl.appendChild(pendingBadge)
    }

    if (m.isDemo) {
      const demoBadge = document.createElement('span')
      demoBadge.className = 'badge demo'
      demoBadge.textContent = 'demo - source is public'
      actionsEl.appendChild(demoBadge)
    }

    if (m.isPrivate) {
      const privateBadge = document.createElement('span')
      privateBadge.className = 'badge private'
      privateBadge.textContent = 'private - hidden from the marketplace'
      actionsEl.appendChild(privateBadge)
    }

    if (m.owned) {
      const owned = document.createElement('span')
      owned.className = 'badge approved'
      owned.textContent = 'owned - load it from the Client page'
      actionsEl.appendChild(owned)
    } else if (m.status === 'approved' && !m.paused && !m.isPrivate) {
      const buyBtn = document.createElement('button')
      buyBtn.className = 'btn primary'
      buyBtn.textContent = m.price > 0 ? `Buy (${m.price} credits)` : 'Add to my modules (free)'
      buyBtn.disabled = credits < m.price
      buyBtn.addEventListener('click', async () => {
        try {
          await apiFetch(`/api/marketplace/modules/${moduleId}/buy`, { method: 'POST' })
          showSuccess(m.price > 0 ? `Bought "${m.name}".` : `Added "${m.name}".`)
          await load()
        } catch (err) {
          showError(err.message)
        }
      })
      actionsEl.appendChild(buyBtn)
    }

    // canViewSource comes from the server (routes/marketplace.js), which is
    // the only thing that actually gates the endpoint - demo modules are
    // readable by everyone, so this is no longer an owner/staff-only button.
    if (m.canViewSource) {
      const viewBtn = document.createElement('button')
      viewBtn.className = m.isDemo ? 'btn primary' : 'btn'
      viewBtn.textContent = m.isDemo ? 'Read source' : 'View source'
      viewBtn.addEventListener('click', () => viewSource(`/api/marketplace/modules/${moduleId}/source`, 'Module source (live version)'))
      actionsEl.appendChild(viewBtn)
    }

    // The owner's management tools sit behind this, right next to View
    // source - the two things you come to your own module's page to do.
    if (m.canManage) {
      const updateBtn = document.createElement('button')
      updateBtn.className = 'btn'
      updateBtn.textContent = 'Update'
      updateBtn.title = 'Submit a new version, manage media, and set visibility'
      updateBtn.addEventListener('click', () => openManageDialog(m))
      actionsEl.appendChild(updateBtn)
    }

    // Filing a bug comes before reporting the module: it's the far more
    // common thing to want, and reporting is the escalation.
    if (m.owned || m.isOwner) {
      const bugBtn = document.createElement('button')
      bugBtn.className = 'btn small'
      bugBtn.textContent = 'Report a bug'
      bugBtn.addEventListener('click', () => openBugReportDialog(m))
      actionsEl.appendChild(bugBtn)
    }

    const reportBtn = document.createElement('button')
    reportBtn.className = 'btn small'
    reportBtn.textContent = 'Report module'
    reportBtn.addEventListener('click', async () => {
      const values = await Dialog.form({
        title: `Report "${m.name}"`,
        intro: 'Reports go to staff, not to the module\'s author. Use this for policy, abuse, or security concerns - for a straightforward bug, file a bug report instead.',
        confirmLabel: 'Send report',
        danger: true,
        fields: [{
          name: 'reason',
          label: 'What is the concern?',
          type: 'textarea',
          rows: 4,
          required: true,
          minLength: 3,
          maxLength: 1000,
          placeholder: 'Be specific - what does the module do, and why is it a problem?',
        }],
      })
      if (!values) return
      try {
        await apiFetch(`/api/marketplace/modules/${moduleId}/report`, { method: 'POST', body: JSON.stringify({ reason: values.reason }) })
        await Dialog.alert({
          title: 'Report sent',
          intro: 'Staff will review it. You will not get a reply directly, but action shows up on the module itself.',
          tone: null,
          confirmLabel: 'Close',
        })
      } catch (err) {
        showError(err.message)
      }
    })
    actionsEl.appendChild(reportBtn)

    // Staff can warn the uploader straight from the module page - the same
    // flow the admin panel's report queue uses.
    if (isModOrAdmin && !m.isOwner) {
      const warnBtn = document.createElement('button')
      warnBtn.className = 'btn small danger'
      warnBtn.textContent = 'Warn uploader'
      warnBtn.addEventListener('click', () => warnAboutModule(m))
      actionsEl.appendChild(warnBtn)
    }
  }

  function renderAtRiskBanner(m) {
    if (m.atRisk) {
      atRiskBanner.textContent = `At risk: ${m.atRiskReason || 'flagged by the owner or an admin - use with caution.'}`
      atRiskBanner.classList.remove('hidden')
    } else {
      atRiskBanner.classList.add('hidden')
    }
  }

  // Owner-side visibility switch. Going private keeps every existing buyer's
  // access intact - it only removes the listing and blocks new purchases.
  function renderVisibilityControls(m) {
    visibilityControls.innerHTML = ''
    if (m.isDemo) {
      visibilityControls.innerHTML = '<p class="row-sub">Demo modules are always public.</p>'
      return
    }

    const status = document.createElement('p')
    status.className = 'row-sub'
    status.textContent = m.isPrivate
      ? 'Private: hidden from the marketplace browse list and search, and nobody new can buy it. Everyone who already owns it keeps it.'
      : 'Public: listed in the marketplace and available to buy.'
    visibilityControls.appendChild(status)

    const btn = document.createElement('button')
    btn.className = m.isPrivate ? 'btn small primary' : 'btn small'
    btn.textContent = m.isPrivate ? 'Make public' : 'Make private'
    btn.style.marginTop = '8px'
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/marketplace/modules/${moduleId}/private`, {
          method: 'POST',
          body: JSON.stringify({ isPrivate: !m.isPrivate }),
        })
        showSuccess(m.isPrivate ? 'Module is listed again.' : 'Module is now private.')
        await load()
      } catch (err) {
        showError(err.message)
      }
    })
    visibilityControls.appendChild(btn)
  }

  function renderAtRiskControls(container, m) {
    container.innerHTML = ''
    const status = document.createElement('p')
    status.className = 'row-sub'
    status.textContent = m.atRisk ? `Currently flagged at risk: ${m.atRiskReason || 'no reason given'}` : 'Not currently flagged.'
    container.appendChild(status)

    const btn = document.createElement('button')
    btn.className = m.atRisk ? 'btn small' : 'btn small danger'
    btn.textContent = m.atRisk ? 'Clear at-risk flag' : 'Flag as at risk'
    btn.addEventListener('click', async () => {
      let reason = ''
      if (!m.atRisk) {
        const values = await Dialog.form({
          title: `Flag "${m.name}" as at risk`,
          intro: 'A prominent warning is shown to everyone who views this module, and to anyone who already owns it. Use this for a known security or abuse concern, not routine bugs.',
          confirmLabel: 'Flag as at risk',
          danger: true,
          fields: [{
            name: 'reason',
            label: 'Describe the risk',
            type: 'textarea',
            rows: 3,
            required: true,
            maxLength: 500,
            placeholder: 'Shown verbatim to everyone viewing this module.',
          }],
        })
        if (!values) return
        reason = values.reason
      } else {
        const ok = await Dialog.confirm({
          title: 'Clear the at-risk flag?',
          intro: 'The warning stops being shown on this module.',
          confirmLabel: 'Clear flag',
        })
        if (!ok) return
      }
      try {
        await apiFetch(`/api/marketplace/modules/${moduleId}/at-risk`, {
          method: 'POST',
          body: JSON.stringify({ atRisk: !m.atRisk, reason }),
        })
        await load()
      } catch (err) {
        showError(err.message)
      }
    })
    container.appendChild(btn)
  }

  function renderChangelog(changelog) {
    const entries = changelog || []
    // Newest first, which is what a reader wants, but the "current version"
    // test still has to use the original index: the live version is always
    // whichever entry was appended most recently (every update and revert
    // appends one), not "any entry whose version string matches" - a version
    // can recur after a revert back to v1.0.0.
    const lastIndex = entries.length - 1
    const ordered = entries.map((entry, index) => ({ entry, index })).reverse()

    Paginate.render({
      container: changelogEl,
      pager: changelogPager,
      items: ordered,
      pageSize: PAGE_SIZES.changelog,
      noun: 'version',
      emptyText: 'No updates yet.',
      renderItem: ({ entry, index }) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        const isCurrent = index === lastIndex
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">v${escapeHtml(entry.version)}${isCurrent ? ' <span class="badge approved">current</span>' : ''}</div>
            <div class="row-sub">${new Date(entry.approvedAt).toLocaleString()}${entry.notes ? ` &middot; ${escapeHtml(entry.notes)}` : ''}</div>
          </div>
        `
        if (isAdmin && !isCurrent && entry.filePath) {
          const revertBtn = document.createElement('button')
          revertBtn.className = 'btn small danger'
          revertBtn.textContent = 'Revert to this version'
          revertBtn.addEventListener('click', async () => {
            const ok = await Dialog.confirm({
              title: `Revert to v${entry.version}?`,
              intro: 'The live module goes back to this version for everyone who has it. Recorded in the changelog and the audit log.',
              confirmLabel: 'Revert',
              danger: true,
            })
            if (!ok) return
            try {
              await apiFetch(`/api/marketplace/modules/${moduleId}/revert`, { method: 'POST', body: JSON.stringify({ changelogIndex: index }) })
              showSuccess(`Reverted to v${entry.version}.`)
              await load()
            } catch (err) {
              showError(err.message)
            }
          })
          row.appendChild(revertBtn)
        }
        return row
      },
    })
  }

  function renderReviews(m, reviews, myReview, canReview) {
    ratingSummaryEl.textContent = m.reviewCount
      ? `- ${m.avgRating.toFixed(1)} / 5 avg (${m.reviewCount} review${m.reviewCount === 1 ? '' : 's'})`
      : '- no reviews yet'

    Paginate.render({
      container: reviewsEl,
      pager: reviewsPager,
      items: reviews,
      pageSize: PAGE_SIZES.reviews,
      noun: 'review',
      emptyText: 'No reviews yet.',
      renderItem: (r) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        const mine = myReview && r.id === myReview.id
        const edited = r.updatedAt && r.updatedAt !== r.createdAt
          ? ` &middot; edited ${new Date(r.updatedAt).toLocaleDateString()}`
          : ''
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} <span class="row-sub">by ${escapeHtml(r.authorUsername)}${mine ? ' (you)' : ''} &middot; ${new Date(r.createdAt).toLocaleString()}${edited}</span></div>
            ${r.body ? `<div class="row-sub" style="white-space:pre-wrap;">${escapeHtml(r.body)}</div>` : ''}
          </div>
        `
        // Your own review is edited in place from here - the write form
        // below is gone once you've left one.
        if (mine) {
          const editBtn = document.createElement('button')
          editBtn.className = 'btn small'
          editBtn.type = 'button'
          editBtn.textContent = 'Edit your review'
          editBtn.addEventListener('click', () => openReviewDialog(m, myReview))
          row.appendChild(editBtn)
        }
        return row
      },
    })

    // Once a review exists the standing "Submit review" form is removed
    // entirely: there is only ever one review per person, so leaving an
    // empty write form on the page implies you can add a second.
    reviewForm.classList.add('hidden')
    reviewActions.innerHTML = ''

    if (!canReview) {
      reviewGateNote.textContent = 'Buy this module to leave a review.'
      return
    }

    reviewGateNote.textContent = ''
    const btn = document.createElement('button')
    btn.className = myReview ? 'btn small' : 'btn primary'
    btn.type = 'button'
    btn.textContent = myReview ? 'Edit your review' : 'Write a review'
    btn.addEventListener('click', () => openReviewDialog(m, myReview))
    reviewActions.appendChild(btn)
  }

  // One dialog for both writing and editing - the endpoint upserts, so the
  // only difference is the wording and whether the fields start filled.
  async function openReviewDialog(m, myReview) {
    const values = await Dialog.form({
      title: myReview ? `Edit your review of "${m.name}"` : `Review "${m.name}"`,
      intro: myReview
        ? 'Your review is replaced with whatever you save here.'
        : 'You can edit this later. Only one review per person counts toward the average.',
      confirmLabel: myReview ? 'Save changes' : 'Post review',
      fields: [
        {
          name: 'rating',
          label: 'Rating',
          type: 'select',
          value: String(myReview ? myReview.rating : 5),
          options: [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${'★'.repeat(n)}${'☆'.repeat(5 - n)}  (${n}/5)` })),
        },
        {
          name: 'body',
          label: 'Review',
          type: 'textarea',
          rows: 5,
          maxLength: 1000,
          value: myReview ? myReview.body || '' : '',
          placeholder: 'What does it do well? What would you change?',
          hint: 'Optional - a rating on its own is fine.',
        },
      ],
    })
    if (!values) return

    try {
      await apiFetch(`/api/marketplace/modules/${moduleId}/reviews`, {
        method: 'POST',
        body: JSON.stringify({ rating: parseInt(values.rating, 10), body: values.body }),
      })
      showSuccess(myReview ? 'Review updated.' : 'Thanks for the review.')
      await load()
    } catch (err) {
      showError(err.message)
    }
  }

  function renderComments(comments, canComment) {
    Paginate.render({
      container: commentsEl,
      pager: commentsPager,
      items: comments,
      pageSize: PAGE_SIZES.comments,
      noun: 'comment',
      emptyText: 'No comments yet.',
      renderItem: (c) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        const avatar = c.authorAvatarUrl ? `<img class="avatar" src="${escapeHtml(c.authorAvatarUrl)}" alt="" width="24" height="24" style="margin-right:6px;vertical-align:middle;" />` : ''
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">${avatar}${escapeHtml(c.authorUsername)} <span class="row-sub">${new Date(c.createdAt).toLocaleString()}</span></div>
            <div class="row-sub" style="white-space:pre-wrap;">${escapeHtml(c.body)}</div>
          </div>
        `
        if (isModOrAdmin) {
          const deleteBtn = document.createElement('button')
          deleteBtn.className = 'btn small danger'
          deleteBtn.textContent = 'Delete'
          deleteBtn.addEventListener('click', async () => {
            const ok = await Dialog.confirm({
              title: 'Delete this comment?',
              intro: `Posted by ${c.authorUsername}. This cannot be undone.`,
              quote: c.body,
              confirmLabel: 'Delete',
              danger: true,
            })
            if (!ok) return
            try {
              await apiFetch(`/api/marketplace/modules/${moduleId}/comments/${c.id}`, { method: 'DELETE' })
              await load()
            } catch (err) {
              showError(err.message)
            }
          })
          row.appendChild(deleteBtn)
        }
        return row
      },
    })
    commentForm.classList.toggle('hidden', !canComment)
  }

  function renderBugReports(m, reports, canFile) {
    // The whole panel is for people who actually have the module: owners,
    // purchasers, and staff triaging it. Anyone still deciding whether to buy
    // shouldn't have to scroll past someone else's bug queue.
    const bugReportsCard = document.getElementById('bug-reports-card')
    const visible = m.owned || m.isOwner || isModOrAdmin
    if (bugReportsCard) bugReportsCard.classList.toggle('hidden', !visible)
    if (!visible) return

    const canResolve = m.isOwner || isModOrAdmin
    Paginate.render({
      container: bugReportsEl,
      pager: bugReportsPager,
      items: reports,
      pageSize: PAGE_SIZES.bugReports,
      noun: 'report',
      emptyText: 'No bug reports.',
      renderItem: (r) => {
        const row = document.createElement('div')
        row.className = 'data-row'
        row.innerHTML = `
          <div class="row-main">
            <div class="row-title">${escapeHtml(r.title)} <span class="badge ${r.status === 'open' ? 'pending' : 'approved'}">${r.status}</span></div>
            <div class="row-sub">by ${escapeHtml(r.reporterUsername)} &middot; ${new Date(r.createdAt).toLocaleString()}</div>
            <div class="row-sub" style="white-space:pre-wrap;">${escapeHtml(r.body)}</div>
          </div>
        `
        if (canResolve) {
          const toggleBtn = document.createElement('button')
          toggleBtn.className = 'btn small'
          toggleBtn.textContent = r.status === 'open' ? 'Mark resolved' : 'Reopen'
          toggleBtn.addEventListener('click', async () => {
            try {
              await apiFetch(`/api/marketplace/modules/${moduleId}/bug-reports/${r.id}/resolve`, {
                method: 'POST',
                body: JSON.stringify({ status: r.status === 'open' ? 'resolved' : 'open' }),
              })
              await load()
            } catch (err) {
              showError(err.message)
            }
          })
          row.appendChild(toggleBtn)
        }
        return row
      },
    })
  }

  // Filing a bug is a separate action from reading the queue, so it lives in
  // a dialog off the actions row rather than as a form permanently parked
  // under the list.
  async function openBugReportDialog(m) {
    const values = await Dialog.form({
      title: `Report a bug in "${m.name}"`,
      intro: 'Goes to the module\'s author and to staff. For a policy or security concern, use "Report module" instead.',
      confirmLabel: 'Submit bug report',
      fields: [
        {
          name: 'title',
          label: 'What went wrong?',
          type: 'text',
          required: true,
          minLength: 3,
          maxLength: 120,
          placeholder: 'e.g. Crashes on load when the bot has a full inventory',
          hint: 'One line summarising the problem - this is the report\'s title.',
        },
        {
          name: 'body',
          label: 'Steps to reproduce and what you expected',
          type: 'textarea',
          rows: 6,
          required: true,
          maxLength: 2000,
          placeholder: '1. Load the module onto an online bot\n2. ...\n\nExpected: ...\nActually happened: ...',
          hint: 'Include the server/version and anything from the connection\'s error log that looks relevant.',
        },
      ],
    })
    if (!values) return

    try {
      await apiFetch(`/api/marketplace/modules/${moduleId}/bug-reports`, {
        method: 'POST',
        body: JSON.stringify({ title: values.title, body: values.body }),
      })
      showSuccess('Bug report filed.')
      await load()
    } catch (err) {
      showError(err.message)
    }
  }

  function renderTransactions(transactions, totalEarned) {
    if (!transactions) {
      transactionsCard.classList.add('hidden')
      return
    }
    transactionsCard.classList.remove('hidden')
    earningsSummaryEl.textContent = `Total earned from this module: ${totalEarned} credits (${transactions.length} sale${transactions.length === 1 ? '' : 's'}).`
    transactionsEl.innerHTML = ''
    if (transactions.length === 0) {
      transactionsEl.innerHTML = '<div class="empty-note">No purchases yet.</div>'
      return
    }
    transactions.forEach((t) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">${escapeHtml(t.buyerUsername)} &middot; ${t.price} credits (payout ${t.sellerPayout})</div>
          <div class="row-sub">${new Date(t.purchasedAt).toLocaleString()}</div>
        </div>
      `
      transactionsEl.appendChild(row)
    })
  }

  function renderManage(m) {
    window.__canManageThisModule = m.canManage
    // The card itself stays hidden on the page now - it's opened as a dialog
    // from the Update button next to View source (see openManageDialog).
    manageCard.classList.add('hidden')
    if (m.canManage) {
      renderAtRiskControls(atRiskControls, m)
      renderVisibilityControls(m)
    }
  }

  // Owner tools, shown as a popup.
  //
  // The card is *moved* into the modal rather than rebuilt inside it. Two of
  // its forms post real files (module update, media upload), and the existing
  // submit handlers are already bound to those exact elements - cloning would
  // silently drop both the handlers and the selected files.
  const manageHome = manageCard.parentNode
  const manageAnchor = document.createComment('manage-card')
  manageHome.insertBefore(manageAnchor, manageCard)

  function openManageDialog(m) {
    const overlay = document.createElement('div')
    overlay.className = 'modal'

    const box = document.createElement('div')
    box.className = 'modal-box wide manage-dialog'

    const heading = document.createElement('h2')
    heading.textContent = `Manage "${m.name}"`
    box.appendChild(heading)

    manageCard.classList.remove('hidden')
    box.appendChild(manageCard)

    // Start the editor from the version that is live right now.
    loadCurrentSourceIntoEditor()

    const actions = document.createElement('div')
    actions.className = 'modal-actions'
    const doneBtn = document.createElement('button')
    doneBtn.type = 'button'
    doneBtn.className = 'btn primary'
    doneBtn.textContent = 'Done'
    actions.appendChild(doneBtn)
    box.appendChild(actions)

    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const close = () => {
      document.removeEventListener('keydown', onKey)
      Dialog.clearPanelError(manageCard)
      // Put the card back where it came from before the overlay goes, or the
      // next open would have nothing to move.
      manageCard.classList.add('hidden')
      manageHome.insertBefore(manageCard, manageAnchor)
      overlay.remove()
      delete manageCard.__dialogClose
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }

    // Submitting is not the same as succeeding: the update and media forms
    // close this themselves via Dialog.closePanel once the request actually
    // worked, and report failures inline via Dialog.panelError instead (see
    // submitManageForm). Closing on submit would have discarded the version,
    // the notes, and the selected file every time a file was rejected.
    manageCard.__dialogClose = close

    document.addEventListener('keydown', onKey)
    doneBtn.addEventListener('click', close)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close() })
  }

  function renderModeration(m, updates) {
    if (!updates) {
      moderationCard.classList.add('hidden')
      return
    }
    moderationCard.classList.remove('hidden')
    // The owner also gets this card (canReviewModule includes ownership) so
    // they can see their own submissions' review status - "Moderation" only
    // makes sense as a heading for an actual mod/admin.
    moderationCard.querySelector('h2').textContent = isModOrAdmin ? 'Moderation' : 'Your update submissions'
    if (isAdmin) renderAtRiskControls(adminAtRiskControls, m)

    updateList.innerHTML = ''
    const pending = updates.filter((u) => u.status === 'pending')
    const reviewed = updates.filter((u) => u.status !== 'pending')
    if (pending.length === 0 && reviewed.length === 0) {
      updateList.innerHTML = '<div class="empty-note">No update submissions yet.</div>'
      return
    }
    ;[...pending, ...reviewed].forEach((u) => {
      const row = document.createElement('div')
      row.className = 'data-row'
      row.innerHTML = `
        <div class="row-main">
          <div class="row-title">v${escapeHtml(u.version)} <span class="badge ${u.status}">${u.status}</span></div>
          <div class="row-sub">by ${escapeHtml(u.submittedByUsername)} &middot; ${new Date(u.createdAt).toLocaleString()}${u.changelogNotes ? ` &middot; ${escapeHtml(u.changelogNotes)}` : ''}${u.rejectionReason ? ` &middot; rejected: ${escapeHtml(u.rejectionReason)}` : ''}</div>
        </div>
      `
      if (u.status === 'pending') {
        const sourceBtn = document.createElement('button')
        sourceBtn.className = 'btn small'
        sourceBtn.textContent = 'View source'
        sourceBtn.addEventListener('click', () => viewSource(`/api/marketplace/modules/${moduleId}/updates/${u.id}/source`, `Pending update v${u.version} source`))
        row.appendChild(sourceBtn)

        const diffBtn = document.createElement('button')
        diffBtn.className = 'btn small'
        diffBtn.textContent = 'View diff'
        diffBtn.addEventListener('click', () => viewDiff(u.id))
        row.appendChild(diffBtn)

        if (isModOrAdmin) {
          const approveBtn = document.createElement('button')
          approveBtn.className = 'btn small primary'
          approveBtn.textContent = 'Approve'
          approveBtn.addEventListener('click', async () => {
            try {
              await apiFetch(`/api/marketplace/modules/${moduleId}/updates/${u.id}/approve`, { method: 'POST' })
              showSuccess(`Update v${u.version} approved and now live.`)
              await load()
            } catch (err) {
              showError(err.message)
            }
          })
          row.appendChild(approveBtn)

          const rejectBtn = document.createElement('button')
          rejectBtn.className = 'btn small danger'
          rejectBtn.textContent = 'Reject'
          rejectBtn.addEventListener('click', async () => {
            const values = await Dialog.form({
              title: `Reject update v${u.version}`,
              intro: `Submitted by ${u.submittedByUsername}. The live module stays on its current version.`,
              confirmLabel: 'Reject update',
              danger: true,
              fields: [{
                name: 'reason',
                label: 'Reason',
                type: 'textarea',
                rows: 3,
                maxLength: 500,
                placeholder: 'What needs to change before this can be approved?',
                hint: 'Optional, but a rejection without one is hard to act on.',
              }],
            })
            if (!values) return
            try {
              await apiFetch(`/api/marketplace/modules/${moduleId}/updates/${u.id}/reject`, {
                method: 'POST',
                body: JSON.stringify({ reason: values.reason }),
              })
              await load()
            } catch (err) {
              showError(err.message)
            }
          })
          row.appendChild(rejectBtn)
        }
      }
      updateList.appendChild(row)
    })
  }

  async function load() {
    try {
      const data = await apiFetch(`/api/marketplace/modules/${moduleId}`)
      const m = data.module
      titleEl.textContent = m.name
      metaEl.textContent = `by ${m.ownerUsername} · v${m.version} · created ${new Date(m.createdAt).toLocaleDateString()} · updated ${new Date(m.updatedAt).toLocaleDateString()} · ${m.usersCount} user${m.usersCount === 1 ? '' : 's'}`
      descriptionEl.textContent = m.description || 'No description.'
      renderAtRiskBanner(m)
      renderMedia(m.media, m.name)
      const { credits } = await apiFetch('/api/marketplace/modules').then((d) => ({ credits: d.credits })).catch(() => ({ credits: 0 }))
      renderActions(m, credits)
      renderChangelog(m.changelog)
      const canReviewAsBuyer = m.owned || m.isOwner
      renderReviews(m, data.reviews, data.myReview, canReviewAsBuyer)
      renderComments(data.comments, canReviewAsBuyer)
      renderBugReports(m, data.bugReports, canReviewAsBuyer)
      renderTransactions(data.transactions, data.totalEarned)
      renderManage(m)
      renderModeration(m, data.updates)

      if (isAdmin && deleteModuleBtn && !deleteModuleBtn.dataset.wired) {
        deleteModuleBtn.dataset.wired = '1'
        deleteModuleBtn.addEventListener('click', async () => {
          const ok = await Dialog.confirm({
            title: `Permanently remove "${m.name}"?`,
            intro: 'The module, its source files, its media, and its entire history are deleted for everyone who owns it. This cannot be undone.',
            confirmLabel: 'Remove permanently',
            danger: true,
            tone: 'error',
          })
          if (!ok) return
          try {
            await apiFetch(`/api/marketplace/modules/${moduleId}`, { method: 'DELETE' })
            window.location.href = '/marketplace'
          } catch (err) {
            showError(err.message)
          }
        })
      }
    } catch (err) {
      showError(err.message)
    }
  }

  // Both of these live inside the Manage dialog, so a rejection has to be
  // reported in there - closing the dialog to show the error somewhere behind
  // it would throw away the version, the notes, and the code.
  //
  // `json` posts the form as JSON (module source is typed into the page, not
  // uploaded); without it the form still posts multipart, which is what the
  // media upload needs.
  async function submitManageForm(formEl, { url, failureTitle, successMessage, json = false }) {
    Dialog.clearPanelError(manageCard)
    const submitBtn = formEl.querySelector('button[type=submit]')
    if (submitBtn) submitBtn.disabled = true
    try {
      const formData = new FormData(formEl)
      const res = await fetch(url, json
        ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.fromEntries(formData.entries())),
        }
        : { method: 'POST', body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(data.error || failureTitle)
        // The server returns every reason a module file was rejected (see
        // src/moduleValidator.js), not just the first.
        err.problems = data.problems
        throw err
      }
      formEl.reset()
      Dialog.closePanel(manageCard)
      showSuccess(successMessage)
      await load()
    } catch (err) {
      Dialog.panelError(manageCard, err.message, err.problems)
    } finally {
      if (submitBtn) submitBtn.disabled = false
    }
  }

  mediaForm.addEventListener('submit', (e) => {
    e.preventDefault()
    submitManageForm(mediaForm, {
      url: `/api/marketplace/modules/${moduleId}/media`,
      failureTitle: 'Upload failed.',
      successMessage: 'Media uploaded.',
    })
  })

  updateForm.addEventListener('submit', (e) => {
    e.preventDefault()
    submitManageForm(updateForm, {
      url: `/api/marketplace/modules/${moduleId}/updates`,
      failureTitle: 'Submission failed.',
      successMessage: 'Update submitted for review.',
      json: true,
    })
  })

  // Seeds the update box with whatever is live right now, so an update starts
  // from the current code rather than a blank field. Only fetched when the
  // owner opens Manage - the endpoint is owner/staff-gated anyway.
  const updateSource = document.getElementById('update-source')

  async function loadCurrentSourceIntoEditor({ force = false } = {}) {
    if (!updateSource) return
    if (!force && updateSource.value.trim() !== '') return
    try {
      const { source } = await apiFetch(`/api/marketplace/modules/${moduleId}/source`)
      updateSource.value = source
    } catch {
      // Falls back to the starter template so the box is never just empty.
      updateSource.value = window.MODULE_TEMPLATE || ''
    }
    updateSource.dispatchEvent(new Event('input', { bubbles: true }))
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-reload-source]')) loadCurrentSourceIntoEditor({ force: true })
  })

  commentForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const body = new FormData(commentForm).get('body')
    try {
      await apiFetch(`/api/marketplace/modules/${moduleId}/comments`, { method: 'POST', body: JSON.stringify({ body }) })
      commentForm.reset()
      await load()
    } catch (err) {
      showError(err.message)
    }
  })

  load()
})()
