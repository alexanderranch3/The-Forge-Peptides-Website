// Netlify Function: get-shipping-rates.js
// Returns real-time USPS + UPS shipping rates via Shippo API.
// Origin: ZIP 33184 (Miami, FL)
// Package: ~5oz, standard small box

const SHIPPO_API = 'https://api.goshippo.com';
const TOKEN      = process.env.SHIPPO_API_KEY;

// Markup applied to all carrier rates before showing to customer.
// 1.20 = 20% markup on carrier rate + $3.00 flat handling fee.
const RATE_MARKUP   = 1.20;
const HANDLING_FEE  = 3.00;

// Package defaults — adjust if your typical package size changes
const PARCEL = {
  length:        '6',
  width:         '4',
  height:        '3',
  distance_unit: 'in',
  weight:        '0.3125', // 5oz = 0.3125 lbs
  mass_unit:     'lb',
};

const ADDRESS_FROM = {
  name:    'The Forge Peptides',
  street1: '8197 NW 8th St',
  city:    'Miami',
  state:   'FL',
  zip:     '33184',
  country: 'US',
};

// Carrier / service nicenames for display
const SERVICE_LABELS = {
  // USPS
  'usps_priority':                   'USPS Priority Mail',
  'usps_priority_express':           'USPS Priority Mail Express',
  'usps_first':                      'USPS First Class',
  'usps_parcel_select':              'USPS Parcel Select',
  'usps_ground_advantage':           'USPS Ground Advantage',
  // UPS
  'ups_ground':                      'UPS Ground',
  'ups_3_day_select':                'UPS 3-Day Select',
  'ups_second_day_air':              'UPS 2nd Day Air',
  'ups_second_day_air_am':           'UPS 2nd Day Air A.M.',
  'ups_next_day_air_saver':          'UPS Next Day Air Saver',
  'ups_next_day_air':                'UPS Next Day Air',
  'ups_next_day_air_early_am':       'UPS Next Day Air Early A.M.',
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  if (!TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'SHIPPO_API_KEY not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { zip, state, city, street } = body;

  if (!zip) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Destination ZIP is required.' }) };
  }

  const address_to = {
    street1: street || '123 Main St',
    city:    city   || '',
    state:   state  || '',
    zip,
    country: 'US',
  };

  try {
    // Create a Shippo shipment to get rates
    const shipmentRes = await fetch(`${SHIPPO_API}/shipments/`, {
      method: 'POST',
      headers: {
        'Authorization': `ShippoToken ${TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        address_from: ADDRESS_FROM,
        address_to,
        parcels:      [PARCEL],
        async:        false, // wait for rates synchronously
        carrier_accounts: [], // use all connected carriers
      }),
    });

    const shipment = await shipmentRes.json();

    if (!shipmentRes.ok || !shipment.rates) {
      console.error('Shippo error:', JSON.stringify(shipment));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch shipping rates.' }) };
    }

    // Filter and format rates — USPS and UPS only, exclude any with errors
    const rates = shipment.rates
      .filter(r => {
        const carrier = (r.provider || '').toLowerCase();
        const service = (r.servicelevel?.token || '').toLowerCase();
        // Only USPS and UPS
        if (!carrier.includes('usps') && !carrier.includes('ups')) return false;
        // Skip if no valid amount
        if (!r.amount || parseFloat(r.amount) <= 0) return false;
        return true;
      })
      .map(r => {
        const serviceToken = r.servicelevel?.token || '';
        const label = SERVICE_LABELS[serviceToken]
          || r.servicelevel?.name
          || `${r.provider} ${r.servicelevel?.name || ''}`.trim();

        const baseAmount   = parseFloat(r.amount);
        const markedUp     = Math.ceil((baseAmount * RATE_MARKUP + HANDLING_FEE) * 100) / 100; // round up to nearest cent

        return {
          id:            r.object_id,
          carrier:       r.provider,          // e.g. "USPS"
          service:       serviceToken,
          label,
          amount:        markedUp,
          currency:      r.currency,
          days:          r.estimated_days,
          arrives:       r.estimated_days
            ? `${r.estimated_days} business day${r.estimated_days !== 1 ? 's' : ''}`
            : null,
        };
      })
      // Sort by price ascending
      .sort((a, b) => a.amount - b.amount);

    if (rates.length === 0) {
      // Fallback: return flat rate if no carrier rates come back
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          rates: [{
            id:       'flat-rate',
            carrier:  'Standard',
            service:  'flat_rate',
            label:    'Standard Shipping',
            tag:      'best',
            amount:   25,
            currency: 'USD',
            days:     5,
            arrives:  '3-5 business days',
          }],
          fallback: true,
        }),
      };
    }

    // Show 3 rates to the customer:
    // 1. Best Rate  — cheapest option
    // 2. Standard   — mid-range (balances price and speed)
    // 3. Expedited  — fastest option
    const best = { ...rates[0], tag: 'best' };

    // Sort remaining by days ascending to find fastest
    const rest = rates
      .slice(1)
      .filter(r => r.days !== null)
      .sort((a, b) => (a.days || 99) - (b.days || 99));

    const shown = [best];

    if (rest.length === 1) {
      // Only one other option — label it expedited
      shown.push({ ...rest[0], tag: 'expedited' });
    } else if (rest.length >= 2) {
      // Pick the fastest as expedited
      const expedited = rest[0];
      // Pick the middle option as standard (between best and expedited in price/speed)
      const midOptions = rest.filter(r => r.id !== expedited.id);
      const standard   = midOptions[Math.floor(midOptions.length / 2)]; // pick from middle
      shown.push({ ...standard,  tag: 'standard'  });
      shown.push({ ...expedited, tag: 'expedited' });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ rates: shown }),
    };

  } catch (err) {
    console.error('get-shipping-rates error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
