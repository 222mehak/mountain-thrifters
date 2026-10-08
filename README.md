# The Mountain Thrifters: catalogue site

A static shop window. No monthly platform fee, no server, no database.
Customers browse, add pieces to a bag, and send their order to
@mountain_thrifters on Instagram. Payment is agreed in the chat (UPI).

## Files
- `index.html`    the whole site (design, pages, logic)
- `products.json` your stock. This is the only file you edit day to day
- `photos/`       product photos

## Add or change stock
Each piece is one block in `products.json`:

    {
      "id": 7,
      "name": "Colour-block ski jacket",
      "type": "jacket",
      "vibe": "Retro ski",
      "size": "M",
      "condition": "Barely worn",
      "price": 2400,
      "photo": "photos/jacket-7.jpg",
      "colors": ["#0C2714", "#C8FF2E"],
      "sold": false
    }

- `id`        a number you never reuse
- `type`      jacket, puffer, fleece or pants (only used for the drawing shown when there is no photo)
- `vibe`      Retro ski, Gorpcore, Puffers, or Trek and fleece
- `condition` Barely worn, Worn in, or Well loved
- `price`     rupees, digits only
- `photo`     path to a square-ish photo in `photos/`. Leave "" to show a drawing
- `sold`      set to true when it sells. It then shows as sold and cannot be ordered

The six pieces in the file now are SAMPLES. Replace them before you share the link.
Keep the commas and quotes exactly as shown: one mistake stops the list loading,
and the site then shows a message saying so.

## Put it live
1. Create a GitHub repository and upload these files.
2. Connect the repository to a static host and deploy. There is no build step.
3. Point your domain at it.
After that, every change you commit to `products.json` goes live in about a minute.
You can edit the file in the GitHub phone app or website.

Hosting note: check your host's free-plan terms before launch. Some free plans
(Vercel's Hobby plan, when this was written) are for non-commercial use only.

## What this version does not do
- Take payment on the site. Orders and payment happen in Instagram chat.
- Pull posts from Instagram automatically. The Instagram row links to the profile.
- Mark pieces sold by itself. Set `"sold": true` when something sells.
