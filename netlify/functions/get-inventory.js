// Netlify Function: get-inventory.js
// Added 2026-07-22 (Round 2 — price-list sync): previously this only returned sold-out
// flags. The site's displayed prices (product cards + the reference price-list table)
// were static HTML, so whenever a price changed in Square, the site quietly drifted out
// of sync until someone manually caught and fixed it. Now the same live Square fetch this
// function already does also returns each item's current price, and the frontend
// (syncInventory() in index.html) overwrites every displayed price from this on load —
// so the site can't drift from Square again for any item Square actually has under a
// recognized name. New products still need one manual line added (see nameToId below);
// this only prevents EXISTING items from silently going stale.
//
// Response shape: { [itemId]: { soldOut: boolean, price: number|null } }
// (was: { [itemId]: true } for sold-out items only — frontend updated to match.)

const SQUARE_API  = 'https://connect.squareup.com/v2';
const TOKEN       = process.env.SQUARE_ACCESS_TOKEN;
const { nameToId } = require('./_catalog-map');
const { stockSource, fetchStock } = require('./_stock');

const LOCATION_ID = process.env.SQUARE_LOCATION_ID;


async function fetchAllCatalogItems() {
  const items = [];
  let cursor = null;

  do {
    const url = `${SQUARE_API}/catalog/list?types=ITEM${cursor ? `&cursor=${cursor}` : ''}`;
    const res  = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Square-Version': '2024-01-18',
      },
    });
    const data = await res.json();
    if (data.objects) items.push(...data.objects);
    cursor = data.cursor || null;
  } while (cursor);

  return items;
}

exports.handler = async () => {
  if (!TOKEN || !LOCATION_ID) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Missing Square environment variables.' }),
    };
  }

  try {
    const catalogItems = await fetchAllCatalogItems();
    const result = {};

    for (const obj of catalogItems) {
      if (obj.type !== 'ITEM') continue;

      const itemName   = obj.item_data?.name || '';
      const variations = obj.item_data?.variations || [];

      // Map at the VARIATION level: a single Square item can hold multiple
      // variations that belong to different site ids (e.g. the Wolverine 10/10
      // Stack and 5/5 Blend), each with its own price. Matching on item+variation
      // name assigns each variation's price to the correct site id.
      for (const variation of variations) {
        const varName = variation.item_variation_data?.name || '';
        const itemId  = nameToId(`${itemName} ${varName}`);
        if (!itemId) continue;

        const overrides = variation.item_variation_data?.location_overrides || [];
        const match     = overrides.find(o => o.location_id === LOCATION_ID);
        const soldOut   = match?.sold_out === true;

        // Price money is in cents.
        const amount = variation.item_variation_data?.price_money?.amount;
        const price  = (typeof amount === 'number' && amount > 0) ? amount / 100 : null;

        // Don't let a later variation/item silently overwrite an already-found
        // sold-out flag or price for the same site id.
        if (!result[itemId]) result[itemId] = { soldOut: false, price: null };
        if (soldOut) result[itemId].soldOut = true;
        if (result[itemId].price === null && price !== null) result[itemId].price = price;
      }
    }

    // ── Stock source ─────────────────────────────────────────────────────────
    // Added 2026-08-17. Square's sold_out flag is binary and only moves when its
    // count crosses zero — the storefront could never tell 1 vial from 100, and
    // Square only knows about stock that passed through Square.
    //
    // With STOCK_SOURCE=dashboard the real counts decide instead, and the
    // response carries the actual number so the page can say "only 2 left".
    //
    // 🔑 FAILS OPEN. If the dashboard cannot answer, or has never heard of a
    // product, that product keeps whatever Square said. A reporting outage must
    // never paint a sold-out sign over stock you actually have — a false
    // "sold out" is a lost sale nobody ever hears about.
    let source = 'square';
    if (stockSource() === 'dashboard') {
      const stock = await fetchStock();
      if (stock) {
        source = 'dashboard';
        for (const [id, entry] of Object.entries(stock)) {
          if (!result[id]) continue;              // not sold on the site
          result[id].onHand  = entry.on_hand;
          result[id].soldOut = entry.on_hand <= 0;
        }
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // Shorter once real counts drive the page: a stale sold-out flag was
        // merely untidy, a stale COUNT gets quoted back to a customer.
        'Cache-Control': source === 'dashboard' ? 'public, max-age=60' : 'public, max-age=300',
      },
      body: JSON.stringify({ ...result, _source: source }),
    };
  } catch (err) {
    console.error('get-inventory error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
