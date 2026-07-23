# The Forge Peptides — Project Notes
**Business:** Alexander Ranch LLC DBA The Forge Peptides  
**Website:** https://theforgepeptides.com  
**Last Updated:** June 19, 2026

---

## Expenses
| Service | Cost | Notes |
|---------|------|-------|
| Netlify | $9/month | Hosting + Netlify Functions |

---

## Tech Stack
- **Frontend:** Static HTML/CSS/JS — `index.html`
- **Hosting:** Netlify — **GitHub-connected continuous deployment**: push to `main` on
  `alexanderranch3/The-Forge-Peptides-Website` auto-deploys (confirmed working since 2026-07-14,
  see `Runs/ship-a-change.md` in the vault). Manual `netlify deploy --prod` / drag-and-drop still
  work as a fallback but aren't the normal path anymore.
- **Backend:** Netlify Functions (Node.js) in `netlify/functions/`
- **Payments/Records:** Square API v2 (2024-01-18)
- **Customer Payment Method:** Zelle only — @forgepeptides

---

## File Structure
```
forge-peptides-website/
├── index.html                        # Main site + order form
├── admin.html                        # Password-gated order dashboard (see ADMIN_PASSWORD env var in Netlify)
├── netlify.toml                      # Build config (command="", publish=".")
├── sitemap.xml                       # Google indexing
├── robots.txt                        # Google indexing
├── PROJECT-NOTES.md                  # This file
└── netlify/
    └── functions/
        ├── create-invoice.js         # Square order + invoice creation
        ├── get-inventory.js          # Square catalog inventory sync
        ├── get-shipping-rates.js     # Shippo real-time USPS + UPS rates
        └── get-orders.js             # Admin dashboard — fetches Square invoices + orders
```

---

## Environment Variables (Netlify Dashboard ONLY — never in code)
| Variable | Where to Set |
|----------|-------------|
| `SQUARE_ACCESS_TOKEN` | Netlify → Site → Environment Variables |
| `SQUARE_LOCATION_ID` | Netlify → Site → Environment Variables |
| `SHIPPO_API_KEY` | Netlify → Site → Environment Variables (test token from apps.goshippo.com/settings/api) |

> ⚠️ Never paste these in chat or code. Revoke and reissue if ever exposed.

---

## Order System
- **Order form** built into `index.html` — replaces Snipcart
- **Fields:** First Name, Last Name, Email, Phone, Fulfillment, Shipping Address (street/city/state/ZIP), Promo Code, Notes
- **Fulfillment options:** Ship / Local Pickup
- **Shipping:** Dynamic real-time rates via Shippo (USPS + UPS), free over $300, free for Local Pickup. Flat $25 fallback if Shippo unavailable.
- **Promo codes:** `FORGE10` — 10% off first order only; `LOYAL10` — 10% off every order (no stacking)

### Order Flow
1. Customer fills out form → selects "Ship to My Address" → enters ZIP
2. Frontend auto-fetches rates from `get-shipping-rates.js` (Shippo API)
3. Customer sees USPS + UPS rate options → selects one
4. Customer clicks Place Order → `create-invoice.js` runs:
   - Finds or creates Square customer record
   - Validates promo code (FORGE10 first-order-only, LOYAL10 any order)
   - Creates Square order with line items + selected shipping amount
   - Creates Square invoice with `delivery_method: EMAIL`
   - Publishes invoice → Square emails receipt to customer
   - Adjusts Square inventory (SOLD)
5. Customer receives email receipt with Zelle-only payment instructions
6. Customer pays via Zelle @forgepeptides (memo = order number)
7. You confirm Zelle payment → buy label on Pirate Ship → ship

### Shipping Rate Logic
- Origin: ZIP 33184, weight 5oz (0.3125 lbs), package 6×4×3in
- Rates fetched from Shippo API when customer types a 5-digit ZIP
- Shows cheapest option pre-selected; customer can pick any USPS/UPS rate
- Free shipping applies if subtotal ≥ $300 (skips Shippo call)
- Flat $25 fallback if Shippo API unavailable

### Invoice Settings
- `accepted_payment_methods: { bank_account: true }` — satisfies Square API, deters card payments
- Invoice title: "The Forge Peptides — Order Receipt"
- Description prominently states: **Zelle @forgepeptides ONLY**, include order # in memo, orders don't ship until Zelle confirmed

---

## Inventory Sync (`get-inventory.js`)
- Fetches Square catalog every 5 minutes (cached)
- Maps Square item names → site `data-item-id` attributes
- Marks items as sold out if Square shows `sold_out: true`

### Name → ID Mapping
| Square Name Contains | Site ID |
|---------------------|---------|
| klow | klow-blend |
| glow | glow-blend |
| phoenix / tesamorelin+ipamorelin | phoenix-blend |
| wolverine blend/5mg | wolverine-blend-5mg |
| wolverine (other) | wolverine-stack |
| cjc | cjc1295-ipamorelin |
| ipamorelin (standalone) | ❌ discontinued |
| retatrutide 12mg | retatrutide-12mg |
| retatrutide (other) | ❌ discontinued |
| tesamorelin | tesamorelin-10mg |
| sermorelin | sermorelin-10mg |
| mots-c | mots-c-10mg |
| ghk-cu | ghk-cu-100mg |
| ss-31 / elamipretide | ss-31-10mg |
| semax / selank | semax-selank |
| dsip | dsip-5mg |
| nad | nad-500mg |
| melanotan | melanotan-ii-10mg |
| bacteriostatic / bac water | reconstitution-liquid-30ml |

---

## Deployment
**Normal path:** `git push origin main` — Netlify is GitHub-connected and auto-deploys on push.
Confirmed working since 2026-07-14.

**Fallback (CLI), if auto-deploy ever doesn't fire:**
```bash
cd ~/Desktop/forge-peptides-website && netlify deploy --prod
```
**Fallback (drag-and-drop):**
Go to https://app.netlify.com/projects/theforgepeptides/deploys → drag the `forge-peptides-website` folder

> Note: Netlify CLI has thrown `Forbidden` errors in the past. If that happens, use drag-and-drop.

---

## Google Search Console
- Submit `theforgepeptides.com` at https://search.google.com/search-console
- Request indexing so "The Forge Peptides" shows as the title (not the URL)
- sitemap.xml is at https://theforgepeptides.com/sitemap.xml

---

## Known Issues / Past Fixes
| Error | Fix |
|-------|-----|
| `A SCHEDULED pickup must have a pickup_at time` | Changed `schedule_type: 'SCHEDULED'` → `'ASAP'` |
| `An invoice must have at least 1 accepted payment method enabled` | Set `accepted_payment_methods: { bank_account: true }` |
| `accepted_payment_methods is required` | Cannot omit the field — must include it |
| Netlify CLI `Forbidden` | Use drag-and-drop deploy instead |
| `hugo: command not found` | netlify.toml with `command = ""` fixes this |
| LINE_ITEM discount errors | Use `scope: 'ORDER'` instead of `LINE_ITEM` |
| Fulfillment field errors in Square | Removed `fulfillments` array from order; put info in invoice description |

---

## Security Notes
- Two Netlify tokens were accidentally exposed in chat in the past (revoked — literal values
  scrubbed from this file 2026-07-22; they'd been sitting in git history since the initial
  commit, same exposure pattern as the old admin password)
- Always set credentials in Netlify dashboard → Environment Variables only
- Never paste Square Access Token or Netlify tokens in chat
