// The Mountain Thrifters: shop backend.
// Serves the site, keeps track of what has sold, takes orders, sends alerts,
// and reads the Instagram feed. Settings come from the Worker's secrets:
//   UPI_ID, UPI_NAME            where customers pay
//   ADMIN_KEY                   password for /admin.html
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID      order alerts on Telegram
//   RESEND_API_KEY, NOTIFY_EMAIL, EMAIL_FROM  order alerts by email
//   IG_ACCESS_TOKEN             Instagram feed and post-to-product

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
async function igPage(env, ctx, after) {
  const token = await igToken(env);
  if (!token) return { posts: [], next: '' };
  const cacheKey = new Request('https://cache.local/ig?after=' + encodeURIComponent(after || ''));
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit.json();
  const u = new URL('https://graph.instagram.com/me/media');
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
  return { id: 'ig' + p.id, name: first.slice(0, 80), type: 'jacket', vibe: get('vibe'), size: get('size').toUpperCase().slice(0, 8),
    condition: get('condition'), price, photo: p.image, link: p.link, colors: [], sold: /sold/i.test(get('status')) };
}

// ---------- Products ----------
async function allProducts(request, env, ctx) {
  let list = [];
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
    if (res.ok) list = await res.json();
  } catch (e) { list = []; }
  // Stock added from the admin page, newest first.
  const own = await env.DB.prepare('SELECT data FROM products ORDER BY at DESC').all();
  list = (own.results || []).map((r) => JSON.parse(r.data)).concat(list);
  try {
    const ig = await igPage(env, ctx, '');
    for (const p of ig.posts) { const prod = productFromPost(p); if (prod) list.push(prod); }
  } catch (e) { /* the shop still works without Instagram */ }
  const sold = await env.DB.prepare('SELECT product_id FROM sold').all();
  const gone = new Set((sold.results || []).map((r) => r.product_id));
  return list.map((p) => ({ ...p, id: String(p.id), sold: !!p.sold || gone.has(String(p.id)) }));
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
  const products = await allProducts(request, env, ctx);
  const items = [];
  for (const id of ids) {
    const p = products.find((x) => x.id === id);
    if (!p) return json({ error: 'unknown', message: 'One of these pieces is no longer listed.' }, 409);
    if (p.sold) return json({ error: 'sold', message: p.name + ' has just sold.', productId: id }, 409);
    items.push({ id: p.id, name: p.name, size: p.size || '', price: Number(p.price) || 0 });
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
  return json({ orderId: id, total, upiId: env.UPI_ID || '', upiName: env.UPI_NAME || 'The Mountain Thrifters' });
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
  const product = { id, name, type: clean(body.type, 20) || 'jacket', vibe: clean(body.vibe, 40), size: clean(body.size, 8).toUpperCase(),
    condition: clean(body.condition, 20), price, description: clean(body.description, 600), photo: photos[0], photos, colors: [], sold: false };
  stmts.push(env.DB.prepare('INSERT INTO products (id, data, at) VALUES (?, ?, ?)').bind(id, JSON.stringify(product), new Date().toISOString()));
  await env.DB.batch(stmts);
  let instagram = 'not requested';
  if (body.postToInstagram) instagram = await igPublish(request, env, product);
  return json({ ok: true, id, instagram });
}
// Publishes the first photo to Instagram with a caption linking back to the piece.
async function igPublish(request, env, product) {
  const token = await igToken(env);
  if (!token) return 'not connected: add IG_ACCESS_TOKEN first';
  const origin = new URL(request.url).origin;
  const caption = product.name + '\n' + [product.size ? 'Size ' + product.size : '', product.condition, 'Rs ' + product.price.toLocaleString('en-IN')].filter(Boolean).join(' · ') +
    '\n\nOne of one. Shop it at ' + origin.replace(/^https?:\/\//, '') + '/p/' + product.id + '\n\n#thrifted #mountainthrifters #manali';
  try {
    const make = new URL('https://graph.instagram.com/me/media');
    make.searchParams.set('image_url', origin + product.photo);
    make.searchParams.set('caption', caption);
    make.searchParams.set('access_token', token);
    const a = await (await fetch(make, { method: 'POST' })).json();
    if (!a.id) return 'failed: ' + ((a.error && a.error.message) || 'Instagram did not accept the photo');
    const pub = new URL('https://graph.instagram.com/me/media_publish');
    pub.searchParams.set('creation_id', a.id);
    pub.searchParams.set('access_token', token);
    const b = await (await fetch(pub, { method: 'POST' })).json();
    return b.id ? 'posted' : 'failed: ' + ((b.error && b.error.message) || 'Instagram did not publish the post');
  } catch (e) { return 'failed: could not reach Instagram'; }
}

async function admin(request, env, path, ctx) {
  if (!isAdmin(request, env)) return json({ error: 'forbidden', message: 'Wrong admin key.' }, 403);
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, status, total, data, at FROM orders ORDER BY at DESC LIMIT 200').all();
    return json({ orders: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), status: r.status, at: r.at })) });
  }
  if (path === '/api/admin/products' && request.method === 'GET') return json({ products: await allProducts(request, env, ctx) });
  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
  const body = await request.json().catch(() => ({}));
  if (path === '/api/admin/product') return addProduct(request, env, body);
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
const PAGES = { '/': null, '/shop': ['Shop thrifted ski and snow wear', 'Browse one-of-one thrifted ski jackets, snow pants, puffers and fleece. Delivered across India.'],
  '/sell': ['Sell your snow gear', 'Sell your ski jacket, snow pants or bulk stock to The Mountain Thrifters. Get an offer and get paid by UPI.'],
  '/feed': ['Instagram feed', 'The latest thrifted finds from @mountain_thrifters.'], '/bag': ['Your bag', ''], '/checkout': ['Checkout', ''] };
async function site(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/img/')) {
    await init(env);
    const row = await env.DB.prepare('SELECT type, bytes FROM images WHERE id = ?').bind(path.slice(5)).first();
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(row.bytes), { headers: { 'content-type': row.type, 'cache-control': 'public, max-age=31536000, immutable' } });
  }
  if (path === '/robots.txt') return new Response('User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /admin\nDisallow: /bag\nDisallow: /checkout\n\nSitemap: ' + url.origin + '/sitemap.xml\n', { headers: { 'content-type': 'text/plain' } });
  if (path === '/sitemap.xml') {
    await init(env);
    const products = await allProducts(request, env, ctx);
    const urls = ['/', '/shop', '/sell', '/feed'].concat(products.filter((p) => !p.sold).map((p) => '/p/' + encodeURIComponent(p.id)));
    return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map((u) => '  <url><loc>' + esc(url.origin + u) + '</loc></url>').join('\n') + '\n</urlset>\n', { headers: { 'content-type': 'application/xml' } });
  }
  const isProduct = path.startsWith('/p/');
  if (!isProduct && !(path in PAGES)) return env.ASSETS.fetch(request);
  // Every shop page is the same app shell, with the title and description
  // written into the HTML so search engines and link previews read them.
  const shell = await env.ASSETS.fetch(new Request(new URL('/', url)));
  let title = '', desc = '', extra = '<link rel="canonical" href="' + esc(url.origin + (path === '/' ? '/' : path)) + '">';
  if (isProduct) {
    await init(env);
    const id = decodeURIComponent(path.slice(3));
    const p = (await allProducts(request, env, ctx)).find((x) => x.id === id);
    if (p) {
      const img = p.photo ? (p.photo.startsWith('/') ? url.origin + p.photo : p.photo) : '';
      title = p.name + (p.size ? ', size ' + p.size : '');
      desc = ['Thrifted ' + p.name, p.size ? 'size ' + p.size : '', p.condition ? p.condition.toLowerCase() : '', 'Rs ' + Number(p.price).toLocaleString('en-IN'), 'One of one, delivered across India.'].filter(Boolean).join(', ');
      extra += '<meta property="og:type" content="product"><meta property="og:title" content="' + esc(title) + '"><meta property="og:description" content="' + esc(desc) + '">' +
        (img ? '<meta property="og:image" content="' + esc(img) + '">' : '') +
        '<script type="application/ld+json">' + JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, image: img || undefined, description: desc,
          brand: { '@type': 'Brand', name: 'The Mountain Thrifters' }, itemCondition: 'https://schema.org/UsedCondition',
          offers: { '@type': 'Offer', url: url.origin + path, priceCurrency: 'INR', price: Number(p.price), availability: 'https://schema.org/' + (p.sold ? 'SoldOut' : 'InStock') } }).replace(/</g, '\\u003c') + '</script>';
    }
  } else if (PAGES[path]) { title = PAGES[path][0]; desc = PAGES[path][1]; }
  if (path === '/bag' || path === '/checkout') extra += '<meta name="robots" content="noindex">';
  let rw = new HTMLRewriter().on('head', { element(e) { e.append(extra, { html: true }); } });
  if (title) rw = rw.on('title', { element(e) { e.setInnerContent(title + ' · The Mountain Thrifters'); } });
  if (desc) rw = rw.on('meta[name="description"]', { element(e) { e.setAttribute('content', desc); } });
  return rw.transform(new Response(shell.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith('/api/')) return await site(request, env, ctx, url);
      await init(env);
      if (url.pathname === '/api/products') return json(await allProducts(request, env, ctx));
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
    if (!token) return;
    const res = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
    if (!res.ok) return;
    const body = await res.json();
    if (body.access_token) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ig_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(body.access_token).run();
  },
};
