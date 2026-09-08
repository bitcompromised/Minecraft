(() => {
  const tabLogin = document.getElementById('tab-login')
  const tabRegister = document.getElementById('tab-register')
  const loginForm = document.getElementById('login-form')
  const registerForm = document.getElementById('register-form')
  const errorBox = document.getElementById('auth-error')
  const inviteInput = document.getElementById('register-invite')

  const params = new URLSearchParams(location.search)
  const inviteFromUrl = params.get('invite')
  if (inviteFromUrl) {
    inviteInput.value = inviteFromUrl
    showRegister()
  }
  // The landing page's "Create an account" buttons link to /login#register,
  // so the register tab is already open when someone arrives from there.
  if (location.hash === '#register') showRegister()
  const errorFromUrl = params.get('error')
  if (errorFromUrl) {
    showError(errorFromUrl)
  }

  // Site-wide maintenance/announcement banner + registration-closed check
  // (admin-configurable, see the Admin page's Website settings card).
  fetch('/api/public-settings').then((r) => r.json()).then((settings) => {
    if (settings.maintenanceMode && settings.maintenanceMessage) {
      const banner = document.createElement('p')
      banner.className = 'error'
      banner.textContent = `Maintenance mode: ${settings.maintenanceMessage}`
      document.querySelector('.auth-card').insertBefore(banner, document.querySelector('.tabs'))
    }
  }).catch(() => {
    // non-critical - a failed fetch just means no banner, not a broken page
  })

  function showError(message) {
    errorBox.textContent = message
    errorBox.classList.remove('hidden')
  }

  function clearError() {
    errorBox.classList.add('hidden')
  }

  function showLogin() {
    tabLogin.classList.add('active')
    tabRegister.classList.remove('active')
    loginForm.classList.remove('hidden')
    registerForm.classList.add('hidden')
    clearError()
  }

  function showRegister() {
    tabRegister.classList.add('active')
    tabLogin.classList.remove('active')
    registerForm.classList.remove('hidden')
    loginForm.classList.add('hidden')
    clearError()
  }

  tabLogin.addEventListener('click', showLogin)
  tabRegister.addEventListener('click', showRegister)

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Something went wrong.')
    return data
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()
    try {
      await postJson('/api/auth/login', {
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      })
      location.href = '/'
    } catch (err) {
      showError(err.message)
    }
  })

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()
    const password = document.getElementById('register-password').value
    const confirm = document.getElementById('register-confirm').value
    if (password !== confirm) {
      showError('Passwords do not match.')
      return
    }
    try {
      await postJson('/api/auth/register', {
        username: document.getElementById('register-username').value,
        password,
        inviteCode: inviteInput.value,
      })
      location.href = '/'
    } catch (err) {
      showError(err.message)
    }
  })
})()
