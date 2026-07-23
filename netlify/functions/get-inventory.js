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
  // One Square item ("WOLVERINE BLEND") holds BOTH the 10/10 Stack and the 5/5
  // Blend as separate variations. Map by the size in the item+variation name, not
  // the item name (which always contains "blend") — otherwise the 10/10 variation's
  // price gets tagged onto the 5/5 site id. See the per-variation loop below.
  if (n.includes('wolverine')) {
    if (n.includes('10mg/10mg') || n.includes('10/10') || n.includes('(10mg'))        return 'wolverine-stack';
    if (n.includes('5mg/5mg')   || n.includes('5/5')   || n.includes('(5mg'))         return 'wolverine-blend-5mg';
    return null; // size not present in the name — don't guess
  }
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
