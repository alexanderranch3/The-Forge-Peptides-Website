# The Forge Peptides — Site Reference
**Business:** Alexander Ranch LLC DBA The Forge Peptides  
**Last Updated:** June 7, 2026

---

## Hosting & Deployment
- **Platform:** Netlify (free tier, drag-and-drop deployment)
- **How to deploy:** Zip or drag the `forge-peptides-website/` folder into netlify.com/drop
- **Main file:** `index.html` (single-file static site — all HTML, CSS, and JS in one file)

---

## Checkout / Cart
- **Platform:** Snipcart v3.7.3
- **How it works:** Snipcart is embedded via a script tag in `index.html`. "Add to Cart" buttons use the class `snipcart-add-item` with `data-item-*` attributes (id, name, price, weight, description, url).
- **Shipping weight:** Each button has `data-item-weight` in kg for shipping calculation
- **Account:** Manage orders, shipping, and API key at snipcart.com

---

## Point of Sale / Inventory
- **Platform:** Square
- **Used for:** Syncing product prices to the website, checking stock/sold-out status
- **How prices were pulled:** Square MCP connector (UUID: e6c017c4-972f-4e27-a85b-86fdf23b424c) via Claude's Cowork mode
- **Out-of-stock detection:** `sold_out` flag in `location_overrides` on each Square catalog item variation

---

## Products on the Site

### Individual Peptides
| Product | Item ID | Price |
|---|---|---|
| Retatrutide 12mg | retatrutide-12mg | (from Square) |
| Sermorelin 10mg | sermorelin-10mg | (from Square) |
| Tesamorelin 10mg | tesamorelin-10mg | (from Square) |
| MOTS-C 10mg | mots-c-10mg | (from Square) |
| GHK-Cu 100mg | ghk-cu-100mg | (from Square) |
| SS-31 10mg | ss-31-10mg | (from Square) |
| Semax / Selank | semax-selank | (from Square) |
| DSIP 5mg | dsip-5mg | (from Square) |
| NAD+ 500mg | nad-500mg | (from Square) |
| Melanotan II 10mg | melanotan-ii-10mg | (from Square) |
| CJC-1295 No DAC / Ipamorelin 5mg/5mg | cjc1295-ipamorelin | (from Square) |
| Reconstitution Liquid (Bac Water 30ml) | reconstitution-liquid-30ml | $39 |

### Blends
| Blend | Item ID | Formula | Price |
|---|---|---|---|
| Wolverine Stack | wolverine-stack | BPC-157 10mg / TB-500 10mg | (from Square) |
| Wolverine Blend | wolverine-blend-5mg | BPC-157 5mg / TB-500 5mg | $100 |
| Phoenix Blend | phoenix-blend | Tesamorelin 10mg / Ipamorelin 5mg | (from Square) |
| Glow Blend | glow-blend | GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg | (from Square) |
| KLOW Blend | klow-blend | GHK-Cu 50mg / BPC-157 10mg / TB-500 10mg / KPV 10mg | (from Square) |

### Removed (out of stock in Square)
- Retatrutide 24mg
- Ipamorelin 10mg (standalone)
- NAD+ 1000mg

---

## Product Images
All vial images are in `forge-peptides-website/assets/`. The JS map `productImages` in `index.html` links each `data-item-id` to its image file. If an image isn't in the map, an SVG fallback renders automatically.

| Asset File | Product |
|---|---|
| retatrutide-vial.jpg | Retatrutide 12mg |
| sermorelin-vial.jpg | Sermorelin 10mg |
| tesamorelin-vial.jpg | Tesamorelin 10mg |
| mots-c-vial.jpg | MOTS-C 10mg |
| ghk-cu-vial.jpg | GHK-Cu 100mg |
| ss-31-vial.jpg | SS-31 10mg |
| semax-selank-vial.jpg | Semax / Selank |
| dsip-vial.jpg | DSIP 5mg |
| nad-500mg-vial.jpg | NAD+ 500mg |
| melanotan-ii-vial.jpg | Melanotan II 10mg |
| cjc1295-ipamorelin-vial.jpg | CJC-1295 No DAC / Ipamorelin |
| bac-water-30ml-vial.jpg | Reconstitution Liquid / Bac Water |
| wolverine-stack-vial.jpg | Wolverine Stack (10mg/10mg) |
| wolverine-stack-5mg-vial.jpg | Wolverine Blend (5mg/5mg) |
| phoenix-blend-vial.jpg | Phoenix Blend |
| glow-blend-vial.jpg | Glow Blend |
| klow-blend-vial.jpg | KLOW Blend |

---

## Compliance
All products are framed as **"For Research Use Only / Not for Human Consumption."** No health claims or human dosing instructions appear on the site.

---

## Tools Used in This Session
- **Claude Cowork mode** — built and edited the entire site, inserted images, synced Square pricing
- **Square MCP connector** — pulled live catalog pricing and stock status into Claude
- **Netlify** — static site hosting and deployment
- **Snipcart** — shopping cart and checkout
