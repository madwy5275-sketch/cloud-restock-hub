# CLOUD Restock Hub

Shared restock / reorder board for CLOUD — Planning & Merch, Production and Fashion.
Static site (GitHub Pages) + Firebase (Google sign-in and Firestore database).

- `index.html` — the app
- `config.js` — Firebase web config and admin emails
- `firebase-shim.js`, `rh-boot.js` — sign-in and database connection
- `firestore.rules` — permissions (paste into Firebase → Firestore → Rules)
- `catalog.json`, `products.json` — styles and the SKU product list (a newer list can be uploaded in the app)
- `thumbs.json`, `thumbs/*.jpg` — product photos from cloud-clothing.co (refresh: `python3 tools/refresh_thumbs.py .`)

Access: admins (in `config.js` and `firestore.rules`) can do everything and assign each person's team in **Team access**.
