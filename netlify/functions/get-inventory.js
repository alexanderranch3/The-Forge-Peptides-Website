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
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;

function nameToId(name) {
  const n = name.toLowerCase();

  // ── Blends first ─────────────────────────────────────────────────────────
  if (n.includes('klow'))                                                              return 'klow-blend';
  if (n.includes('glow'))                                                              return 'glow-blend';
  if (n.includes('phoenix') && (n.includes('12') || n.includes('new')))               return 'phoenix-blend-12-2';
  if (n.includes('phoenix'))                                                           return 'phoenix-blend';
  if (n.includes('tesamorelin') && n.includes('ipamorelin') && n.includes('12'))      return 'phoenix-blend-12-2';
  if (n.includes('tesamorelin') && n.includes('ipamorelin'))                          return 'phoenix-blend';
  if (n.includes('wolverine') && (n.includes('blend') || n.includes('5mg')))          return 'wolverine-blend-5mg';
  if (n.includes('wolverine'))                                                         return 'wolverine-stack';
  if (n.includes('cjc'))                                                               return 'cjc1295-ipamorelin';

  // ── Retatrutide — all sizes ───────────────────────────────────────────────
  if (n.includes('retatrutide') && n.includes('24'))                                  return 'retatrutide-24mg';
  if (n.includes('retatrutide') && n.includes('15'))                                  return 'retatrutide-15mg';
  if (n.includes('retatrutide') && n.includes('12'))                                  return 'retatrutide-12mg';
  if (n.includes('retatrutide') && n.includes('10'))                                  return 'retatrutide-10mg';
  if (n.includes('retatrutide'))                                                       return null;

  // ── Ipamorelin (standalone) ───────────────────────────────────────────────
  if (n.includes('ipamorelin'))                                                        return 'ipamorelin-10mg';

  // ── Individual peptides ───────────────────────────────────────────────────
  if (n.includes('tesamorelin'))                                                       return 'tesamorelin-10mg';
  if (n.includes('sermorelin'))                                                        return 'sermorelin-10mg';
  if (n.includes('mots-c') || n.includes('mots c'))                                   return 'mots-c-10mg';
  if ((n.includes('ghk-cu') || n.includes('ghk cu')) && n.includes('50'))             return 'ghk-cu-50mg';
  if (n.includes('ghk-cu') || n.includes('ghk cu'))                                   return 'ghk-cu-100mg';
  if (n.includes('ss-31') || n.includes('ss31') || n.includes('elamipretide'))        return 'ss-31-10mg';
  if (n.includes('semax') && n.includes('selank'))                                    return 'semax-selank';
  if (n.includes('semax'))                                                             return 'semax-10mg';
  if (n.includes('selank'))                                                            return 'selank-10mg';
  if (n.includes('dsip'))                                                              return 'dsip-5mg';
  if (n.includes('nad') && n.includes('1000'))                                        return 'nad-1000mg';
  if (n.includes('nad') && n.includes('100'))                                         return 'nad-100mg';
  if (n.includes('nad'))                                                               return 'nad-500mg';
  if (n.includes('melanotan'))                                                         return 'melanotan-ii-10mg';
  if (n.includes('bacteriostatic') || n.includes('bac water') || n.includes('reconstitution')) return 'reconstitution-liquid-30ml';

  return null;
}

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

      const name   = obj.item_data?.name || '';
      const itemId = nameToId(name);
      if (!itemId) continue;

      const variations = obj.item_data?.variations || [];
      let soldOut = false;
      let price   = null;

      for (const variation of variations) {
        const overrides = variation.item_variation_data?.location_overrides || [];
        const match     = overrides.find(o => o.location_id === LOCATION_ID);
        if (match?.sold_out === true) soldOut = true;

        // Price money is in cents; take the first variation with a real price.
        // Most items here are single-variation, so this is the item's price.
        if (price === null) {
          const amount = variation.item_variation_data?.price_money?.amount;
          if (typeof amount === 'number' && amount > 0) price = amount / 100;
        }
      }

      // Don't let a later, differently-named catalog item silently overwrite an
      // already-found sold-out/price pair for the same site id.
      if (!result[itemId]) result[itemId] = { soldOut: false, price: null };
      if (soldOut) result[itemId].soldOut = true;
      if (result[itemId].price === null) result[itemId].price = price;
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('get-inventory error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
