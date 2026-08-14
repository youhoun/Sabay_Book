// Sabai Books — server.js
// Zero-dependency Node.js server (built-ins only: http, fs, crypto, path, url).
// Run with: node server.js   (Node 16+, no npm install needed)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const https = require('https');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Real OAuth / PayWay configuration comes from environment variables.
// Never put these secrets in public JS files or commit them to Git.
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const ADMIN_EMAILS = new Set((process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `${APP_BASE_URL}/auth/google/callback`;
const FACEBOOK_CLIENT_ID = process.env.FACEBOOK_CLIENT_ID || '';
const FACEBOOK_CLIENT_SECRET = process.env.FACEBOOK_CLIENT_SECRET || '';
const FACEBOOK_REDIRECT_URI = process.env.FACEBOOK_REDIRECT_URI || `${APP_BASE_URL}/auth/facebook/callback`;
const PAYWAY_MERCHANT_ID = process.env.PAYWAY_MERCHANT_ID || '';
const PAYWAY_API_KEY = process.env.PAYWAY_API_KEY || '';
const PAYWAY_SANDBOX = process.env.PAYWAY_SANDBOX !== 'false';
const PAYWAY_BASE_URL = PAYWAY_SANDBOX ? 'https://checkout-sandbox.payway.com.kh' : 'https://checkout.payway.com.kh';
const PAYWAY_RETURN_URL = process.env.PAYWAY_RETURN_URL || `${APP_BASE_URL}/payway/return`;
const PAYWAY_CALLBACK_URL = process.env.PAYWAY_CALLBACK_URL || '';
const oauthStates = new Map();

// ---------------------------------------------------------------------------
// Tiny JSON "database". Loaded into memory, saved to disk after every write.
// Swap this whole block for a real DB (Postgres/SQLite) when you outgrow it —
// every place that touches `db` is isolated to the functions below.
// ---------------------------------------------------------------------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = require('./seed.js');
    fs.writeFileSync(DB_FILE, JSON.stringify(seed(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
let db = loadDB();
function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------------------------------------------------------------------------
// Sessions — in-memory map of sessionId -> userId. Good enough for a
// prototype; restarting the server logs everyone out. Swap for
// express-session + a store (Redis/DB) in production.
// ---------------------------------------------------------------------------
// Sessions are persisted in data.json so a login survives server restarts.
// Each session is still represented by an HttpOnly cookie in the browser.
if (!Array.isArray(db.sessions)) db.sessions = [];
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header.split(';').filter(Boolean).map(c => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    })
  );
}

function getCurrentUser(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return null;

  const now = Date.now();
  // Remove expired sessions while looking up the current one.
  db.sessions = db.sessions.filter(s => Number(s.expiresAt) > now);
  const session = db.sessions.find(s => s.id === sid);
  if (!session) return null;

  return db.users.find(u => u.id === session.userId) || null;
}

function createSession(res, userId) {
  const sid = crypto.randomUUID();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  db.sessions.push({ id: sid, userId, createdAt: new Date().toISOString(), expiresAt });
  save();

  // Explicit cookie attributes make the OAuth redirect/session reliable on
  // localhost. HttpOnly prevents frontend JS from reading the session token.
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function destroySession(req, res) {
  const cookies = parseCookies(req);
  if (cookies.sid) {
    db.sessions = db.sessions.filter(s => s.id !== cookies.sid);
    save();
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => (chunks += c));
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function publicUser(u) {
  if (!u) return null;
  const { id, name, email, provider, role, createdAt } = u;
  return { id, name, email, provider, role, createdAt };
}

function publicBook(b, { includeContent = false } = {}) {
  const { content, ...rest } = b;
  return includeContent ? b : rest;
}

function ownsBook(userId, bookId) {
  // Both free and paid books use a purchase record — free ones are just
  // instantly "checked out" for $0 in POST /api/orders. Keeps My Books,
  // ownership checks, and progress tracking on one consistent code path.
  return db.purchases.some(p => p.userId === userId && p.bookId === bookId);
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) { sendJSON(res, 401, { error: 'Not logged in' }); return null; }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') { sendJSON(res, 403, { error: 'Admin only' }); return null; }
  return user;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA-ish fallback: unknown page -> 404 page (or index)
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------
function randomState() {
  return crypto.randomBytes(24).toString('hex');
}

function rememberOAuthState(state, provider) {
  oauthStates.set(state, { provider, createdAt: Date.now() });
  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000).unref();
}

function consumeOAuthState(state, provider) {
  const item = oauthStates.get(state);
  oauthStates.delete(state);
  if (!item || item.provider !== provider || Date.now() - item.createdAt > 10 * 60 * 1000) return false;
  return true;
}

function httpRequest(method, target, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method,
      headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function upsertOAuthUser({ provider, id, name, email }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('The provider did not return an email address.');
  let user = db.users.find(u => u.email.toLowerCase() === normalizedEmail);
  const role = ADMIN_EMAILS.has(normalizedEmail) ? 'admin' : (user ? user.role : 'user');
  if (!user) {
    user = {
      id: crypto.randomUUID(), name: name || normalizedEmail.split('@')[0],
      email: normalizedEmail, provider, role, providerId: id || null,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
  } else {
    user.name = name || user.name;
    user.provider = provider;
    user.providerId = id || user.providerId || null;
    if (ADMIN_EMAILS.has(normalizedEmail)) user.role = 'admin';
  }
  save();
  return user;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function handleOAuthStart(req, res, provider) {
  const state = randomState();
  rememberOAuthState(state, provider);
  if (provider === 'google') {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return redirect(res, '/?error=google_not_configured');
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code', scope: 'openid email profile', state,
      access_type: 'online', prompt: 'select_account',
    });
    return redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }
  if (provider === 'facebook') {
    if (!FACEBOOK_CLIENT_ID || !FACEBOOK_CLIENT_SECRET) return redirect(res, '/?error=facebook_not_configured');
    const params = new URLSearchParams({
      client_id: FACEBOOK_CLIENT_ID, redirect_uri: FACEBOOK_REDIRECT_URI,
      response_type: 'code', scope: 'email,public_profile', state,
    });
    return redirect(res, `https://www.facebook.com/dialog/oauth?${params}`);
  }
  res.writeHead(404); res.end('Unknown provider');
}

async function handleOAuthCallback(req, res, provider, query) {
  if (query.error) return redirect(res, `/?error=${encodeURIComponent(query.error)}`);
  if (!consumeOAuthState(query.state, provider) || !query.code) return redirect(res, '/?error=invalid_oauth_state');
  try {
    let profile;
    if (provider === 'google') {
      const tokenBody = new URLSearchParams({
        code: query.code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code',
      }).toString();
      const tokenResponse = await httpRequest('POST', 'https://oauth2.googleapis.com/token', {
        'Content-Type': 'application/x-www-form-urlencoded',
      }, tokenBody);
      const token = JSON.parse(tokenResponse.body);
      if (!token.access_token) throw new Error(token.error_description || 'Google token exchange failed');
      const me = await httpRequest('GET', `https://openidconnect.googleapis.com/v1/userinfo?access_token=${encodeURIComponent(token.access_token)}`);
      profile = JSON.parse(me.body);
      profile.id = profile.sub;
    } else {
      const tokenUrl = new URL('https://graph.facebook.com/oauth/access_token');
      tokenUrl.search = new URLSearchParams({
        client_id: FACEBOOK_CLIENT_ID, client_secret: FACEBOOK_CLIENT_SECRET,
        redirect_uri: FACEBOOK_REDIRECT_URI, code: query.code,
      }).toString();
      const tokenResponse = await httpRequest('GET', tokenUrl.toString());
      const token = JSON.parse(tokenResponse.body);
      if (!token.access_token) throw new Error(token.error?.message || 'Facebook token exchange failed');
      const me = await httpRequest('GET', `https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(token.access_token)}`);
      profile = JSON.parse(me.body);
    }
    const user = upsertOAuthUser({ provider, id: profile.id, name: profile.name || profile.given_name, email: profile.email });
    createSession(res, user.id);
    return redirect(res, '/');
  } catch (err) {
    console.error(`${provider} OAuth error:`, err);
    return redirect(res, `/?error=${encodeURIComponent('login_failed')}`);
  }
}

// ---------------------------------------------------------------------------
// ABA PayWay helpers
// ---------------------------------------------------------------------------
function makeTranId() {
  return `SB${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`.slice(0, 20);
}

function paywayHash(parts) {
  return crypto.createHmac('sha512', PAYWAY_API_KEY).update(parts.join('')).digest('base64');
}

function paywayTime() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function paywayCheckoutHtml(order, book, user) {
  const reqTime = paywayTime();
  const amount = Number(order.amount).toFixed(2);
  const nameParts = String(user.name || 'Customer').trim().split(/\\s+/);
  const firstname = nameParts.shift() || 'Customer';
  const lastname = nameParts.join(' ') || 'Customer';
  const items = Buffer.from(JSON.stringify([{ name: book.title, quantity: 1, price: Number(order.amount) }])).toString('base64');
  const returnUrl = PAYWAY_RETURN_URL;
  const callbackUrl = PAYWAY_CALLBACK_URL;
  // PayWay's current Purchase API documents this exact parameter order for the hash.
  const cancelUrl = `${APP_BASE_URL}/pay.html?order=${encodeURIComponent(order.id)}`;
  const continueUrl = cancelUrl;
  const hashParts = [
    reqTime, PAYWAY_MERCHANT_ID, order.paywayRef, amount, items, '', '', '',
    firstname, lastname, user.email || '', '', 'purchase', '',
    returnUrl, cancelUrl, continueUrl, '', 'USD', '', order.id,
  ];
  const hash = paywayHash(hashParts);
  const fields = {
    req_time: reqTime, merchant_id: PAYWAY_MERCHANT_ID, tran_id: order.paywayRef,
    firstname, lastname, email: user.email || '', phone: '', type: 'purchase',
    payment_option: '', items, shipping: '', amount, currency: 'USD',
    return_url: returnUrl, cancel_url: cancelUrl,
    continue_success_url: continueUrl,
    return_deeplink: '', custom_fields: '', return_params: order.id,
    view_type: 'hosted_view', hash,
  };
  if (callbackUrl) fields.callback_url = callbackUrl;
  const inputs = Object.entries(fields).map(([k,v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`).join('\\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Secure ABA PayWay Checkout</title></head><body>\n<form id="payway" method="POST" action="${PAYWAY_BASE_URL}/api/payment-gateway/v1/payments/purchase">${inputs}<noscript><button>Continue to ABA PayWay</button></noscript></form>\n<script>document.getElementById('payway').submit();</script></body></html>`;
}

async function refreshPayWayOrder(order) {
  if (!PAYWAY_MERCHANT_ID || !PAYWAY_API_KEY) return order;
  const reqTime = paywayTime();
  const body = JSON.stringify({
    req_time: reqTime, merchant_id: PAYWAY_MERCHANT_ID, tran_id: order.paywayRef,
    hash: paywayHash([reqTime, PAYWAY_MERCHANT_ID, order.paywayRef]),
  });
  const response = await httpRequest('POST', `${PAYWAY_BASE_URL}/api/payment-gateway/v1/payments/check-transaction-2`, {
    'Content-Type': 'application/json', 'Accept': 'application/json',
  }, body);
  const data = JSON.parse(response.body);
  const status = data?.data?.payment_status;
  if (status === 'APPROVED' || data?.data?.payment_status_code === 0) {
    order.status = 'completed';
    order.settledAt = new Date().toISOString();
    order.paywayStatus = status || 'APPROVED';
    if (!db.purchases.some(p => p.orderId === order.id)) {
      db.purchases.push({ id: crypto.randomUUID(), userId: order.userId, bookId: order.bookId, orderId: order.id, purchasedAt: order.settledAt });
    }
    save();
  } else if (status && ['DECLINED', 'FAILED', 'CANCELLED', 'VOID'].includes(status)) {
    order.status = 'failed'; order.settledAt = new Date().toISOString(); order.paywayStatus = status; save();
  }
  return order;
}

// ---------------------------------------------------------------------------
// API router
// ---------------------------------------------------------------------------
async function api(req, res, pathname, query) {
  const method = req.method;

  // ---- Auth ---------------------------------------------------------------
  if (pathname === '/api/auth/providers' && method === 'GET') {
    return sendJSON(res, 200, {
      google: !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      facebook: !!(FACEBOOK_CLIENT_ID && FACEBOOK_CLIENT_SECRET),
    });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    destroySession(req, res);
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    return sendJSON(res, 200, { user: publicUser(getCurrentUser(req)) });
  }

  // ---- Books ----------------------------------------------------------------
  if (pathname === '/api/books' && method === 'GET') {
    const q = (query.q || '').toLowerCase().trim();
    const filter = query.filter || 'all'; // all | free | paid
    let results = db.books.filter(b => {
      const matchesQ = !q || b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) || b.category.toLowerCase().includes(q);
      const matchesFilter = filter === 'all' || (filter === 'free' && b.isFree) || (filter === 'paid' && !b.isFree);
      return matchesQ && matchesFilter;
    });
    return sendJSON(res, 200, { books: results.map(b => publicBook(b)) });
  }

  const bookMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
  if (bookMatch && method === 'GET') {
    const book = db.books.find(b => b.id === bookMatch[1]);
    if (!book) return sendJSON(res, 404, { error: 'Book not found' });
    const user = getCurrentUser(req);
    const owned = user ? ownsBook(user.id, book.id) : book.isFree ? false : false;
    return sendJSON(res, 200, { book: publicBook(book, { includeContent: owned }), owned });
  }

  // ---- Orders / purchase flow -----------------------------------------------
  if (pathname === '/api/orders' && method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const { bookId } = await readBody(req);
    const book = db.books.find(b => b.id === bookId);
    if (!book) return sendJSON(res, 400, { error: 'Unknown book' });
    if (ownsBook(user.id, book.id)) return sendJSON(res, 400, { error: 'Already owned' });

    if (book.isFree) {
      // Free books skip payment entirely.
      const order = {
        id: crypto.randomUUID(), userId: user.id, bookId: book.id,
        amount: 0, status: 'completed', createdAt: new Date().toISOString(),
      };
      db.orders.push(order);
      db.purchases.push({ id: crypto.randomUUID(), userId: user.id, bookId: book.id, orderId: order.id, purchasedAt: order.createdAt });
      save();
      return sendJSON(res, 200, { order, redirect: null });
    }

    if (!PAYWAY_MERCHANT_ID || !PAYWAY_API_KEY) {
      return sendJSON(res, 503, { error: 'ABA PayWay is not configured. Set PAYWAY_MERCHANT_ID and PAYWAY_API_KEY.' });
    }

    const order = {
      id: crypto.randomUUID(), userId: user.id, bookId: book.id,
      amount: Number(book.price.toFixed(2)), status: 'pending', createdAt: new Date().toISOString(),
      paywayRef: makeTranId(),
    };
    db.orders.push(order);
    save();
    return sendJSON(res, 200, { order, redirect: `/payway/checkout/${order.id}` });
  }

  const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderMatch && method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const order = db.orders.find(o => o.id === orderMatch[1] && o.userId === user.id);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });
    const book = db.books.find(b => b.id === order.bookId);
    return sendJSON(res, 200, { order, book: publicBook(book) });
  }


  const payStatusMatch = pathname.match(/^\/api\/orders\/([^/]+)\/refresh-payment$/);
  if (payStatusMatch && method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const order = db.orders.find(o => o.id === payStatusMatch[1] && o.userId === user.id);
    if (!order) return sendJSON(res, 404, { error: 'Order not found' });
    if (order.status === 'pending') {
      try { await refreshPayWayOrder(order); }
      catch (e) { console.error('PayWay status check:', e.message); }
    }
    return sendJSON(res, 200, { order });
  }

  // ---- My Books ---------------------------------------------------------
  if (pathname === '/api/my-books' && method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const ownedIds = new Set(db.purchases.filter(p => p.userId === user.id).map(p => p.bookId));
    const list = db.books.filter(b => ownedIds.has(b.id));
    const withProgress = list.map(b => {
      const prog = db.progress.find(p => p.userId === user.id && p.bookId === b.id);
      return { ...publicBook(b), percent: prog ? prog.percent : 0 };
    });
    return sendJSON(res, 200, { books: withProgress });
  }

  // ---- Progress -----------------------------------------------------------
  if (pathname === '/api/progress' && method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const { bookId, percent } = await readBody(req);
    if (!ownsBook(user.id, bookId)) return sendJSON(res, 403, { error: 'Not owned' });
    let prog = db.progress.find(p => p.userId === user.id && p.bookId === bookId);
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    if (prog) { prog.percent = pct; prog.updatedAt = new Date().toISOString(); }
    else { prog = { id: crypto.randomUUID(), userId: user.id, bookId, percent: pct, updatedAt: new Date().toISOString() }; db.progress.push(prog); }
    save();
    return sendJSON(res, 200, { progress: prog });
  }

  const progressMatch = pathname.match(/^\/api\/progress\/([^/]+)$/);
  if (progressMatch && method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const prog = db.progress.find(p => p.userId === user.id && p.bookId === progressMatch[1]);
    return sendJSON(res, 200, { percent: prog ? prog.percent : 0 });
  }

  // ---- Admin ----------------------------------------------------------------
  if (pathname === '/api/admin/stats' && method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const totalUsers = db.users.length;
    const totalBooks = db.books.length;
    const completedOrders = db.orders.filter(o => o.status === 'completed');
    const paidOrders = completedOrders.filter(o => o.amount > 0);
    const totalRevenue = paidOrders.reduce((s, o) => s + o.amount, 0);
    const freeDownloads = completedOrders.filter(o => o.amount === 0).length;
    const pendingOrders = db.orders.filter(o => o.status === 'pending').length;
    return sendJSON(res, 200, {
      totalUsers, totalBooks, totalOrders: db.orders.length,
      paidOrders: paidOrders.length, freeDownloads, pendingOrders,
      totalRevenue: Number(totalRevenue.toFixed(2)),
    });
  }

  if (pathname === '/api/admin/orders' && method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const list = db.orders
      .slice()
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(o => {
        const user = db.users.find(u => u.id === o.userId);
        const book = db.books.find(b => b.id === o.bookId);
        return {
          id: o.id, status: o.status, amount: o.amount, createdAt: o.createdAt,
          paywayRef: o.paywayRef || null,
          userName: user ? user.name : '(deleted user)',
          userEmail: user ? user.email : '',
          bookTitle: book ? book.title : '(deleted book)',
        };
      });
    return sendJSON(res, 200, { orders: list });
  }

  if (pathname === '/api/admin/users' && method === 'GET') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const list = db.users.map(u => ({
      ...publicUser(u),
      orders: db.orders.filter(o => o.userId === u.id).length,
      spent: Number(db.orders.filter(o => o.userId === u.id && o.status === 'completed').reduce((s, o) => s + o.amount, 0).toFixed(2)),
    }));
    return sendJSON(res, 200, { users: list });
  }

  const userRoleMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (userRoleMatch && method === 'POST') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const { role } = await readBody(req);
    if (!['user', 'admin'].includes(role)) return sendJSON(res, 400, { error: 'Invalid role' });
    const target = db.users.find(u => u.id === userRoleMatch[1]);
    if (!target) return sendJSON(res, 404, { error: 'User not found' });
    target.role = role;
    save();
    return sendJSON(res, 200, { user: publicUser(target) });
  }

  const userDelMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userDelMatch && method === 'DELETE') {
    const admin = requireAdmin(req, res); if (!admin) return;
    db.users = db.users.filter(u => u.id !== userDelMatch[1]);
    save();
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/books' && method === 'POST') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const b = await readBody(req);
    if (!b.title || !b.author) return sendJSON(res, 400, { error: 'title and author required' });
    const isFree = !!b.isFree;
    const book = {
      id: crypto.randomUUID(),
      title: b.title, author: b.author, category: b.category || 'General',
      description: b.description || '', content: b.content || '',
      isFree, price: isFree ? 0 : 0.5,
      createdAt: new Date().toISOString(),
    };
    db.books.push(book);
    save();
    return sendJSON(res, 200, { book });
  }

  const bookEditMatch = pathname.match(/^\/api\/admin\/books\/([^/]+)$/);
  if (bookEditMatch && method === 'PUT') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const book = db.books.find(x => x.id === bookEditMatch[1]);
    if (!book) return sendJSON(res, 404, { error: 'Book not found' });
    const b = await readBody(req);
    ['title', 'author', 'category', 'description', 'content'].forEach(k => { if (b[k] !== undefined) book[k] = b[k]; });
    if (b.isFree !== undefined) { book.isFree = !!b.isFree; book.price = book.isFree ? 0 : 0.5; }
    save();
    return sendJSON(res, 200, { book });
  }
  if (bookEditMatch && method === 'DELETE') {
    const admin = requireAdmin(req, res); if (!admin) return;
    db.books = db.books.filter(x => x.id !== bookEditMatch[1]);
    save();
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------------------
// Non-API OAuth and PayWay routes
// ---------------------------------------------------------------------------
async function nonApi(req, res, pathname, query) {
  if (pathname === '/auth/google/start' && req.method === 'GET') return handleOAuthStart(req, res, 'google');
  if (pathname === '/auth/google/callback' && req.method === 'GET') return handleOAuthCallback(req, res, 'google', query);
  if (pathname === '/auth/facebook/start' && req.method === 'GET') return handleOAuthStart(req, res, 'facebook');
  if (pathname === '/auth/facebook/callback' && req.method === 'GET') return handleOAuthCallback(req, res, 'facebook', query);

  const checkoutMatch = pathname.match(/^\/payway\/checkout\/([^/]+)$/);
  if (checkoutMatch && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const order = db.orders.find(o => o.id === checkoutMatch[1] && o.userId === user.id);
    if (!order) { res.writeHead(404); return res.end('Order not found'); }
    const book = db.books.find(b => b.id === order.bookId);
    if (!book) { res.writeHead(404); return res.end('Book not found'); }
    if (order.status !== 'pending') return redirect(res, `/pay.html?order=${encodeURIComponent(order.id)}`);
    if (!PAYWAY_MERCHANT_ID || !PAYWAY_API_KEY) { res.writeHead(503, {'Content-Type':'text/plain'}); return res.end('ABA PayWay is not configured.'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(paywayCheckoutHtml(order, book, user));
  }

  // PayWay can POST a JSON payment notification here when configured.
  if (pathname === '/payway/return' && req.method === 'POST') {
    try {
      const payload = await readBody(req);
      const signature = req.headers['x-payway-hmac-sha512'];
      if (PAYWAY_API_KEY) {
        if (!signature) { res.writeHead(401); return res.end('Missing signature'); }
        const sorted = Object.keys(payload).sort().map(k => Array.isArray(payload[k]) ? JSON.stringify(payload[k]) : payload[k]).join('');
        const expected = crypto.createHmac('sha512', PAYWAY_API_KEY).update(sorted).digest('base64');
        const received = Buffer.from(String(signature));
        const expectedBuf = Buffer.from(expected);
        if (received.length !== expectedBuf.length || !crypto.timingSafeEqual(expectedBuf, received)) { res.writeHead(401); return res.end('Invalid signature'); }
      }
      const order = db.orders.find(o => o.paywayRef === payload.tran_id);
      if (order) {
        if (String(payload.status) === '0') {
          order.status = 'completed'; order.settledAt = new Date().toISOString(); order.paywayStatus = 'APPROVED';
          if (!db.purchases.some(p => p.orderId === order.id)) db.purchases.push({ id: crypto.randomUUID(), userId: order.userId, bookId: order.bookId, orderId: order.id, purchasedAt: order.settledAt });
        } else if (payload.status) {
          order.status = 'failed'; order.settledAt = new Date().toISOString(); order.paywayStatus = String(payload.status);
        }
        save();
        const target = `/pay.html?order=${encodeURIComponent(order.id)}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>`);
      }
      res.writeHead(200); return res.end('OK');
    } catch (e) {
      console.error('PayWay callback:', e);
      res.writeHead(400); return res.end('Bad request');
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith('/api/')) {
    try {
      await api(req, res, pathname, parsed.query);
    } catch (err) {
      console.error(err);
      sendJSON(res, 500, { error: 'Server error' });
    }
    return;
  }

  try {
    const handled = await nonApi(req, res, pathname, parsed.query);
    if (handled !== false) return;
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end('Server error');
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`📚 Sabai Books running at http://localhost:${PORT}`);
});
