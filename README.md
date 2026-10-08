# The Mountain Thrifters

The shop at mountainthrifters.com: storefront, on-site checkout with UPI, sold tracking,
order alerts, an owner admin page, Instagram feed and posting, and search-engine pages.
It runs on a Cloudflare Worker with a D1 database.

- `public/`        the shop (`index.html`) and the owner's page (`admin.html`)
- `src/worker.js`  the backend
- `wrangler.jsonc` Cloudflare settings
- `SETUP.md`       how to switch everything on, and how to run the shop day to day

Deployed from this repository by Cloudflare Workers Builds.
