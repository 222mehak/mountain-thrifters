# The Mountain Thrifters: full shop setup

What this version does
- Customers browse, add to bag and check out on the site, then pay by UPI.
- The moment an order is placed, its pieces show as sold for everyone else.
- You get a Telegram message and an email for every order.
- `/admin.html` lets the owner add stock from a phone, see orders, and mark payments.
- New stock can be posted to Instagram with one tick box.
- The Instagram feed shows on the site, and posts with a `Price:` line become products.
- Every product has its own page address, title and description for Google, plus a sitemap.

Files
- `public/index.html`   the shop
- `public/admin.html`   the owner's page
- `public/products.json` optional hand-edited stock (delete the SAMPLE pieces)
- `src/worker.js`       the backend
- `wrangler.jsonc`      Cloudflare settings

## Step 1. Create the database (2 minutes)
1. Cloudflare dashboard > Storage & Databases > D1 SQL Database > Create.
2. Name it `mountain-thrifters` and create it.
3. Copy its **Database ID**.
4. Open `wrangler.jsonc` and paste the ID over `PASTE-YOUR-D1-DATABASE-ID-HERE`.
The tables create themselves the first time the shop runs.

## Step 2. Put this folder on GitHub
Replace everything in your `mountain-thrifters` repository with the contents of this folder
(`public`, `src`, `wrangler.jsonc`, `.gitignore`, `SETUP.md`). `wrangler.jsonc` must be at the top level.

## Step 3. Connect the Worker to GitHub
1. Workers & Pages > odd-field-3683 > Settings > Build > Connect (Git repository).
2. Pick the repository. Deploy command: `npx wrangler deploy`. Leave the build command empty.
3. Save. Every commit now deploys by itself.
If your Worker has a different name, change `"name"` in `wrangler.jsonc` to match it exactly,
or your domain will not follow.

## Step 4. Add your settings
Workers & Pages > odd-field-3683 > Settings > Variables and Secrets > Add. Choose type **Secret** for each.

| Name | What to put |
|---|---|
| `UPI_ID` | the UPI ID customers pay, e.g. `name@bank` |
| `UPI_NAME` | the name shown in the UPI app |
| `ADMIN_KEY` | a long password you make up. It opens `/admin.html` |
| `TELEGRAM_BOT_TOKEN` | from step 5 |
| `TELEGRAM_CHAT_ID` | from step 5 |
| `RESEND_API_KEY` | from step 6 |
| `NOTIFY_EMAIL` | where order emails go. Several addresses: separate with commas |
| `IG_ACCESS_TOKEN` | from step 7 |

The shop works with only the first three. Alerts and Instagram switch on as you add the rest.

## Step 5. Telegram alerts (5 minutes)
1. In Telegram, message **@BotFather**, send `/newbot`, follow the prompts. Copy the token it gives you.
2. Create a Telegram group with the two of you, and add your new bot to it.
3. Send any message in the group.
4. In a browser open `https://api.telegram.org/bot<TOKEN>/getUpdates` (put your token in).
5. Find `"chat":{"id":` and copy the number, including the minus sign. That is `TELEGRAM_CHAT_ID`.

## Step 6. Email alerts
1. Create a free account at resend.com.
2. Add the domain `mountainthrifters.com`. It shows DNS records to add.
3. Add those records in Cloudflare > mountainthrifters.com > DNS > Records.
4. When Resend shows the domain as verified, create an API key. That is `RESEND_API_KEY`.

## Step 7. Instagram (feed, and posting new stock)
The account must be a Business or Creator account.
1. Go to developers.facebook.com and create a developer account and an app.
2. Add the **Instagram** product and choose **API setup with Instagram login**.
3. Add the @mountain_thrifters account and generate an access token for it. When asked for
   permissions, allow reading content and publishing content.
4. Copy the token into `IG_ACCESS_TOKEN`.
The shop renews this token by itself every week. Meta changes these screens often, so the
names may differ from what is written here.

## Daily use
- Add stock: open `mountainthrifters.com/admin.html`, enter the admin key, fill in the form, tap **Put it live**.
- When an order alert arrives: check the UPI payment came in, then tap **Payment received** in Orders.
- No payment after a while: tap **Cancel and relist** and the pieces go back on sale.
- Sold something in person or by DM: Stock tab > **Mark as sold**.

## Getting found on Google
1. Go to Google Search Console, add `mountainthrifters.com`, and verify it (the DNS method works with Cloudflare).
2. Submit the sitemap: `https://mountainthrifters.com/sitemap.xml`.
3. Write product names the way people search: "Columbia ski jacket", not "Blue one".

## Things to know
- Payment is not checked automatically. You confirm each UPI payment by hand.
- Photos are stored in the database, shrunk to about 200 KB each.
- Instagram posts use the first photo only.
- Anyone with the admin key can change stock and see customer details. Keep it private.
