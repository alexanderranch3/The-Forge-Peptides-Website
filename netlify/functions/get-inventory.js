// Netlify Function: get-inventory.js
// Fetches Square catalog and returns a map of { data-item-id: true } for sold-out products.

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
    const soldOut = {};

    for (const obj of catalogItems) {
      if (obj.type !== 'ITEM') continue;

      const name   = obj.item_data?.name || '';
      const itemId = nameToId(name);
      if (!itemId) continue;

      const variations = obj.item_data?.variations || [];
      for (const variation of variations) {
        const overrides = variation.item_variation_data?.location_overrides || [];
        const match     = overrides.find(o => o.location_id === LOCATION_ID);
        if (match?.sold_out === true) {
          soldOut[itemId] = true;
          break;
        }
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
      body: JSON.stringify(soldOut),
    };
  } catch (err) {
    console.error('get-inventory error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
