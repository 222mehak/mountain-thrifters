// The Mountain Thrifters: shop backend.
// Serves the site, keeps track of what has sold, takes orders, sends alerts,
// and reads the Instagram feed. Settings come from the Worker's secrets:
//   UPI_ID, UPI_NAME            where customers pay
//   ADMIN_KEY                   password for /admin.html
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID      order alerts on Telegram
//   RESEND_API_KEY, NOTIFY_EMAIL, EMAIL_FROM  order alerts by email
//   IG_ACCESS_TOKEN             Instagram feed and post-to-product
//   FB_APP_ID, FB_APP_SECRET    only when the token comes from Facebook login
//   WHATSAPP_NUMBER             optional, replaces the number below

// Orders are sent to this WhatsApp number (country code first, digits only).
const WHATSAPP = '919317568898';
const whatsapp = (env) => String(env.WHATSAPP_NUMBER || WHATSAPP).replace(/\D/g, '');

// The categories the shop starts with. The owner can change them in the app.
const DEFAULT_CATEGORIES = [
  { name: 'Clothing', subs: ['Jackets and shells', 'Puffers and down', 'Fleece and mid-layers', 'Base layers', 'Snow and trek pants', 'Rainwear'] },
  { name: 'Footwear', subs: ['Trek boots', 'Snow boots', 'Socks and gaiters'] },
  { name: 'Accessories', subs: ['Gloves', 'Beanies and caps', 'Goggles and sunglasses', 'Neck warmers'] },
  { name: 'Packs and bags', subs: ['Backpacks', 'Daypacks', 'Duffels', 'Rain covers'] },
  { name: 'Camping', subs: ['Tents', 'Sleeping bags', 'Mats', 'Stoves and cookware'] },
  { name: 'Trek essentials', subs: ['Trekking poles', 'Headlamps', 'Bottles and flasks', 'Microspikes'] },
];
async function setting(env, key) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : '';
}
async function saveSetting(env, key, value) {
  await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
async function categories(env) {
  try { const v = JSON.parse(await setting(env, 'categories')); if (Array.isArray(v) && v.length) return v; } catch (e) { /* use the defaults */ }
  return DEFAULT_CATEGORIES;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sold (product_id TEXT PRIMARY KEY, order_id TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, status TEXT, total INTEGER, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, product_id TEXT, type TEXT, bytes BLOB)'),
  ]);
  ready = true;
}

// ---------- Instagram ----------
async function igToken(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ig_token'").first();
  return (row && row.value) || env.IG_ACCESS_TOKEN || '';
}
// Works with both kinds of Instagram token:
//  - "Instagram login" tokens (start with IG): used as they are.
//  - "Facebook login" tokens: swapped once for a lasting Page token (needs
//    FB_APP_ID and FB_APP_SECRET), and the linked Instagram account is looked up.
const FB = 'https://graph.facebook.com/v21.0';
async function igAuth(env) {
  const raw = (env.IG_ACCESS_TOKEN || '').trim();
  if (!raw) return { error: 'not connected: add IG_ACCESS_TOKEN first' };
  if (raw.startsWith('IG')) return { token: await igToken(env), base: 'https://graph.instagram.com', id: 'me' };
  const src = raw.slice(-16);
  try { const c = JSON.parse(await setting(env, 'ig_auth')); if (c && c.src === src && c.token && c.id) return c; } catch (e) { /* look it up again */ }
  let token = raw, lasting = false;
  if (env.FB_APP_ID && env.FB_APP_SECRET) {
    const x = await (await fetch(FB + '/oauth/access_token?grant_type=fb_exchange_token&client_id=' + encodeURIComponent(env.FB_APP_ID) +
      '&client_secret=' + encodeURIComponent(env.FB_APP_SECRET) + '&fb_exchange_token=' + encodeURIComponent(raw))).json();
    if (x.access_token) { token = x.access_token; lasting = true; }
    else return { error: 'Facebook did not accept the token: ' + ((x.error && x.error.message) || 'unknown reason') };
  }
  const pages = await (await fetch(FB + '/me/accounts?fields=name,access_token,instagram_business_account&limit=50&access_token=' + encodeURIComponent(token))).json();
  let found = (pages.data || []).find((pg) => pg.instagram_business_account);
  let auth = found ? { token: found.access_token, id: found.instagram_business_account.id } : null;
  if (!auth) {
    const me = await (await fetch(FB + '/me?fields=instagram_business_account&access_token=' + encodeURIComponent(token))).json();
    if (me.instagram_business_account) auth = { token, id: me.instagram_business_account.id };
  }
  if (!auth) return { error: (pages.error && pages.error.message) || 'No Instagram account is linked to a Facebook Page on this login.' };
  auth = { ...auth, base: FB, src };
  if (lasting) await saveSetting(env, 'ig_auth', JSON.stringify(auth));
  return auth;
}
async function igPage(env, ctx, after) {
  const auth = await igAuth(env);
  if (auth.error) return { posts: [], next: '', error: auth.error };
  const token = auth.token;
  const cacheKey = new Request('https://cache.local/ig?after=' + encodeURIComponent(after || ''));
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.json();
  const u = new URL(auth.base + '/' + auth.id + '/media');
  u.searchParams.set('fields', 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp');
  u.searchParams.set('limit', '30');
  if (after) u.searchParams.set('after', after);
  u.searchParams.set('access_token', token);
  const res = await fetch(u);
  if (!res.ok) return { posts: [], next: '', error: 'Instagram answered ' + res.status };
  const body = await res.json();
  const out = {
    posts: (body.data || []).map((p) => ({
      id: p.id, caption: p.caption || '', link: p.permalink, at: p.timestamp,
      image: p.media_type === 'VIDEO' ? (p.thumbnail_url || '') : (p.media_url || p.thumbnail_url || ''),
    })).filter((p) => p.image),
    next: (body.paging && body.paging.next && body.paging.cursors && body.paging.cursors.after) || '',
  };
  const store = new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' } });
  ctx.waitUntil(caches.default.put(cacheKey, store));
  return out;
}
// A post becomes a product when its caption has a "Price:" line.
//   Colour-block ski jacket
//   Size: M
//   Condition: Barely worn
//   Price: 2400
//   Vibe: Retro ski
function productFromPost(p) {
  const get = (k) => { const m = p.caption.match(new RegExp('^\\s*' + k + '\\s*[:\\-]\\s*(.+)$', 'im')); return m ? m[1].trim() : ''; };
  const price = parseInt(get('price').replace(/[^\d]/g, ''), 10);
  if (!price) return null;
  const first = p.caption.split('\n').map((s) => s.trim()).filter(Boolean)[0] || 'Thrifted piece';
  return { id: 'ig' + p.id, name: first.slice(0, 80), brand: get('brand').slice(0, 40), category: get('category').slice(0, 40), sub: get('type').slice(0, 40),
    gender: get('for').slice(0, 12), size: get('size').slice(0, 20), condition: get('condition'), price, photo: p.image, link: p.link, colors: [], sold: /sold/i.test(get('status')) };
}

// ---------- Products ----------
// priv = true keeps what the owner paid for each piece. Shoppers never get that.
async function allProducts(request, env, ctx, priv) {
  let list = [];
  // The sample pieces stay until the owner hides them from the app.
  if ((await setting(env, 'hide_samples')) !== '1') {
    try {
      const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
      if (res.ok) list = (await res.json()).map((p) => ({ ...p, sample: true }));
    } catch (e) { list = []; }
  }
  // Stock added from the admin page, newest first.
  const own = await env.DB.prepare('SELECT data, at FROM products ORDER BY at DESC').all();
  list = (own.results || []).map((r) => ({ ...JSON.parse(r.data), listedAt: r.at })).concat(list);
  try {
    const ig = await igPage(env, ctx, '');
    for (const p of ig.posts) { const prod = productFromPost(p); if (prod) list.push(prod); }
  } catch (e) { /* the shop still works without Instagram */ }
  const sold = await env.DB.prepare('SELECT product_id FROM sold').all();
  const gone = new Set((sold.results || []).map((r) => r.product_id));
  return list.map((p) => {
    const out = { ...p, id: String(p.id), sold: !!p.sold || gone.has(String(p.id)) };
    if (!priv) delete out.cost;
    return out;
  });
}

// ---------- Alerts ----------
async function notify(env, order) {
  const lines = order.items.map((i) => '- ' + i.name + (i.size ? ' (Size ' + i.size + ')' : '') + ' Rs ' + i.price);
  const text = 'New order ' + order.id + '\n' + lines.join('\n') + '\nTotal: Rs ' + order.total +
    '\n\n' + order.name + '\n' + order.phone + '\n' + order.address + '\n' + order.city + ' ' + order.pincode +
    '\n\nWaiting for UPI payment. Confirm it in the admin page.';
  const jobs = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    }));
  }
  if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) {
    jobs.push(fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RESEND_API_KEY },
      body: JSON.stringify({ from: env.EMAIL_FROM || 'The Mountain Thrifters <orders@mountainthrifters.com>',
        to: env.NOTIFY_EMAIL.split(',').map((s) => s.trim()), subject: 'New order ' + order.id + ' (Rs ' + order.total + ')', text }),
    }));
  }
  await Promise.allSettled(jobs);
}

// ---------- Orders ----------
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
async function placeOrder(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_request', message: 'Could not read the order.' }, 400); }
  const ids = Array.isArray(body.items) ? [...new Set(body.items.map(String))].slice(0, 10) : [];
  const name = clean(body.name, 80), phone = clean(body.phone, 15).replace(/\D/g, ''), pincode = clean(body.pincode, 10).replace(/\D/g, '');
  const city = clean(body.city, 60), address = clean(body.address, 300);
  if (!ids.length) return json({ error: 'empty', message: 'Your bag is empty.' }, 400);
  if (!name || phone.length !== 10 || pincode.length !== 6 || !address) return json({ error: 'details', message: 'Check your name, 10-digit mobile, 6-digit pincode and address.' }, 400);
  const products = await allProducts(request, env, ctx, true);
  const items = [];
  for (const id of ids) {
    const p = products.find((x) => x.id === id);
    if (!p) return json({ error: 'unknown', message: 'One of these pieces is no longer listed.' }, 409);
    if (p.sold) return json({ error: 'sold', message: p.name + ' has just sold.', productId: id }, 409);
    items.push({ id: p.id, name: (p.brand ? p.brand + ' ' : '') + p.name, size: p.size || '', price: Number(p.price) || 0,
      brand: p.brand || '', category: p.category || '', cost: p.cost == null ? null : Number(p.cost), listedAt: p.listedAt || '' });
  }
  const total = items.reduce((s, i) => s + i.price, 0);
  const id = 'MT' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  const at = new Date().toISOString();
  const order = { id, items, total, name, phone, pincode, city, address };
  // One batch: if any piece was taken a moment ago, nothing is saved.
  const stmts = items.map((i) => env.DB.prepare('INSERT INTO sold (product_id, order_id, at) VALUES (?, ?, ?)').bind(i.id, id, at));
  stmts.push(env.DB.prepare('INSERT INTO orders (id, status, total, data, at) VALUES (?, ?, ?, ?, ?)').bind(id, 'awaiting payment', total, JSON.stringify(order), at));
  try { await env.DB.batch(stmts); }
  catch (e) { return json({ error: 'sold', message: 'Someone bought one of these a moment ago. Your bag has been updated.' }, 409); }
  ctx.waitUntil(notify(env, order));
  return json({ orderId: id, total, items: items.map((i) => ({ name: i.name, size: i.size, price: i.price })), upiId: env.UPI_ID || '', upiName: env.UPI_NAME || 'The Mountain Thrifters', whatsapp: whatsapp(env) });
}

// ---------- Admin ----------
function isAdmin(request, env) { return !!env.ADMIN_KEY && request.headers.get('x-admin-key') === env.ADMIN_KEY; }
// New stock from the admin page. Photos arrive already shrunk by the browser.
async function addProduct(request, env, body) {
  const name = clean(body.name, 80), price = parseInt(String(body.price).replace(/[^\d]/g, ''), 10);
  if (!name || !price) return json({ error: 'details', message: 'Add a name and a price.' }, 400);
  const pics = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (!pics.length) return json({ error: 'details', message: 'Add at least one photo.' }, 400);
  const id = 'p' + Date.now().toString(36);
  const stmts = [], photos = [];
  for (let n = 0; n < pics.length; n++) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(pics[n]));
    if (!m) return json({ error: 'details', message: 'One of the photos could not be read.' }, 400);
    const bin = atob(m[2]);
    if (bin.length > 1500000) return json({ error: 'details', message: 'One of the photos is too large.' }, 400);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const imgId = id + '-' + n;
    stmts.push(env.DB.prepare('INSERT INTO images (id, product_id, type, bytes) VALUES (?, ?, ?, ?)').bind(imgId, id, m[1], bytes));
    photos.push('/img/' + imgId);
  }
  const product = { id, name, brand: clean(body.brand, 40), category: clean(body.category, 40), sub: clean(body.sub, 40), gender: clean(body.gender, 12),
    cost: String(body.cost == null ? '' : body.cost).replace(/[^\d]/g, '') === '' ? null : parseInt(String(body.cost).replace(/[^\d]/g, ''), 10),
    size: clean(body.size, 20), condition: clean(body.condition, 20), price, description: clean(body.description, 600), photo: photos[0], photos, colors: [], sold: false };
  stmts.push(env.DB.prepare('INSERT INTO products (id, data, at) VALUES (?, ?, ?)').bind(id, JSON.stringify(product), new Date().toISOString()));
  await env.DB.batch(stmts);
  let instagram = 'not requested';
  if (body.postToInstagram) instagram = await igPublish(request, env, product);
  return json({ ok: true, id, instagram });
}
// Publishes the first photo to Instagram with a caption linking back to the piece.
async function igPublish(request, env, product) {
  const auth = await igAuth(env);
  if (auth.error) return auth.error;
  const token = auth.token;
  // Captions always show the shop's own address, whichever address the owner app was opened from.
  const origin = new URL(request.url).origin;
  const shop = env.SHOP_URL || 'mountainthrifters.com';
  const caption = (product.brand ? product.brand + ' ' : '') + product.name + '\n' + [product.size ? 'Size ' + product.size : '', product.condition, 'Rs ' + product.price.toLocaleString('en-IN')].filter(Boolean).join(' · ') +
    '\n\nOne of one. Shop it at ' + shop + '/p/' + product.id + '\n\n#thrifted #mountainthrifters #manali';
  try {
    const make = new URL(auth.base + '/' + auth.id + '/media');
    make.searchParams.set('image_url', origin + product.photo);
    make.searchParams.set('caption', caption);
    make.searchParams.set('access_token', token);
    const a = await (await fetch(make, { method: 'POST' })).json();
    if (!a.id) return 'failed: ' + ((a.error && a.error.message) || 'Instagram did not accept the photo');
    const pub = new URL(auth.base + '/' + auth.id + '/media_publish');
    pub.searchParams.set('creation_id', a.id);
    pub.searchParams.set('access_token', token);
    const b = await (await fetch(pub, { method: 'POST' })).json();
    return b.id ? 'posted' : 'failed: ' + ((b.error && b.error.message) || 'Instagram did not publish the post');
  } catch (e) { return 'failed: could not reach Instagram'; }
}

// Everything the Numbers tab needs: each sale, what is waiting, and what is unsold.
async function stats(request, env, ctx) {
  const products = await allProducts(request, env, ctx, true);
  const byId = new Map(products.map((p) => [p.id, p]));
  const rows = await env.DB.prepare('SELECT status, total, data, at FROM orders ORDER BY at').all();
  const sales = [], pending = { count: 0, total: 0 }; let cancelled = 0;
  for (const r of rows.results || []) {
    if (r.status === 'cancelled') { cancelled++; continue; }
    if (r.status === 'awaiting payment') { pending.count++; pending.total += r.total || 0; continue; }
    for (const i of JSON.parse(r.data).items || []) {
      const p = byId.get(String(i.id)) || {};
      if (p.sample) continue;
      sales.push({ name: i.name, brand: i.brand || p.brand || '', category: i.category || p.category || '', price: Number(i.price) || 0,
        cost: i.cost != null ? i.cost : (p.cost != null ? p.cost : null), listedAt: i.listedAt || p.listedAt || '', soldAt: r.at });
    }
  }
  // Pieces marked as sold by hand, for example sold over Instagram.
  const manual = await env.DB.prepare("SELECT product_id, at FROM sold WHERE order_id = 'manual'").all();
  for (const m of manual.results || []) {
    const p = byId.get(String(m.product_id));
    if (p && !p.sample) sales.push({ name: (p.brand ? p.brand + ' ' : '') + p.name, brand: p.brand || '', category: p.category || '', price: Number(p.price) || 0,
      cost: p.cost != null ? p.cost : null, listedAt: p.listedAt || '', soldAt: m.at, manual: true });
  }
  const stock = products.filter((p) => !p.sold && !p.sample).map((p) => ({ price: Number(p.price) || 0, cost: p.cost != null ? p.cost : null, listedAt: p.listedAt || '', category: p.category || '' }));
  return json({ sales, pending, cancelled, stock });
}

async function admin(request, env, path, ctx) {
  if (!isAdmin(request, env)) return json({ error: 'forbidden', message: 'Wrong admin key.' }, 403);
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, status, total, data, at FROM orders ORDER BY at DESC LIMIT 200').all();
    return json({ orders: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), status: r.status, at: r.at })) });
  }
  if (path === '/api/admin/products' && request.method === 'GET') return json({ products: await allProducts(request, env, ctx, true), hideSamples: (await setting(env, 'hide_samples')) === '1' });
  if (path === '/api/admin/stats' && request.method === 'GET') return stats(request, env, ctx);
  if (path === '/api/admin/plan' && request.method === 'GET') {
    let plan = {}; try { plan = JSON.parse(await setting(env, 'plan')) || {}; } catch (e) { plan = {}; }
    return json({ state: plan.state || {}, custom: plan.custom || [] });
  }
  if (path === '/api/admin/ig-check' && request.method === 'GET') {
    const auth = await igAuth(env);
    if (auth.error) return json({ ok: false, message: auth.error });
    const r = await (await fetch(auth.base + '/' + auth.id + '?fields=username&access_token=' + encodeURIComponent(auth.token))).json();
    return json(r.username ? { ok: true, message: 'Connected as @' + r.username } : { ok: false, message: (r.error && r.error.message) || 'Instagram did not answer.' });
  }
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/api/admin/product') return addProduct(request, env, body);
  if (path === '/api/admin/product-cost') {
    const row = await env.DB.prepare('SELECT data FROM products WHERE id = ?').bind(String(body.id)).first();
    if (!row) return json({ error: 'details', message: 'Only pieces added from this app can have a cost.' }, 400);
    const p = JSON.parse(row.data), n = String(body.cost == null ? '' : body.cost).replace(/[^\d]/g, '');
    p.cost = n === '' ? null : parseInt(n, 10);
    await env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), String(body.id)).run();
    return json({ ok: true });
  }
  // The marketing plan: which tasks are ticked, who owns them, and any tasks the owners added.
  // Each change is merged into the saved copy, so two phones do not overwrite each other.
  if (path === '/api/admin/plan') {
    let plan = {}; try { plan = JSON.parse(await setting(env, 'plan')) || {}; } catch (e) { plan = {}; }
    plan.state = plan.state || {}; plan.custom = plan.custom || [];
    if (body.set && body.set.id) {
      const id = clean(body.set.id, 40), cur = plan.state[id] || {};
      if ('done' in body.set) cur.done = body.set.done ? clean(body.set.done, 12) : '';
      if ('who' in body.set) cur.who = clean(body.set.who, 12);
      if ('note' in body.set) cur.note = clean(body.set.note, 300);
      plan.state[id] = cur;
    }
    if (body.add && body.add.title && plan.custom.length < 200) plan.custom.push({ id: 'c' + Date.now().toString(36), phase: clean(body.add.phase, 20), title: clean(body.add.title, 140) });
    if (body.remove) { plan.custom = plan.custom.filter((t) => t.id !== String(body.remove)); delete plan.state[String(body.remove)]; }
    await saveSetting(env, 'plan', JSON.stringify(plan));
    return json({ ok: true, state: plan.state, custom: plan.custom });
  }
  if (path === '/api/admin/samples') { await saveSetting(env, 'hide_samples', body.hide ? '1' : '0'); return json({ ok: true }); }
  if (path === '/api/admin/categories') {
    const tree = (Array.isArray(body.categories) ? body.categories : []).slice(0, 30).map((c) => ({
      name: clean(c && c.name, 40), subs: [...new Set((Array.isArray(c && c.subs) ? c.subs : []).map((x) => clean(x, 40)).filter(Boolean))].slice(0, 40),
    })).filter((c) => c.name);
    if (!tree.length) return json({ error: 'details', message: 'Keep at least one category.' }, 400);
    // A rename also moves the pieces already filed under the old name.
    const renames = (Array.isArray(body.renames) ? body.renames : []).slice(0, 20);
    if (renames.length) {
      const rows = await env.DB.prepare('SELECT id, data FROM products').all();
      const stmts = [];
      for (const r of rows.results || []) {
        const p = JSON.parse(r.data); let changed = false;
        for (const n of renames) {
          const from = clean(n.from, 40), to = clean(n.to, 40);
          if (!from || !to) continue;
          if (n.kind === 'group' && p.category === from) { p.category = to; changed = true; }
          if (n.kind === 'sub' && p.category === clean(n.group, 40) && p.sub === from) { p.sub = to; changed = true; }
        }
        if (changed) stmts.push(env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), r.id));
      }
      if (stmts.length) await env.DB.batch(stmts);
    }
    await saveSetting(env, 'categories', JSON.stringify(tree));
    return json({ ok: true, categories: tree });
  }
  if (path === '/api/admin/product-delete') {
    if (!body.id) return json({ error: 'bad_request' }, 400);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM products WHERE id = ?').bind(String(body.id)),
      env.DB.prepare('DELETE FROM images WHERE product_id = ?').bind(String(body.id)),
      env.DB.prepare('DELETE FROM sold WHERE product_id = ?').bind(String(body.id)),
    ]);
    return json({ ok: true });
  }
  if (path === '/api/admin/order-status') {
    const status = ['awaiting payment', 'paid', 'shipped', 'cancelled'].includes(body.status) ? body.status : '';
    if (!status || !body.id) return json({ error: 'bad_request' }, 400);
    const stmts = [env.DB.prepare('UPDATE orders SET status = ? WHERE id = ?').bind(status, String(body.id))];
    // Cancelling an order puts its pieces back on sale.
    if (status === 'cancelled') stmts.push(env.DB.prepare('DELETE FROM sold WHERE order_id = ?').bind(String(body.id)));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }
  if (path === '/api/admin/sold') {
    if (!body.productId) return json({ error: 'bad_request' }, 400);
    if (body.sold === false) await env.DB.prepare('DELETE FROM sold WHERE product_id = ?').bind(String(body.productId)).run();
    else await env.DB.prepare('INSERT OR IGNORE INTO sold (product_id, order_id, at) VALUES (?, ?, ?)').bind(String(body.productId), 'manual', new Date().toISOString()).run();
    return json({ ok: true });
  }
  return json({ error: 'not_found' }, 404);
}

// ---------- Pages, photos and search-engine files ----------
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SITE = 'https://mountainthrifters.com';
const slug = (v) => String(v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const rupees = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN');
const PAGES = { '/': ['Thrifted outdoor gear from Manali, delivered across India', 'Thrifted jackets, puffers, trek boots, backpacks, tents and trek essentials from the brands you know. Thrifted and new, at fair prices, shipped from Manali across India.'],
  '/shop': ['Shop thrifted outdoor gear', 'Thrifted jackets, puffers, trek boots, backpacks, tents and trek essentials from the brands you know. Filter by brand, size and category. Delivered across India.'],
  '/sell': ['Sell your outdoor gear', 'Sell your jacket, boots, backpack, tent or bulk stock to The Mountain Thrifters. Get an offer and get paid by UPI.'],
  '/feed': ['Instagram feed', 'The latest thrifted finds from @mountain_thrifters.'], '/bag': ['Your bag', ''], '/checkout': ['Checkout', ''], '/done': ['Order placed', ''] };
// Plain HTML put inside the page before the app starts, so search engines
// read real headings, links and prices instead of a loading message.
const fullName = (p) => (p.brand ? p.brand + ' ' : '') + p.name;
const listHtml = (items) => items.length ? '<ul>' + items.map((p) => '<li><a href="/p/' + encodeURIComponent(p.id) + '">' + esc(fullName(p)) + '</a>' +
  [p.size, p.condition, rupees(p.price), p.sold ? 'Sold' : ''].filter(Boolean).map((x) => ', ' + esc(x)).join('') + '</li>').join('') + '</ul>' : '<p>New pieces land every week.</p>';
const catLinks = (cats) => '<ul>' + cats.map((c) => '<li><a href="/c/' + slug(c.name) + '">Thrifted ' + esc(c.name.toLowerCase()) + '</a>: ' +
  (c.subs || []).map((x) => '<a href="/c/' + slug(x) + '">' + esc(x) + '</a>').join(', ') + '</li>').join('') + '</ul>';
function findCat(cats, s) {
  for (const c of cats) if (slug(c.name) === s) return { name: c.name, cat: c.name, sub: '', subs: c.subs || [] };
  for (const c of cats) for (const x of c.subs || []) if (slug(x) === s) return { name: x, cat: c.name, sub: x, subs: [] };
  return null;
}
async function site(request, env, ctx, url) {
  if (url.hostname === 'www.mountainthrifters.com') return Response.redirect(SITE + url.pathname + url.search, 301);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/img/')) {
    await init(env);
    const row = await env.DB.prepare('SELECT type, bytes FROM images WHERE id = ?').bind(path.slice(5)).first();
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(row.bytes), { headers: { 'content-type': row.type, 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /bag\nDisallow: /checkout\nDisallow: /done\n\nSitemap: ' + SITE + '/sitemap.xml\n', { headers: { 'content-type': 'text/plain' } });
  if (path === '/sitemap.xml') {
    await init(env);
    const products = (await allProducts(request, env, ctx)).filter((p) => !p.sold && !p.sample);
    const cats = await categories(env);
    const urls = ['/', '/shop', '/sell', '/feed'].map((u) => [u, '']);
    for (const c of cats) { urls.push(['/c/' + slug(c.name), '']); for (const x of c.subs || []) urls.push(['/c/' + slug(x), '']); }
    for (const p of products) urls.push(['/p/' + encodeURIComponent(p.id), p.listedAt || '']);
    const seen = new Set();
    return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.filter((u) => !seen.has(u[0]) && seen.add(u[0])).map((u) => '  <url><loc>' + esc(SITE + u[0]) + '</loc>' + (u[1] ? '<lastmod>' + esc(u[1].slice(0, 10)) + '</lastmod>' : '') + '</url>').join('\n') +
      '\n</urlset>\n', { headers: { 'content-type': 'application/xml' } });
  }
  const isProduct = path.startsWith('/p/'), isCat = path.startsWith('/c/');
  if (!isProduct && !isCat && !(path in PAGES)) return env.ASSETS.fetch(request);
  // Every shop page is the same app shell, with the title, description and a
  // plain-HTML copy of the content written in for search engines and link previews.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url)));
  let title = '', desc = '', body = '', status = 200, image = SITE + '/icons/icon-512.png', noindex = false, ld = [];
  let products = [], cats = [];
  if (isProduct || isCat || path === '/' || path === '/shop') {
    await init(env);
    products = await allProducts(request, env, ctx);
    products = products.filter((p) => !p.sold).concat(products.filter((p) => p.sold));
    cats = await categories(env);
  }
  if (isProduct) {
    const id = decodeURIComponent(path.slice(3));
    const p = products.find((x) => x.id === id);
    if (p) {
      const img = p.photo ? (p.photo.startsWith('/') ? SITE + p.photo : p.photo) : '';
      const full = fullName(p);
      title = 'Thrifted ' + full + (p.size ? ', ' + p.size : '');
      desc = ['Thrifted ' + full, p.size || '', p.condition ? p.condition.toLowerCase() : '', rupees(p.price), 'One of one, shipped from Manali across India.'].filter(Boolean).join(', ');
      if (img) image = img;
      noindex = !!p.sample;
      const facts = [['Brand', p.brand], ['Size', p.size], ['Condition', p.condition], ['Category', [p.category, p.sub].filter(Boolean).join(' / ')], ['For', p.gender]].filter((r) => r[1]);
      body = '<p><a href="/shop">Shop</a>' + (p.category ? ' / <a href="/c/' + slug(p.category) + '">' + esc(p.category) + '</a>' : '') + (p.sub ? ' / <a href="/c/' + slug(p.sub) + '">' + esc(p.sub) + '</a>' : '') + '</p>' +
        '<h1>' + esc(full) + '</h1><p>' + rupees(p.price) + (p.sold ? ' (sold)' : '') + '</p>' + (img ? '<img src="' + esc(p.photo) + '" alt="' + esc(full) + '" width="600">' : '') +
        '<ul>' + facts.map((r) => '<li>' + r[0] + ': ' + esc(r[1]) + '</li>').join('') + '</ul>' + (p.description ? '<p>' + esc(p.description) + '</p>' : '') +
        '<p>One of one. Thrifted, checked by hand and shipped from Manali across India.</p>';
      ld.push({ '@context': 'https://schema.org', '@type': 'Product', name: full, image: img || undefined, description: desc, sku: p.id, category: [p.category, p.sub].filter(Boolean).join(' > ') || undefined,
        brand: { '@type': 'Brand', name: p.brand || 'The Mountain Thrifters' }, itemCondition: 'https://schema.org/UsedCondition',
        offers: { '@type': 'Offer', url: SITE + path, priceCurrency: 'INR', price: Number(p.price), itemCondition: 'https://schema.org/UsedCondition',
          availability: 'https://schema.org/' + (p.sold ? 'SoldOut' : 'InStock'), seller: { '@type': 'Organization', name: 'The Mountain Thrifters' } } });
      const crumbs = [['Shop', '/shop']].concat(p.category ? [[p.category, '/c/' + slug(p.category)]] : []).concat(p.sub ? [[p.sub, '/c/' + slug(p.sub)]] : []).concat([[full, path]]);
      ld.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c[0], item: SITE + c[1] })) });
    } else { status = 404; noindex = true; title = 'This piece is gone'; body = '<h1>This piece is gone</h1><p><a href="/shop">See what is still here.</a></p>'; }
  } else if (isCat) {
    const c = findCat(cats, path.slice(3));
    if (c) {
      const items = products.filter((p) => p.category === c.cat && (!c.sub || p.sub === c.sub));
      const low = c.name.toLowerCase();
      title = 'Thrifted ' + low + ' in India';
      desc = 'Shop thrifted ' + low + (c.subs.length ? ': ' + c.subs.join(', ').toLowerCase() : '') + '. One-of-one pieces from the brands you know, checked by hand and shipped from Manali across India.';
      body = '<p><a href="/shop">Shop</a>' + (c.sub ? ' / <a href="/c/' + slug(c.cat) + '">' + esc(c.cat) + '</a>' : '') + '</p><h1>Thrifted ' + esc(low) + '</h1><p>' + esc(desc) + '</p>' + listHtml(items) +
        (c.subs.length ? '<ul>' + c.subs.map((x) => '<li><a href="/c/' + slug(x) + '">' + esc(x) + '</a></li>').join('') + '</ul>' : '');
    } else { status = 404; noindex = true; title = 'Page not found'; body = '<h1>Page not found</h1><p><a href="/shop">Shop all gear.</a></p>'; }
  } else {
    title = PAGES[path][0]; desc = PAGES[path][1];
    if (path === '/') {
      body = '<h1>Thrifted outdoor gear from Manali, delivered across India</h1><p>' + esc(desc) + '</p><h2>Shop by category</h2>' + catLinks(cats) + '<h2>New in the gear room</h2>' + listHtml(products.slice(0, 12)) +
        '<p><a href="/shop">Shop all gear</a> · <a href="/sell">Sell your gear</a> · <a href="/feed">Instagram</a></p>';
      ld.push({ '@context': 'https://schema.org', '@type': 'Organization', name: 'The Mountain Thrifters', url: SITE, logo: SITE + '/icons/icon-512.png',
        description: desc, sameAs: ['https://www.instagram.com/mountain_thrifters/'], address: { '@type': 'PostalAddress', addressLocality: 'Manali', addressRegion: 'Himachal Pradesh', addressCountry: 'IN' },
        contactPoint: { '@type': 'ContactPoint', telephone: '+' + whatsapp(env), contactType: 'customer service', areaServed: 'IN' } });
      ld.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'The Mountain Thrifters', url: SITE });
    }
    if (path === '/shop') body = '<h1>Shop thrifted outdoor gear</h1><p>' + esc(desc) + '</p>' + catLinks(cats) + listHtml(products);
  }
  if (['/bag', '/checkout', '/done'].includes(path) || url.hostname !== 'mountainthrifters.com') noindex = true;
  const pageTitle = path === '/' ? 'The Mountain Thrifters · ' + title : title + ' · The Mountain Thrifters';
  const extra = '<link rel="canonical" href="' + esc(SITE + (path === '/' ? '/' : path)) + '">' + (noindex ? '<meta name="robots" content="noindex">' : '') +
    '<meta property="og:type" content="' + (isProduct ? 'product' : 'website') + '"><meta property="og:url" content="' + esc(SITE + path) + '"><meta property="og:title" content="' + esc(title) + '">' +
    (desc ? '<meta property="og:description" content="' + esc(desc) + '">' : '') + '<meta property="og:image" content="' + esc(image) + '"><meta property="og:locale" content="en_IN">' +
    '<meta name="twitter:card" content="' + (isProduct && image.indexOf('/icons/') < 0 ? 'summary_large_image' : 'summary') + '">' +
    ld.map((o) => '<script type="application/ld+json">' + JSON.stringify(o).replace(/</g, '\\u003c') + '</script>').join('');
  let rw = new HTMLRewriter().on('head', { element(e) { e.append(extra, { html: true }); } })
    .on('title', { element(e) { e.setInnerContent(pageTitle); } });
  if (desc) rw = rw.on('meta[name="description"]', { element(e) { e.setAttribute('content', desc); } });
  if (body) rw = rw.on('main#app', { element(e) { e.setInnerContent('<div class="wrap page">' + body + '</div>', { html: true }); } });
  return rw.transform(new Response(shell.body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith('/api/')) return await site(request, env, ctx, url);
      await init(env);
      if (url.pathname === '/api/products') return json(await allProducts(request, env, ctx));
      if (url.pathname === '/api/config') return json({ categories: await categories(env), whatsapp: whatsapp(env) });
      if (url.pathname === '/api/instagram') return json(await igPage(env, ctx, url.searchParams.get('after') || ''));
      if (url.pathname === '/api/order' && request.method === 'POST') return placeOrder(request, env, ctx);
      if (url.pathname.startsWith('/api/admin/')) return admin(request, env, url.pathname, ctx);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'server', message: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
  // Weekly: renew the Instagram token and keep the new one in the database.
  async scheduled(event, env, ctx) {
    await init(env);
    const token = await igToken(env);
    if (!token || !token.startsWith('IG')) return; // Facebook-login Page tokens do not expire
    const res = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
    if (!res.ok) return;
    const body = await res.json();
    if (body.access_token) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ig_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(body.access_token).run();
  },
};
