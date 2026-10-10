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
// The line across the top of the shop. The owner can change it in the app; a single dash hides it.
const DEFAULT_BANNER = 'Next Sourced Gear Drop: Sunday at 7 PM IST.';
async function bannerText(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'banner'").first();
  const v = row ? row.value : DEFAULT_BANNER;
  return v === '-' ? '' : v;
}
// The weekly drop: day of the week (0 = Sunday) and time, in India time.
const DEFAULT_DROP = { day: 0, hour: 19, minute: 0 };
async function dropRule(env) {
  try { const v = JSON.parse(await setting(env, 'drop')); if (v && v.day >= 0 && v.day <= 6 && v.hour >= 0 && v.hour <= 23) return { day: Number(v.day), hour: Number(v.hour), minute: Number(v.minute) || 0 }; } catch (e) { /* default */ }
  return DEFAULT_DROP;
}
function nextDrop(rule, from) {
  const ist = new Date((from || Date.now()) + 330 * 60000); // India time, read with getUTC*
  const t = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), rule.hour, rule.minute));
  t.setUTCDate(t.getUTCDate() + ((rule.day - ist.getUTCDay() + 7) % 7));
  if (t.getTime() <= ist.getTime()) t.setUTCDate(t.getUTCDate() + 7);
  return new Date(t.getTime() - 330 * 60000).toISOString();
}
// A piece shoppers cannot see yet: a draft, or lined up for a drop that has not happened.
const hidden = (p, now) => !!p.draft || (!!p.liveAt && p.liveAt > (now || new Date().toISOString()));
// Buy-more-save-more. Off until the owner turns it on.
async function bundleRule(env) {
  try { const v = JSON.parse(await setting(env, 'bundle')); if (v && v.on && v.n >= 2 && v.pct > 0 && v.pct <= 50) return { on: true, n: Number(v.n), pct: Number(v.pct) }; if (v) return { on: false, n: Number(v.n) || 2, pct: Number(v.pct) || 10 }; } catch (e) { /* off */ }
  return { on: false, n: 2, pct: 10 };
}
// Shipping charge: a flat fee below the free-shipping line. Fee 0 means "we confirm it on WhatsApp".
async function shipRule(env) {
  try { const v = JSON.parse(await setting(env, 'shipping')); if (v) return { fee: Number(v.fee) || 0, freeOver: Number(v.freeOver) || 0 }; } catch (e) { /* default */ }
  return { fee: 0, freeOver: 2000 };
}
const shipFor = (rule, amount) => (rule.fee > 0 && !(rule.freeOver > 0 && amount > rule.freeOver) ? rule.fee : 0);
// The policy pages. Kept here so the shop, search engines and payment providers all read the same words.
const EMAIL = 'orders@mountainthrifters.com', ADDRESS = 'Opposite HPWD Rest House, Mohal, Kullu, Himachal Pradesh, India';
async function policies(env) {
  const wa = whatsapp(env), phone = '+' + wa.slice(0, 2) + ' ' + wa.slice(2, 7) + ' ' + wa.slice(7), ship = await shipRule(env);
  const reach = '<a href="https://wa.me/' + wa + '">WhatsApp ' + phone + '</a> or <a href="mailto:' + EMAIL + '">' + EMAIL + '</a>';
  const free = ship.freeOver > 0 ? 'Shipping is free on orders over Rs ' + ship.freeOver.toLocaleString('en-IN') + '.' : '';
  const below = ship.fee > 0 ? 'we charge a flat Rs ' + ship.fee.toLocaleString('en-IN') + ' for shipping anywhere in India. You see it at checkout before you pay.' : 'shipping is charged at what it costs us to send from Manali to your pincode. We tell you the amount on WhatsApp before you pay.';
  return {
    contact: { title: 'Contact us', desc: 'How to reach The Mountain Thrifters: WhatsApp, phone, email and address.', html:
      '<p>We are a small shop run by two people, so you are always talking to one of us.</p>' +
      '<h2>WhatsApp or call</h2><p><a href="https://wa.me/' + wa + '">' + phone + '</a>. This is the fastest way to reach us.</p>' +
      '<h2>Email</h2><p><a href="mailto:' + EMAIL + '">' + EMAIL + '</a></p>' +
      '<h2>Address</h2><p>The Mountain Thrifters<br>Proprietor: Ankur Bodh<br>' + ADDRESS.replace(/, /g, '<br>') + '</p>' +
      '<h2>Instagram</h2><p><a href="https://www.instagram.com/mountain_thrifters/">@mountain_thrifters</a></p>' },
    shipping: { title: 'Shipping', desc: 'Shipping charges and delivery for orders from The Mountain Thrifters, sent from Manali across India.', html:
      '<p>Every order is packed by hand and sent from the Kullu-Manali valley. We ship across India.</p>' +
      '<h2>What it costs</h2><p>' + (free ? free + ' Below that, ' + below : below.charAt(0).toUpperCase() + below.slice(1)) + '</p>' +
      '<h2>When it ships</h2><p>We dispatch within 24 hours of your payment being confirmed, and message you on WhatsApp with the courier name and tracking number when it leaves.</p>' +
      '<h2>Delivery</h2><p>How long it takes depends on the courier and your pincode. Mountain roads and weather can add a day or two in winter. If your parcel seems stuck, message us and we will chase it.</p>' +
      '<h2>If something arrives damaged</h2><p>Send us a photo on WhatsApp the day it arrives and we will sort it out.</p>' +
      '<p>Questions: ' + reach + '.</p>' },
    returns: { title: 'Returns, refunds and cancellations', desc: 'Return any piece within 5 days of receiving it. How returns, refunds and cancellations work at The Mountain Thrifters.', html:
      '<h2>Returns</h2><p>If a piece is not right, you can return it within 5 days of receiving it.</p>' +
      '<ul><li>Message us on WhatsApp with your order number and tell us what is wrong.</li><li>We tell you where to send it. You pay for the return shipping.</li><li>Send it back as it arrived: unwashed, not worn beyond trying it on, with anything that came with it.</li></ul>' +
      '<h2>Refunds</h2><p>We refund what you paid for the piece right away, the day it gets back to us, to the same method you paid with. Your bank or UPI app can take a few days to show it.</p>' +
      '<h2>Cancellations</h2><p>You can cancel any time before your order ships. Message us on WhatsApp and we refund the full amount. Once it has shipped, it is handled as a return.</p>' +
      '<h2>Thrifted pieces</h2><p>Most of what we sell has been worn before. We describe the condition and show any flaws in the photos. If something you receive does not match the listing, tell us and we will make it right.</p>' +
      '<p>Reach us: ' + reach + '.</p>' },
    privacy: { title: 'Privacy', desc: 'What information The Mountain Thrifters collects, why, and how to have it removed.', html:
      '<p>We collect only what we need to sell and ship gear.</p>' +
      '<h2>What we collect</h2><ul><li><b>When you order:</b> your name, mobile number and delivery address.</li><li><b>When you sign up for drop alerts:</b> your name and WhatsApp number, plus your size, interest and email if you choose to add them.</li><li><b>When you offer gear or ask us to find something:</b> your name, WhatsApp number, what you wrote, and any photos you send.</li><li><b>When you browse:</b> we count how many times each piece is looked at or added to a bag. These counts are not linked to you.</li></ul>' +
      '<h2>How we use it</h2><p>To confirm and ship your order, to reply to you, and to send drop messages if you asked for them. Nothing else.</p>' +
      '<h2>Who sees it</h2><p>The two of us, the courier that delivers your parcel (name, phone and address), and the payment provider when you pay. We do not sell or rent your details to anyone.</p>' +
      '<h2>Payments</h2><p>Payments are handled by your UPI app or our payment provider. We never see or store your card or bank details.</p>' +
      '<h2>Removing your details</h2><p>To leave the alerts list or have your details deleted, message us: ' + reach + '.</p>' },
    terms: { title: 'Terms', desc: 'The terms for buying from The Mountain Thrifters.', html:
      '<p>These are the terms for buying from The Mountain Thrifters at mountainthrifters.com. The shop is run by Ankur Bodh, from Kullu, Himachal Pradesh.</p>' +
      '<h2>What we sell</h2><p>Outdoor gear, thrifted and new. Thrifted pieces have been worn before; we check each one by hand, describe its condition and show flaws in the photos. Most pieces are one of a kind, so once one sells it is gone.</p>' +
      '<h2>Prices and payment</h2><p>Prices are in Indian rupees. An order is confirmed once we have received your payment. Until then the piece is held for you for a short time and may be released if payment does not arrive.</p>' +
      '<h2>Shipping</h2><p>See our <a href="/shipping">shipping page</a>.</p>' +
      '<h2>Returns and refunds</h2><p>See our <a href="/returns">returns page</a>.</p>' +
      '<h2>Selling gear to us</h2><p>If you offer us gear, you confirm it is yours to sell. An offer from us is only final once we have seen the piece.</p>' +
      '<h2>Your details</h2><p>See our <a href="/privacy">privacy page</a>.</p>' +
      '<h2>The law</h2><p>These terms follow the laws of India.</p>' +
      '<p>Questions: ' + reach + '.</p>' },
  };
}
async function tg(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try { const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) }); return r.ok; } catch (e) { return false; }
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS guides (slug TEXT PRIMARY KEY, data TEXT, published INTEGER, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS subscribers (phone TEXT PRIMARY KEY, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, phone TEXT, status TEXT, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, phone TEXT, status TEXT, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS counters (id TEXT, kind TEXT, n INTEGER, PRIMARY KEY (id, kind))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, data TEXT, at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sourcing (id TEXT PRIMARY KEY, data TEXT, at TEXT)'),
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
  let auth = found ? { token: found.access_token, id: found.instagram_business_account.id, pageId: found.id } : null;
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
      // Posts made from the owner app carry the piece's address in the caption.
      product: ((p.caption || '').match(/\/p\/([A-Za-z0-9_-]+)/) || [])[1] || '',
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
  const now = new Date().toISOString();
  let mine = (own.results || []).map((r) => { const d = JSON.parse(r.data); return { ...d, listedAt: d.liveAt || r.at, addedAt: r.at }; });
  if (!priv) mine = mine.filter((p) => !hidden(p, now));
  mine.sort((a, b) => (a.listedAt < b.listedAt ? 1 : -1));
  list = mine.concat(list);
  let counts = null;
  if (priv) {
    counts = {};
    const c = await env.DB.prepare('SELECT id, kind, n FROM counters').all();
    for (const r of c.results || []) (counts[r.id] = counts[r.id] || {})[r.kind] = r.n;
  }
  try {
    const ig = await igPage(env, ctx, '');
    for (const p of ig.posts) { const prod = productFromPost(p); if (prod) list.push(prod); }
  } catch (e) { /* the shop still works without Instagram */ }
  const sold = await env.DB.prepare('SELECT product_id FROM sold').all();
  const gone = new Set((sold.results || []).map((r) => r.product_id));
  return list.map((p) => {
    const out = { ...p, id: String(p.id), sold: !!p.sold || gone.has(String(p.id)) };
    if (!priv) { for (const k of ['cost', 'source', 'by', 'igPending', 'igPosted', 'igResult', 'draft', 'liveAt', 'addedAt']) delete out[k]; }
    else { out.hidden = hidden(out, now); out.views = (counts[out.id] || {}).view || 0; out.bags = (counts[out.id] || {}).bag || 0; }
    return out;
  });
}

// ---------- Alerts ----------
async function notify(env, order) {
  const lines = order.items.map((i) => '- ' + i.name + (i.size ? ' (Size ' + i.size + ')' : '') + ' Rs ' + i.price);
  const text = 'New order ' + order.id + '\n' + lines.join('\n') + (order.discount ? '\n' + order.discountLabel + ': minus Rs ' + order.discount : '') + (order.shipping ? '\nShipping: Rs ' + order.shipping : '') + '\nTotal: Rs ' + order.total +
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
// Works out any money off: a discount code, or the buy-more offer. Whichever saves the customer more; never both.
async function moneyOff(env, raw, subtotal, count) {
  let off = 0, label = '', code = '', error = '';
  const b = await bundleRule(env);
  if (b.on && count >= b.n) { off = Math.round(subtotal * b.pct / 100); label = b.pct + '% off for ' + b.n + ' or more pieces'; }
  const typed = clean(raw, 24).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (typed) {
    const row = await env.DB.prepare('SELECT data FROM codes WHERE code = ?').bind(typed).first();
    const c = row ? JSON.parse(row.data) : null;
    if (!c) error = 'That code is not one of ours. Check the spelling.';
    else if (c.paused) error = 'That code is not running right now.';
    else if (c.ends && c.ends < new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10)) error = 'That code has ended.';
    else if (c.limit && (c.used || 0) >= c.limit) error = 'That code has been used up.';
    else if (c.min && subtotal < c.min) error = 'That code works on orders of Rs ' + c.min + ' or more.';
    else {
      const v = Math.min(subtotal, c.kind === 'flat' ? c.value : Math.round(subtotal * c.value / 100));
      if (v > off) { off = v; code = typed; label = 'Code ' + typed + (c.kind === 'flat' ? '' : ', ' + c.value + '% off'); }
    }
  }
  return { off, label, code, error };
}
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
    if (!p || p.hidden) return json({ error: 'unknown', message: 'One of these pieces is no longer listed.' }, 409);
    if (p.sold) return json({ error: 'sold', message: p.name + ' has just sold.', productId: id }, 409);
    items.push({ id: p.id, name: (p.brand ? p.brand + ' ' : '') + p.name, size: p.size || '', price: Number(p.price) || 0,
      brand: p.brand || '', category: p.category || '', cost: p.cost == null ? null : Number(p.cost), listedAt: p.listedAt || '' });
  }
  const subtotal = items.reduce((s, i) => s + i.price, 0);
  const deal = await moneyOff(env, body.code, subtotal, items.length);
  if (deal.error) return json({ error: 'code', message: deal.error }, 400);
  const shipping = shipFor(await shipRule(env), subtotal - deal.off);
  const total = subtotal - deal.off + shipping;
  // Share the money off across the pieces, so profit per piece stays right.
  if (deal.off) { let left = deal.off; items.forEach((i, n) => { const cut = n === items.length - 1 ? left : Math.round(deal.off * i.price / subtotal); left -= cut; i.paid = i.price - cut; }); }
  const id = 'MT' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  const at = new Date().toISOString();
  const order = { id, items, total, name, phone, pincode, city, address };
  if (shipping) order.shipping = shipping;
  if (deal.off) { order.subtotal = subtotal; order.discount = deal.off; order.discountLabel = deal.label; order.code = deal.code; }
  // One batch: if any piece was taken a moment ago, nothing is saved.
  const stmts = items.map((i) => env.DB.prepare('INSERT INTO sold (product_id, order_id, at) VALUES (?, ?, ?)').bind(i.id, id, at));
  stmts.push(env.DB.prepare('INSERT INTO orders (id, status, total, data, at) VALUES (?, ?, ?, ?, ?)').bind(id, 'awaiting payment', total, JSON.stringify(order), at));
  if (deal.code) {
    const row = await env.DB.prepare('SELECT data FROM codes WHERE code = ?').bind(deal.code).first();
    if (row) { const c = JSON.parse(row.data); c.used = (c.used || 0) + 1; stmts.push(env.DB.prepare('UPDATE codes SET data = ? WHERE code = ?').bind(JSON.stringify(c), deal.code)); }
  }
  try { await env.DB.batch(stmts); }
  catch (e) { return json({ error: 'sold', message: 'Someone bought one of these a moment ago. Your bag has been updated.' }, 409); }
  ctx.waitUntil(notify(env, order));
  return json({ orderId: id, total, shipping, discount: deal.off, discountLabel: deal.label, items: items.map((i) => ({ name: i.name, size: i.size, price: i.price })), upiId: env.UPI_ID || '', upiName: env.UPI_NAME || 'The Mountain Thrifters', whatsapp: whatsapp(env) });
}

// ---------- Admin ----------
function isAdmin(request, env) { return !!env.ADMIN_KEY && request.headers.get('x-admin-key') === env.ADMIN_KEY; }
const who = (request) => clean(request.headers.get('x-who'), 20);
const num = (v) => { const n = String(v == null ? '' : v).replace(/[^\d]/g, ''); return n === '' ? null : parseInt(n, 10); };
// The details of a piece, cleaned. With "only", just the ones that were sent (for edits).
function fields(body, only) {
  const all = {
    name: () => clean(body.name, 80), brand: () => clean(body.brand, 40), category: () => clean(body.category, 40), sub: () => clean(body.sub, 40), gender: () => clean(body.gender, 12),
    cost: () => num(body.cost),
    // Technical details: only what the owner entered, never guessed.
    waterproof: () => clean(body.waterproof, 30), weight: () => num(body.weight) || null,
    tech: () => (Array.isArray(body.tech) ? body.tech : []).map((x) => clean(x, 30)).filter(Boolean).slice(0, 10),
    tested: () => !!body.tested, testedLink: () => (/^https:\/\/(www\.)?instagram\.com\//.test(String(body.testedLink || '')) ? clean(body.testedLink, 200) : ''),
    size: () => clean(body.size, 20), condition: () => clean(body.condition, 20), description: () => clean(body.description, 600), source: () => clean(body.source, 20),
  };
  const out = {};
  for (const k of Object.keys(all)) if (!only || k in body) out[k] = all[k]();
  return out;
}
function photoRow(env, imgId, productId, dataUrl, max) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl));
  if (!m) return { error: 'One of the photos could not be read.' };
  const bin = atob(m[2]);
  if (bin.length > (max || 1500000)) return { error: 'One of the photos is too large.' };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { stmt: env.DB.prepare('INSERT OR REPLACE INTO images (id, product_id, type, bytes) VALUES (?, ?, ?, ?)').bind(imgId, productId, m[1], bytes), path: '/img/' + imgId };
}
// When a piece goes live: now, at the next drop, or kept as a draft.
async function setWhen(env, p, when) {
  const now = new Date().toISOString();
  if (when === 'draft') { p.draft = true; delete p.liveAt; }
  else if (when === 'drop') { p.draft = false; p.liveAt = nextDrop(await dropRule(env)); }
  else if (when === 'now') { if (p.draft || (p.liveAt && p.liveAt > now)) p.liveAt = now; p.draft = false; }
}
// New stock from the admin page. Photos arrive already shrunk by the browser.
async function addProduct(request, env, body) {
  const when = ['draft', 'drop'].includes(body.when) ? body.when : 'now';
  const price = num(body.price) || 0;
  const f = fields(body);
  if (when === 'draft') f.name = f.name || 'Draft piece';
  else if (!f.name || !price) return json({ error: 'details', message: 'Add a name and a price.' }, 400);
  const pics = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (!pics.length) return json({ error: 'details', message: 'Add at least one photo.' }, 400);
  const id = 'p' + Date.now().toString(36) + (body.n ? String(Number(body.n) % 36) : '');
  const stmts = [], photos = [];
  for (let n = 0; n < pics.length; n++) {
    const r = photoRow(env, id + '-' + n, id, pics[n]);
    if (r.error) return json({ error: 'details', message: r.error }, 400);
    stmts.push(r.stmt); photos.push(r.path);
  }
  const product = { id, ...f, price, photo: photos[0], photos, colors: [], sold: false, by: who(request) };
  await setWhen(env, product, when);
  // A copy of the first photo reshaped to a size Instagram accepts, when the original is too tall or wide.
  if (body.igImage) { const r = photoRow(env, id + '-ig', id, body.igImage, 1800000); if (r.stmt) { stmts.push(r.stmt); product.igPhoto = r.path; } }
  let instagram = 'not requested';
  const wait = hidden(product);
  if (body.postToInstagram && wait) { product.igPending = true; instagram = when === 'drop' ? 'will post when the drop goes live' : 'will post when you put it live'; }
  const at = new Date().toISOString();
  stmts.push(env.DB.prepare('INSERT INTO products (id, data, at) VALUES (?, ?, ?)').bind(id, JSON.stringify(product), at));
  await env.DB.batch(stmts);
  if (body.postToInstagram && !wait) {
    instagram = await igPublish(new URL(request.url).origin, env, product);
    if (/^posted/.test(instagram)) { product.igPosted = true; await env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(product), id).run(); }
  }
  return json({ ok: true, id, instagram, liveAt: product.liveAt || '', matches: wait ? [] : await matchesFor(env, product) });
}
// Changing a piece after it was added. Only what is sent gets changed.
async function updateProduct(request, env, body) {
  const id = String(body.id || '');
  const row = await env.DB.prepare('SELECT data FROM products WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'details', message: 'Only pieces added from this app can be changed.' }, 400);
  const p = JSON.parse(row.data), wasHidden = hidden(p), stmts = [];
  Object.assign(p, fields(body, true));
  if ('price' in body) {
    const price = num(body.price) || 0, old = Number(p.price) || 0;
    if (body.showWas === false) delete p.was;
    else if (price < old && old > 0) p.was = Math.max(Number(p.was) || 0, old);
    if (p.was && price >= p.was) delete p.was;
    p.price = price;
  }
  if (Array.isArray(body.photos)) {
    const keep = new Set(p.photos || []), next = [], stamp = Date.now().toString(36);
    for (let n = 0; n < Math.min(6, body.photos.length); n++) {
      const v = String(body.photos[n]);
      if (keep.has(v)) { next.push(v); continue; }
      const r = photoRow(env, id + '-' + stamp + n, id, v);
      if (r.error) return json({ error: 'details', message: r.error }, 400);
      stmts.push(r.stmt); next.push(r.path);
    }
    if (!next.length) return json({ error: 'details', message: 'Keep at least one photo.' }, 400);
    for (const gone of (p.photos || []).filter((x) => !next.includes(x))) stmts.push(env.DB.prepare('DELETE FROM images WHERE id = ?').bind(gone.slice(5)));
    if (next[0] !== p.photo && p.igPhoto) { stmts.push(env.DB.prepare('DELETE FROM images WHERE id = ?').bind(id + '-ig')); delete p.igPhoto; }
    p.photos = next; p.photo = next[0];
  }
  if (body.igImage) { const r = photoRow(env, id + '-ig', id, body.igImage, 1800000); if (r.stmt) { stmts.push(r.stmt); p.igPhoto = r.path; } }
  if (['now', 'drop', 'draft'].includes(body.when)) await setWhen(env, p, body.when);
  const wait = hidden(p);
  if (!p.draft && (!p.name || p.name === 'Draft piece' || !p.price)) return json({ error: 'details', message: 'Give it a name and a selling price before it goes on sale.' }, 400);
  if ('postToInstagram' in body && wait) p.igPending = !!body.postToInstagram;
  const post = !wait && (body.postToInstagram || (wasHidden && p.igPending));
  stmts.push(env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), id));
  await env.DB.batch(stmts);
  let instagram = 'not requested';
  if (post) {
    instagram = await igPublish(new URL(request.url).origin, env, p);
    p.igPending = false; if (/^posted/.test(instagram)) p.igPosted = true;
    await env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), id).run();
  } else if (wait && p.igPending) instagram = 'will post when it goes live';
  return json({ ok: true, id, instagram, liveAt: p.liveAt || '', matches: wasHidden && !wait ? await matchesFor(env, p) : [] });
}
// Open requests that look like this piece, so the owners can message those people first.
const SKIP = new Set(['looking', 'want', 'need', 'size', 'with', 'like', 'good', 'under', 'about', 'something', 'mountain', 'gear', 'thrifted', 'please', 'anything', 'that', 'this', 'have', 'from', 'some', 'your', 'for', 'and', 'the', 'any', 'one', 'new', 'old', 'men', 'women', 'mens', 'womens']);
const words = (v) => String(v || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !SKIP.has(w)).map((w) => w.replace(/s$/, ''));
async function matchesFor(env, p) {
  const rows = await env.DB.prepare("SELECT id, phone, data, at FROM requests WHERE status = 'open' ORDER BY at DESC LIMIT 500").all();
  const mine = new Set(words([p.brand, p.name, p.sub].join(' ')));
  const out = [];
  for (const r of rows.results || []) {
    const d = JSON.parse(r.data);
    const same = d.like && ((d.like.sub && d.like.sub === p.sub) || (!d.like.sub && d.like.category && d.like.category === p.category));
    const hit = words(d.what).filter((w) => mine.has(w));
    if (!same && !hit.length) continue;
    const sizeFits = !d.size || !p.size || d.size.toLowerCase().replace(/\s/g, '') === String(p.size).toLowerCase().replace(/\s/g, '');
    out.push({ id: r.id, phone: r.phone, name: d.name, what: d.what, size: d.size || '', sizeFits });
  }
  return out.sort((a, b) => Number(b.sizeFits) - Number(a.sizeFits)).slice(0, 30);
}
// Publishes the first photo to Instagram with a caption linking back to the piece.
async function igPublish(origin, env, product) {
  const auth = await igAuth(env);
  if (auth.error) return auth.error;
  const token = auth.token;
  // Captions always show the shop's own address, whichever address the owner app was opened from.
  const shop = env.SHOP_URL || 'mountainthrifters.com';
  const caption = (product.brand ? product.brand + ' ' : '') + product.name + '\n' + [product.size ? 'Size ' + product.size : '', product.condition, 'Rs ' + product.price.toLocaleString('en-IN')].filter(Boolean).join(' · ') +
    '\n\nTo buy: tap the link in our bio, then tap this photo.\n' + shop + '/p/' + product.id + '\n\n#thrifted #mountainthrifters #manali';
  try {
    const make = new URL(auth.base + '/' + auth.id + '/media');
    make.searchParams.set('image_url', origin + (product.igPhoto || product.photo));
    make.searchParams.set('caption', caption);
    make.searchParams.set('access_token', token);
    const a = await (await fetch(make, { method: 'POST' })).json();
    if (!a.id) return 'failed: ' + ((a.error && a.error.message) || 'Instagram did not accept the photo');
    const pub = new URL(auth.base + '/' + auth.id + '/media_publish');
    pub.searchParams.set('creation_id', a.id);
    pub.searchParams.set('access_token', token);
    const b = await (await fetch(pub, { method: 'POST' })).json();
    if (!b.id) return 'failed: ' + ((b.error && b.error.message) || 'Instagram did not publish the post');
    // Same photo and caption to the linked Facebook Page, when the token allows it.
    if (auth.pageId) {
      const fb = new URL(FB + '/' + auth.pageId + '/photos');
      fb.searchParams.set('url', origin + product.photo);
      fb.searchParams.set('caption', caption);
      fb.searchParams.set('access_token', token);
      const c = await (await fetch(fb, { method: 'POST' })).json().catch(() => ({}));
      return c.id ? 'posted, and on Facebook' : 'posted (Facebook Page: ' + ((c.error && c.error.message) || 'not posted') + ')';
    }
    return 'posted';
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
      sales.push({ name: i.name, brand: i.brand || p.brand || '', category: i.category || p.category || '', price: i.paid != null ? Number(i.paid) : Number(i.price) || 0, code: JSON.parse(r.data).code || '', off: i.paid != null ? Number(i.price) - Number(i.paid) : 0,
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
  const stock = products.filter((p) => !p.sold && !p.sample && !p.draft).map((p) => ({ price: Number(p.price) || 0, cost: p.cost != null ? p.cost : null, listedAt: p.listedAt || '', category: p.category || '' }));
  const watch = products.filter((p) => !p.sold && !p.sample && !p.hidden).sort((a, b) => b.views - a.views).slice(0, 8)
    .map((p) => ({ name: (p.brand ? p.brand + ' ' : '') + p.name, views: p.views, bags: p.bags, days: p.listedAt ? Math.floor((Date.now() - new Date(p.listedAt)) / 864e5) : 0 }));
  return json({ sales, pending, cancelled, stock, watch });
}

async function admin(request, env, path, ctx) {
  if (!isAdmin(request, env)) return json({ error: 'forbidden', message: 'Wrong admin key.' }, 403);
  if (path === '/api/admin/drop' && request.method === 'GET') { const rule = await dropRule(env); return json({ rule, next: nextDrop(rule) }); }
  if (path === '/api/admin/codes' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT code, data, at FROM codes ORDER BY at DESC').all();
    return json({ codes: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), code: r.code, at: r.at })), bundle: await bundleRule(env) });
  }
  if (path === '/api/admin/sourcing' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, data, at FROM sourcing ORDER BY at DESC LIMIT 500').all();
    return json({ trips: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), id: r.id })) });
  }
  if (path === '/api/admin/setup' && request.method === 'GET') return json({ telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), email: !!(env.RESEND_API_KEY && env.NOTIFY_EMAIL), upi: !!env.UPI_ID });
  if (path === '/api/admin/matches' && request.method === 'GET') {
    const row = await env.DB.prepare('SELECT data FROM products WHERE id = ?').bind(new URL(request.url).searchParams.get('id') || '').first();
    return json({ matches: row ? await matchesFor(env, JSON.parse(row.data)) : [] });
  }
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, status, total, data, at FROM orders ORDER BY at DESC LIMIT 1000').all();
    return json({ orders: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), status: r.status, at: r.at })) });
  }
  if (path === '/api/admin/products' && request.method === 'GET') return json({ products: await allProducts(request, env, ctx, true), hideSamples: (await setting(env, 'hide_samples')) === '1' });
  if (path === '/api/admin/stats' && request.method === 'GET') return stats(request, env, ctx);
  if (path === '/api/admin/requests' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, phone, status, data, at FROM requests ORDER BY at DESC LIMIT 500').all();
    return json({ requests: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), id: r.id, phone: r.phone, status: r.status, at: r.at })) });
  }
  if (path === '/api/admin/offers' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, phone, status, data, at FROM offers ORDER BY at DESC LIMIT 300').all();
    return json({ offers: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), id: r.id, phone: r.phone, status: r.status, at: r.at })) });
  }
  if (path === '/api/admin/alerts' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT phone, data, at FROM subscribers ORDER BY at DESC LIMIT 5000').all();
    return json({ people: (rows.results || []).map((r) => ({ ...JSON.parse(r.data), phone: r.phone, at: r.at })) });
  }
  if (path === '/api/admin/guides' && request.method === 'GET') {
    // The first time the owner opens Guides, two starter drafts are added for them to edit.
    if ((await setting(env, 'guides_seeded')) !== '1') {
      const at = new Date().toISOString();
      for (const g of GUIDE_DRAFTS) await env.DB.prepare('INSERT OR IGNORE INTO guides (slug, data, published, at) VALUES (?, ?, 0, ?)').bind(g.slug, JSON.stringify({ title: g.title, summary: g.summary, body: g.body }), at).run();
      await saveSetting(env, 'guides_seeded', '1');
    }
    return json({ guides: await guideList(env, true) });
  }
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
  if (path === '/api/admin/product-update') return updateProduct(request, env, body);
  if (path === '/api/admin/drop') {
    const rule = { day: Number(body.day), hour: Number(body.hour), minute: Number(body.minute) || 0 };
    if (!(rule.day >= 0 && rule.day <= 6 && rule.hour >= 0 && rule.hour <= 23 && rule.minute >= 0 && rule.minute <= 59)) return json({ error: 'details', message: 'Pick a day and a time.' }, 400);
    await saveSetting(env, 'drop', JSON.stringify(rule));
    // Pieces already lined up move to the new time.
    const next = nextDrop(rule), now = new Date().toISOString();
    const rows = await env.DB.prepare('SELECT id, data FROM products').all(), stmts = [];
    for (const r of rows.results || []) { const p = JSON.parse(r.data); if (!p.draft && p.liveAt && p.liveAt > now) { p.liveAt = next; stmts.push(env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), r.id)); } }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, rule, next });
  }
  if (path === '/api/admin/code') {
    const code = clean(body.code, 24).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const kind = body.kind === 'flat' ? 'flat' : 'percent', value = num(body.value) || 0;
    if (code.length < 3 || !value || (kind === 'percent' && value > 90)) return json({ error: 'details', message: 'Give the code a name of 3 or more letters and an amount. A percentage can be up to 90.' }, 400);
    const old = await env.DB.prepare('SELECT data, at FROM codes WHERE code = ?').bind(code).first();
    const data = { kind, value, min: num(body.min) || 0, limit: num(body.limit) || 0, ends: /^\d{4}-\d{2}-\d{2}$/.test(String(body.ends || '')) ? body.ends : '', note: clean(body.note, 80), paused: !!body.paused, used: old ? JSON.parse(old.data).used || 0 : 0 };
    await env.DB.prepare('INSERT INTO codes (code, data, at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data').bind(code, JSON.stringify(data), (old && old.at) || new Date().toISOString()).run();
    return json({ ok: true });
  }
  if (path === '/api/admin/code-delete') { await env.DB.prepare('DELETE FROM codes WHERE code = ?').bind(String(body.code)).run(); return json({ ok: true }); }
  if (path === '/api/admin/shipping') { await saveSetting(env, 'shipping', JSON.stringify({ fee: num(body.fee) || 0, freeOver: num(body.freeOver) || 0 })); return json({ ok: true }); }
  if (path === '/api/admin/bundle') {
    const n = num(body.n) || 2, pct = num(body.pct) || 0;
    if (body.on && (n < 2 || pct < 1 || pct > 50)) return json({ error: 'details', message: 'Use 2 or more pieces, and between 1 and 50 percent.' }, 400);
    await saveSetting(env, 'bundle', JSON.stringify({ on: !!body.on, n, pct })); return json({ ok: true });
  }
  if (path === '/api/admin/sourcing') {
    const id = clean(body.id, 20) || 't' + Date.now().toString(36);
    const data = { date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), where: clean(body.where, 80), spent: num(body.spent) || 0, pieces: num(body.pieces) || 0, note: clean(body.note, 300), by: who(request) };
    if (!data.where) return json({ error: 'details', message: 'Say where you sourced from.' }, 400);
    await env.DB.prepare('INSERT INTO sourcing (id, data, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').bind(id, JSON.stringify(data), data.date).run();
    return json({ ok: true, id });
  }
  if (path === '/api/admin/sourcing-delete') { await env.DB.prepare('DELETE FROM sourcing WHERE id = ?').bind(String(body.id)).run(); return json({ ok: true }); }
  if (path === '/api/admin/test-alert') {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json({ ok: false, message: 'Telegram is not set up yet.' });
    const ok = await tg(env, 'Test from The Mountain Thrifters owner app. Order alerts will arrive here.');
    return json({ ok, message: ok ? 'Sent. Check Telegram.' : 'Telegram did not accept it. Check the bot token and chat ID.' });
  }
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
  if (path === '/api/admin/guide') {
    const title = clean(body.title, 120); if (!title) return json({ error: 'details', message: 'Give the guide a title.' }, 400);
    const slugv = clean(body.slug, 80) || slug(title).slice(0, 80);
    const data = { title, summary: clean(body.summary, 240), body: String(body.body || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 20000) };
    const old = await env.DB.prepare('SELECT at FROM guides WHERE slug = ?').bind(slugv).first();
    await env.DB.prepare('INSERT INTO guides (slug, data, published, at) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, published = excluded.published')
      .bind(slugv, JSON.stringify(data), body.published ? 1 : 0, (old && old.at) || new Date().toISOString()).run();
    return json({ ok: true, slug: slugv });
  }
  if (path === '/api/admin/guide-delete') { await env.DB.prepare('DELETE FROM guides WHERE slug = ?').bind(String(body.slug)).run(); return json({ ok: true }); }
  if (path === '/api/admin/request-status') {
    const st = ['open', 'found', 'closed'].includes(body.status) ? body.status : '';
    if (!st || !body.id) return json({ error: 'bad_request' }, 400);
    await env.DB.prepare('UPDATE requests SET status = ? WHERE id = ?').bind(st, String(body.id)).run(); return json({ ok: true });
  }
  if (path === '/api/admin/request-delete') { await env.DB.prepare('DELETE FROM requests WHERE id = ?').bind(String(body.id)).run(); return json({ ok: true }); }
  if (path === '/api/admin/offer-status') {
    const st = ['new', 'replied', 'bought', 'passed'].includes(body.status) ? body.status : '';
    if (!st || !body.id) return json({ error: 'bad_request' }, 400);
    await env.DB.prepare('UPDATE offers SET status = ? WHERE id = ?').bind(st, String(body.id)).run(); return json({ ok: true });
  }
  if (path === '/api/admin/offer-delete') {
    await env.DB.batch([env.DB.prepare('DELETE FROM offers WHERE id = ?').bind(String(body.id)), env.DB.prepare('DELETE FROM images WHERE product_id = ?').bind(String(body.id))]); return json({ ok: true });
  }
  if (path === '/api/admin/alert-delete') { await env.DB.prepare('DELETE FROM subscribers WHERE phone = ?').bind(String(body.phone)).run(); return json({ ok: true }); }
  if (path === '/api/admin/banner') { await saveSetting(env, 'banner', clean(body.text, 140) || '-'); return json({ ok: true }); }
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
      env.DB.prepare('DELETE FROM counters WHERE id = ?').bind(String(body.id)),
    ]);
    return json({ ok: true });
  }
  if (path === '/api/admin/order-status') {
    const status = ['awaiting payment', 'paid', 'shipped', 'delivered', 'cancelled'].includes(body.status) ? body.status : '';
    if (!status || !body.id) return json({ error: 'bad_request' }, 400);
    const row = await env.DB.prepare('SELECT data FROM orders WHERE id = ?').bind(String(body.id)).first();
    if (!row) return json({ error: 'bad_request' }, 400);
    // Keep who did what, and the courier details once it ships.
    const o = JSON.parse(row.data);
    o.log = (o.log || []).concat([{ s: status, who: who(request), at: new Date().toISOString() }]).slice(-20);
    if (status === 'shipped') { o.courier = clean(body.courier, 40); o.tracking = clean(body.tracking, 60); }
    const stmts = [env.DB.prepare('UPDATE orders SET status = ?, data = ? WHERE id = ?').bind(status, JSON.stringify(o), String(body.id))];
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
// Guides are written as plain text: "## " starts a heading, "- " a list item, a blank line a new paragraph.
function guideHtml(text) {
  const out = []; let list = [], para = [];
  const flush = () => { if (para.length) { out.push('<p>' + esc(para.join(' ')) + '</p>'); para = []; } if (list.length) { out.push('<ul>' + list.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'); list = []; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) flush();
    else if (line.startsWith('## ')) { flush(); out.push('<h2>' + esc(line.slice(3)) + '</h2>'); }
    else if (line.startsWith('- ')) { if (para.length) flush(); list.push(line.slice(2)); }
    else { if (list.length) flush(); para.push(line); }
  }
  flush(); return out.join('');
}
async function guideList(env, all) {
  // One-time: put the two starter guides up as published, in the owners' voice.
  if ((await setting(env, 'guides_live_v1')) !== '1') {
    const at = new Date().toISOString();
    for (const g of GUIDE_DRAFTS) await env.DB.prepare('INSERT INTO guides (slug, data, published, at) VALUES (?, ?, 1, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, published = 1')
      .bind(g.slug, JSON.stringify({ title: g.title, summary: g.summary, body: g.body }), at).run();
    await saveSetting(env, 'guides_live_v1', '1'); await saveSetting(env, 'guides_seeded', '1');
  }
  const rows = await env.DB.prepare('SELECT slug, data, published, at FROM guides ORDER BY at DESC').all();
  return (rows.results || []).filter((r) => all || r.published).map((r) => ({ ...JSON.parse(r.data), slug: r.slug, published: !!r.published, at: r.at }));
}
const GUIDE_DRAFTS = [
  { slug: 'is-my-rain-jacket-still-waterproof', title: 'How to check if a used rain jacket is still waterproof', summary: 'Ten minutes, a tap and a t-shirt. Do this before you trust any jacket on a trek.',
    body: `Okay so here's the thing nobody tells you. A rain jacket can look brand new and still leak like a sieve. We've had jackets come in looking perfect that soaked through in two minutes. And we've had ugly beat-up ones that were bone dry inside.

So you can't tell by looking. You have to test it. Takes ten minutes.

## Flick water on it
Just wet your fingers and flick. Watch what the water does.

If it sits there in little round beads and rolls off, good sign. If the fabric goes dark and drinks it in, the coating on the outside is gone.

Don't panic if it fails this one. It's the easiest thing to fix. Wash it with a proper waterproof-gear cleaner, then put it in the dryer on low for 20 minutes. Heat wakes the coating back up. Still not beading? Get a reproofing spray. Sorted.

## Turn it inside out and look at the seams
Every seam should have a strip of tape over it, stuck down flat. Check the shoulders and the hood first because that's where rain hits hardest.

A bit of tape lifting at one corner, fine, you can glue that. Tape peeling off all over the place? That jacket is tired. Pass.

## Rub the inside
This is the big one. Rub the lining around the neck and shoulders with your thumb.

If white flaky bits come off, or it feels sticky, the waterproof layer itself is falling apart. There is no fixing this. We don't care how good the brand is or how cheap it's going. Walk away.

## The shower test
Feels silly, works every time. Put on a light coloured t-shirt, zip the jacket all the way up, hood on, and stand under the shower for five minutes.

Take it off. Any dark patches on your t-shirt are exactly where it leaks.

## That's it
Four checks. If a jacket passes all of them it will keep you dry, doesn't matter if it's ten years old.

We run these on the waterproof pieces before they go up on the site. If one needed its coating brought back to life, we'll say so in the listing. Got a jacket you're not sure about? Message us on WhatsApp with a photo of the inside and we'll tell you what we think.` },
  { slug: 'what-to-wear-in-manali-in-winter', title: 'What to wear in Manali in winter', summary: 'What actually keeps you warm here from December to February, from people who live in it.',
    body: `Every winter we watch the same thing happen. Someone gets off the Volvo in one giant puffy jacket, jeans and sneakers. By evening they're freezing and their feet are wet.

It's not that the jacket is bad. It's that one big layer doesn't work up here. You're cold outside, then you walk into a cafe with a bukhari going and you're boiling, and you've got nothing to take off.

Here's what works.

## Three thin layers beat one thick one
Next to your skin: a snug thermal, top and bottom. Wool or synthetic. Please not cotton. Cotton gets damp and stays damp and then you're cold all day.

In the middle: a fleece or a light down jacket. This is the layer doing the real work of keeping you warm.

On the outside: a shell that stops wind and snow. It doesn't have to be thick at all. It just has to block the wind.

Too warm? Take the middle one off. Getting cold? Put it back. That's the whole secret.

## Your feet matter more than your jacket
Mall Road is totally fine in sneakers. Right up until it ices over. Then it's a skating rink and you're the entertainment.

Get boots with a proper grip. Bring two pairs of wool socks so one can dry while you wear the other. Dry feet will keep you happier than the most expensive jacket.

## The small stuff everyone forgets
- A beanie that actually covers your ears
- Sunglasses. Snow glare up here is brutal, even when it's cloudy
- A buff or neck warmer. Weighs nothing, changes everything when the wind picks up
- Gloves you can still use your phone in
- Lip balm and sunscreen. Yes, in winter

## Going up to the snow?
Solang, Sissu, anywhere past the Atal Tunnel, it's a different level of cold and wind. Add waterproof pants and waterproof gloves.

Jeans in snow are soaked in ten minutes and frozen stiff in twenty. Ask us how we know.

## Landed here and packed wrong?
Happens to half the people who visit, so don't feel bad. Message us on WhatsApp, tell us what you're missing and your size, and we'll sort you out.` },
];

const slug = (v) => String(v).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const rupees = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN');
const PAGES = { '/': ['Thrifted outdoor gear from Manali, delivered across India', 'Thrifted jackets, puffers, trek boots, backpacks, tents and trek essentials from the brands you know. Thrifted and new, at fair prices, shipped from Manali across India.'],
  '/shop': ['Shop thrifted outdoor gear', 'Thrifted jackets, puffers, trek boots, backpacks, tents and trek essentials from the brands you know. Filter by brand, size and category. Delivered across India.'],
  '/sell': ['Sell your outdoor gear', 'Sell your jacket, boots, backpack, tent or bulk stock to The Mountain Thrifters. Get an offer and get paid by UPI.'],
  '/feed': ['Shop our Instagram', 'Tap any photo from @mountain_thrifters to buy that piece. Mountain gear, thrifted and new, shipped across India.'], '/request': ['Ask us to find it', 'Looking for a specific jacket, boot, pack or tent? Tell The Mountain Thrifters what you need and we will try to source it for you.'], '/alerts': ['Get drop alerts', 'Be first to see new mountain gear. Sign up and we will message you on WhatsApp before each drop.'], '/bag': ['Your bag', ''], '/checkout': ['Checkout', ''], '/done': ['Order placed', ''] };
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
    const urls = ['/', '/shop', '/sell', '/feed', '/contact', '/shipping', '/returns', '/privacy', '/terms'].map((u) => [u, '']);
    for (const c of cats) { urls.push(['/c/' + slug(c.name), '']); for (const x of c.subs || []) urls.push(['/c/' + slug(x), '']); }
    for (const p of products) urls.push(['/p/' + encodeURIComponent(p.id), p.listedAt || '']);
    const gl = await guideList(env, false);
    if (gl.length) urls.push(['/guides', '']);
    for (const g of gl) urls.push(['/guides/' + g.slug, g.at]);
    const seen = new Set();
    return new Response('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.filter((u) => !seen.has(u[0]) && seen.add(u[0])).map((u) => '  <url><loc>' + esc(SITE + u[0]) + '</loc>' + (u[1] ? '<lastmod>' + esc(u[1].slice(0, 10)) + '</lastmod>' : '') + '</url>').join('\n') +
      '\n</urlset>\n', { headers: { 'content-type': 'application/xml' } });
  }
  const isProduct = path.startsWith('/p/'), isCat = path.startsWith('/c/'), isGuide = path === '/guides' || path.startsWith('/guides/');
  const POL = ['/contact', '/shipping', '/returns', '/privacy', '/terms'], isPolicy = POL.includes(path);
  if (!isProduct && !isCat && !isGuide && !isPolicy && !(path in PAGES)) return env.ASSETS.fetch(request);
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
      const facts = [['Brand', p.brand], ['Size', p.size], ['Condition', p.condition], ['Category', [p.category, p.sub].filter(Boolean).join(' / ')], ['For', p.gender],
        ['Waterproofing', p.waterproof], ['Weight', p.weight ? p.weight + ' g' : ''], ['Built with', (p.tech || []).join(', ')], ['Manali-tested', p.tested ? 'Yes, worn and checked by us in Manali' : '']].filter((r) => r[1]);
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
  } else if (isPolicy) {
    await init(env);
    const pg = (await policies(env))[path.slice(1)];
    title = pg.title; desc = pg.desc; body = '<h1>' + esc(pg.title) + '</h1>' + pg.html;
  } else if (isGuide) {
    await init(env);
    const gl = await guideList(env, false);
    if (path === '/guides') {
      title = 'Mountain gear guides'; desc = 'Short, practical guides on buying, checking and packing outdoor gear for Manali and the Himalaya, from The Mountain Thrifters.';
      body = '<h1>Mountain gear guides</h1><p>' + esc(desc) + '</p><ul>' + gl.map((g) => '<li><a href="/guides/' + g.slug + '">' + esc(g.title) + '</a>: ' + esc(g.summary) + '</li>').join('') + '</ul>';
    } else {
      const g = gl.find((x) => x.slug === path.slice(8));
      if (g) {
        title = g.title; desc = g.summary;
        body = '<p><a href="/guides">Guides</a></p><h1>' + esc(g.title) + '</h1>' + guideHtml(g.body) + '<p><a href="/shop">Shop mountain gear</a></p>';
        ld.push({ '@context': 'https://schema.org', '@type': 'Article', headline: g.title, description: g.summary, datePublished: g.at, mainEntityOfPage: SITE + path,
          author: { '@type': 'Organization', name: 'The Mountain Thrifters' }, publisher: { '@type': 'Organization', name: 'The Mountain Thrifters', logo: { '@type': 'ImageObject', url: SITE + '/icons/icon-512.png' } } });
      } else { status = 404; noindex = true; title = 'Guide not found'; body = '<h1>Guide not found</h1><p><a href="/guides">See all guides.</a></p>'; }
    }
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
      if (url.pathname === '/api/guides') return json({ guides: (await guideList(env, false)).map((g) => ({ slug: g.slug, title: g.title, summary: g.summary, at: g.at, html: guideHtml(g.body) })) });
      if (url.pathname === '/api/config') { const b = await bundleRule(env); return json({ categories: await categories(env), whatsapp: whatsapp(env), notice: await bannerText(env), bundle: b.on ? { n: b.n, pct: b.pct } : null, shipping: await shipRule(env) }); }
      // Counts a look at a piece, or an add to a bag. No personal details are kept.
      if (url.pathname === '/api/track' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const kind = b.kind === 'bag' ? 'bag' : b.kind === 'view' ? 'view' : '', id = String(b.id || '');
        if (kind && /^p[a-z0-9]{4,20}$/.test(id)) await env.DB.prepare('INSERT INTO counters (id, kind, n) VALUES (?, ?, 1) ON CONFLICT(id, kind) DO UPDATE SET n = n + 1').bind(id, kind).run();
        return json({ ok: true });
      }
      // Checks a discount code against the bag before the order is placed.
      if (url.pathname === '/api/quote' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const ids = Array.isArray(b.items) ? [...new Set(b.items.map(String))].slice(0, 10) : [];
        const picked = (await allProducts(request, env, ctx)).filter((p) => ids.includes(p.id) && !p.sold);
        const subtotal = picked.reduce((t, p) => t + (Number(p.price) || 0), 0);
        const deal = await moneyOff(env, b.code, subtotal, picked.length);
        const shipping = shipFor(await shipRule(env), subtotal - deal.off);
        return json({ subtotal, off: deal.off, label: deal.label, code: deal.code, shipping, total: subtotal - deal.off + shipping, message: deal.error });
      }
      if (url.pathname === '/api/policy') { const pg = (await policies(env))[url.searchParams.get('p') || '']; return pg ? json({ title: pg.title, html: pg.html }) : json({ error: 'not_found' }, 404); }
      if (url.pathname === '/api/instagram') return json(await igPage(env, ctx, url.searchParams.get('after') || ''));
      if (url.pathname === '/api/order' && request.method === 'POST') return placeOrder(request, env, ctx);
      // A customer asking us to find something: either "one like this sold piece" or anything they describe.
      if (url.pathname === '/api/request' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const name = clean(b.name, 60), phone = clean(b.phone, 20).replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''), what = clean(b.what, 400);
        if (!name || phone.length !== 10 || !what) return json({ error: 'details', message: 'Add your name, a 10-digit WhatsApp number and what you are looking for.' }, 400);
        const day = new Date(Date.now() - 864e5).toISOString();
        const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM requests WHERE phone = ? AND at > ?').bind(phone, day).first();
        if (recent && recent.n >= 8) return json({ error: 'busy', message: 'You have sent a few already today. Message us on WhatsApp for the rest.' }, 429);
        let like = null;
        if (b.like) { const p = (await allProducts(request, env, ctx)).find((x) => x.id === String(b.like)); if (p) like = { id: p.id, name: (p.brand ? p.brand + ' ' : '') + p.name, category: p.category || '', sub: p.sub || '' }; }
        const id = 'r' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), at = new Date().toISOString();
        const data = { name, what, size: clean(b.size, 20), budget: clean(b.budget, 30), like };
        const stmts = [env.DB.prepare('INSERT INTO requests (id, phone, status, data, at) VALUES (?, ?, ?, ?, ?)').bind(id, phone, 'open', JSON.stringify(data), at)];
        if (b.alerts) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO subscribers (phone, data, at) VALUES (?, ?, ?)').bind(phone, JSON.stringify({ name, email: '', interest: like ? like.category : '', size: data.size }), at));
        await env.DB.batch(stmts);
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) ctx.waitUntil(fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: 'Gear request from ' + name + ' (' + phone + '): ' + what + (data.size ? ', size ' + data.size : '') }) }).catch(() => {}));
        return json({ ok: true });
      }
      // Someone offering gear to sell, with photos. Lands in the owners' app.
      if (url.pathname === '/api/sell' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const name = clean(b.name, 60), phone = clean(b.phone, 20).replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, ''), what = clean(b.what, 800);
        if (!name || phone.length !== 10 || !what) return json({ error: 'details', message: 'Add your name, a 10-digit WhatsApp number and a few words about the gear.' }, 400);
        const pics = Array.isArray(b.images) ? b.images.slice(0, 8) : [];
        const day = new Date(Date.now() - 864e5).toISOString();
        const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM offers WHERE phone = ? AND at > ?').bind(phone, day).first();
        if (recent && recent.n >= 5) return json({ error: 'busy', message: 'You have sent a few already today. Message us on WhatsApp for the rest.' }, 429);
        const id = 'o' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
        const stmts = [], photos = [];
        for (let n = 0; n < pics.length; n++) {
          const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(pics[n]));
          if (!m) continue;
          const bin = atob(m[2]); if (bin.length > 1500000) continue;
          const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          stmts.push(env.DB.prepare('INSERT INTO images (id, product_id, type, bytes) VALUES (?, ?, ?, ?)').bind(id + '-' + n, id, m[1], bytes));
          photos.push('/img/' + id + '-' + n);
        }
        const data = { name, city: clean(b.city, 60), kind: clean(b.kind, 60), what, asking: clean(b.asking, 40), photos };
        stmts.push(env.DB.prepare('INSERT INTO offers (id, phone, status, data, at) VALUES (?, ?, ?, ?, ?)').bind(id, phone, 'new', JSON.stringify(data), new Date().toISOString()));
        await env.DB.batch(stmts);
        const text = 'Gear offered for sale by ' + name + ' (' + phone + ')' + (data.city ? ', ' + data.city : '') + '\n' + what + '\n' + photos.length + ' photo(s). Open the owner app to see them.';
        const jobs = [];
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) jobs.push(fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) }));
        if (env.RESEND_API_KEY && env.NOTIFY_EMAIL) jobs.push(fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.RESEND_API_KEY },
          body: JSON.stringify({ from: env.EMAIL_FROM || 'The Mountain Thrifters <orders@mountainthrifters.com>', to: env.NOTIFY_EMAIL.split(',').map((x) => x.trim()), subject: 'Gear offered: ' + name, text }) }));
        ctx.waitUntil(Promise.allSettled(jobs));
        return json({ ok: true, id, photos: photos.length });
      }
      // Drop alerts sign-up: saved straight onto the list the owners see in their app.
      if (url.pathname === '/api/alerts' && request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const name = clean(b.name, 60), phone = clean(b.phone, 20).replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
        if (!name || phone.length !== 10) return json({ error: 'details', message: 'Add your name and a 10-digit WhatsApp number.' }, 400);
        if (!b.agree) return json({ error: 'details', message: 'Please tick the box so we know we can message you.' }, 400);
        const data = { name, email: /^\S+@\S+\.\S+$/.test(String(b.email || '')) ? clean(b.email, 120) : '', interest: clean(b.interest, 60), size: clean(b.size, 20) };
        const fresh = !(await env.DB.prepare('SELECT phone FROM subscribers WHERE phone = ?').bind(phone).first());
        await env.DB.prepare('INSERT INTO subscribers (phone, data, at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET data = excluded.data').bind(phone, JSON.stringify(data), new Date().toISOString()).run();
        if (fresh && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) ctx.waitUntil(fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: 'New drop-alerts sign-up: ' + name + ' ' + phone }) }).catch(() => {}));
        return json({ ok: true, whatsapp: whatsapp(env) });
      }
      if (url.pathname.startsWith('/api/admin/')) return admin(request, env, url.pathname, ctx);
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      return json({ error: 'server', message: 'Something went wrong on our side. Please try again.' }, 500);
    }
  },
  // Every ten minutes: post lined-up pieces whose drop time has come. Once a week: renew the Instagram token.
  async scheduled(event, env, ctx) {
    await init(env);
    if (event.cron !== '0 3 * * 1') {
      const now = new Date().toISOString();
      const rows = await env.DB.prepare('SELECT id, data FROM products').all();
      const live = (rows.results || []).map((r) => JSON.parse(r.data)).filter((p) => !p.draft && p.liveAt && p.liveAt <= now);
      // Tell the owners once when a drop goes up.
      const last = await setting(env, 'drop_seen');
      const fresh = live.filter((p) => p.liveAt > (last || now));
      if (!last) await saveSetting(env, 'drop_seen', now);
      else if (fresh.length) { await saveSetting(env, 'drop_seen', now); await tg(env, 'Your drop is live: ' + fresh.length + ' piece' + (fresh.length > 1 ? 's' : '') + ' just went up on the shop. Send the message to your alerts list.'); }
      for (const p of live.filter((x) => x.igPending).slice(0, 6)) {
        p.igResult = await igPublish(SITE, env, p);
        p.igPending = false; if (/^posted/.test(p.igResult)) p.igPosted = true;
        await env.DB.prepare('UPDATE products SET data = ? WHERE id = ?').bind(JSON.stringify(p), p.id).run();
      }
      return;
    }
    const token = await igToken(env);
    if (!token || !token.startsWith('IG')) return; // Facebook-login Page tokens do not expire
    const res = await fetch('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
    if (!res.ok) return;
    const body = await res.json();
    if (body.access_token) await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('ig_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(body.access_token).run();
  },
};
