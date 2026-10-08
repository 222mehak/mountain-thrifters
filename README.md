# The Mountain Thrifters

The shop at mountainthrifters.com. A Cloudflare Worker serves the site, takes orders and keeps the stock, orders and categories in a D1 database.

- `public/index.html`: the shop (home, shop with filters, product, bag, checkout, sell, Instagram feed)
- `public/admin.html`: the owner app (add stock, orders, stock, categories, numbers). Open `/admin.html` on a phone and add it to the home screen.
- `public/products.json`: sample pieces, hidden from the owner app's Stock tab once real stock is up
- `public/photos/hero.jpg`: add this file to set the home page photo
- `src/worker.js`: the backend. Orders go to the WhatsApp number set near the top of this file.

See `SETUP.md` for the secrets (UPI, admin key, Telegram, email, Instagram).
