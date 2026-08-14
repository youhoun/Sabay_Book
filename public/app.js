// Shared helpers used by every page.

const api = {
  async get(url) {
    const r = await fetch(url);
    return { ok: r.ok, status: r.status, data: await r.json() };
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: r.ok, status: r.status, data: await r.json() };
  },
  post(url, body) { return this.send('POST', url, body); },
  put(url, body) { return this.send('PUT', url, body); },
  del(url) { return this.send('DELETE', url); },
};

let CURRENT_USER = null;

async function initAuth() {
  const { data } = await api.get('/api/auth/me');
  CURRENT_USER = data.user;
  renderTopbar();
  return CURRENT_USER;
}

function renderTopbar() {
  const el = document.getElementById('nav-auth');
  if (!el) return;
  if (CURRENT_USER) {
    el.innerHTML = `
      <a href="/lectures.html" class="pill">Lectures</a>
      <a href="/mybooks.html" class="pill">My Books</a>
      ${CURRENT_USER.role === 'admin' ? '<a href="/admin.html" class="pill">Admin</a>' : ''}
      <span class="muted" style="color:inherit;opacity:.85">${escapeHtml(CURRENT_USER.name)}</span>
      <button class="btn btn-outline btn-sm" id="logout-btn" style="border-color:rgba(250,246,236,.4);color:inherit">Log out</button>
    `;
    document.getElementById('logout-btn').onclick = async () => {
      await api.post('/api/auth/logout');
      location.href = '/';
    };
  } else {
    el.innerHTML = `<a href="/lectures.html" class="pill">Lectures</a><button class="btn btn-primary btn-sm" id="login-open-btn">Log in</button>`;
    document.getElementById('login-open-btn').onclick = openLoginModal;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(amount) {
  return amount === 0 ? 'Free' : `$${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Real OAuth login. The browser never accepts a name/email/admin flag.
// The server creates the account only after Google/Facebook verifies identity.
// ---------------------------------------------------------------------------
async function injectLoginModal() {
  if (document.getElementById('login-overlay')) return;
  const providers = await api.get('/api/auth/providers');
  const div = document.createElement('div');
  const buttons = [];
  if (providers.data.google) buttons.push(`<a class="btn btn-dark oauth-btn" href="/auth/google/start">Continue with Google</a>`);
  if (providers.data.facebook) buttons.push(`<a class="btn btn-dark oauth-btn" href="/auth/facebook/start">Continue with Facebook</a>`);
  div.innerHTML = `
    <div class="overlay" id="login-overlay">
      <div class="modal">
        <h2>Welcome to Sabai Books</h2>
        <p class="sub">Sign in securely with your account. Sabai Books never asks you to type a fake identity.</p>
        ${buttons.length ? buttons.join('') : '<p class="empty">No real login provider is configured yet. Set the OAuth environment variables on the server.</p>'}
        <button class="btn btn-outline btn-block" id="login-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(div);
  document.getElementById('login-cancel').onclick = closeLoginModal;
  document.getElementById('login-overlay').onclick = (e) => { if (e.target.id === 'login-overlay') closeLoginModal(); };
}

function openLoginModal() {
  injectLoginModal().then(() => document.getElementById('login-overlay')?.classList.add('open'));
}
function closeLoginModal() {
  const el = document.getElementById('login-overlay');
  if (el) el.classList.remove('open');
}

// Note: each page calls `await initAuth()` itself before rendering,
// so CURRENT_USER is guaranteed to be set before page-specific code runs.
