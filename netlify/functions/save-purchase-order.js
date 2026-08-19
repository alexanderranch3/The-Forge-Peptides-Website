// ─────────────────────────────────────────────────────────────────────────────
// Netlify Function: save-purchase-order.js
// Added 2026-08-17 — the write side of the Purchasing tab.
//
// This function owns every WRITE the Purchasing tab makes. The name is kept
// for URL stability; read it as "purchasing writes".
//
// Four actions, all POST:
//   save        — create or update a PO and its complete line set (one transaction)
//   receive     — post the order: landed cost into variant_costs, stock into the
//                 ledger. ⚠️ ONE-WAY.
//   delete      — throw away a PO that has not been received
//   save-vendor — add or rename a supplier
//
// 🔑 Every one of these is a database function call, not SQL assembled here.
// The rules about what a valid PO is live in the database, so the page, a
// future POS and any import script are all held to the same ones. This file
// validates shape and types; the database validates meaning.
//
// ⚠️ RECEIVING IS ONE-WAY. stock_ledger's append-only trigger blocks UPDATE and
// DELETE, so a received PO cannot be un-received — receive_purchase_order()
// refuses to run twice rather than pretending to be idempotent. Correcting one
// means posting a visible RECOUNT/ADJUSTMENT.
//
// 🔐 Token-gated. Reads Supabase with the service-role key, server-side only.
// ─────────────────────────────────────────────────────────────────────────────

const { verifyToken } = require('./_auth-token');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIMEOUT_MS = 10000;

async function rpc(fn, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Postgres raise-exception messages are written for Frank, not for a log.
    // Surface them verbatim rather than burying them under a generic 500.
    let message;
    try { message = JSON.parse(body).message; } catch { /* not json */ }
    const err = new Error(message || `Supabase returned ${res.status}`);
    err.status = res.status === 404 ? 502 : 400;
    if (!message) err.detail = body.slice(0, 400);
    throw err;
  }
  return body ? JSON.parse(body) : null;
}

// Plain table write, used only for the vendor row. Everything with rules
// attached goes through a database function instead.
async function table(path, method, row) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res, body;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
      signal: controller.signal,
    });
    body = await res.text();
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let message;
    try {
      const j = JSON.parse(body);
      // 23505 = unique violation. vendors.name is unique, and "duplicate key
      // value violates unique constraint" is not a sentence anyone should read.
      message = j.code === '23505' ? 'A supplier with that name already exists' : j.message;
    } catch { /* not json */ }
    throw Object.assign(new Error(message || `Supabase returned ${res.status}`), { status: 400 });
  }
  return body ? JSON.parse(body) : null;
}

// ── Shape/type validation ────────────────────────────────────────────────────
// Money is integer cents end to end. A float here is a bug, not a convenience:
// 14.15 dollars cannot be represented exactly, and a fraction of a cent that
// survives into landed cost multiplies across every vial.
function asCents(v, label) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw Object.assign(new Error(`${label} must be a whole number of cents, not below zero`), { status: 400 });
  }
  return v;
}

function asCount(v, label, { min = 0 } = {}) {
  if (v === null || v === undefined || v === '') return min;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw Object.assign(new Error(`${label} must be a whole number of at least ${min}`), { status: 400 });
  }
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function asUuid(v, label, { required = false } = {}) {
  if (v === null || v === undefined || v === '') {
    if (required) throw Object.assign(new Error(`${label} is required`), { status: 400 });
    return null;
  }
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw Object.assign(new Error(`${label} is not a valid id`), { status: 400 });
  }
  return v;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function asDate(v, label) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE.test(v)) {
    throw Object.assign(new Error(`${label} must be a date like 2026-08-17`), { status: 400 });
  }
  return v;
}

const text = (v, max = 500) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
};

const STATES = ['DRAFT', 'ORDERED', 'CANCELED'];
const ALLOCATIONS = ['PER_UNIT', 'BY_VALUE'];

function buildPayload(input) {
  const state = input.state || 'DRAFT';
  if (!STATES.includes(state)) {
    // RECEIVED is excluded on purpose: it is reached only through the receive
    // action, which moves stock.
    throw Object.assign(new Error(`state must be one of ${STATES.join(', ')} — receiving happens through Receive`), { status: 400 });
  }
  const allocation = input.allocation || 'PER_UNIT';
  if (!ALLOCATIONS.includes(allocation)) {
    throw Object.assign(new Error(`allocation must be ${ALLOCATIONS.join(' or ')}`), { status: 400 });
  }

  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (lines.length > 200) {
    throw Object.assign(new Error('a purchase order cannot have more than 200 lines'), { status: 400 });
  }

  const payload = {
    id: asUuid(input.id, 'purchase order id'),
    vendor_id: asUuid(input.vendor_id, 'vendor', { required: true }),
    reference: text(input.reference, 120),
    state,
    ordered_on: asDate(input.ordered_on, 'order date'),
    shipping_cents: asCents(input.shipping_cents, 'shipping'),
    other_fees_cents: asCents(input.other_fees_cents, 'other fees'),
    other_fees_note: text(input.other_fees_note, 200),
    tax_cents: asCents(input.tax_cents, 'tax'),
    label_provider_id: asUuid(input.label_provider_id, 'label provider'),
    allocation,
    payment_method: text(input.payment_method, 60),
    notes: text(input.notes, 2000),
    lines: lines.map((l, i) => {
      const label = `line ${i + 1}`;
      const description = text(l.description, 300);
      if (!description) throw Object.assign(new Error(`${label} needs a description`), { status: 400 });
      return {
        variant_id: asUuid(l.variant_id, `${label} product`),
        supplier_sku: text(l.supplier_sku, 120),
        description,
        quantity: asCount(l.quantity, `${label} quantity`, { min: 1 }),
        unit_cost_cents: asCents(l.unit_cost_cents, `${label} unit cost`),
        free_quantity: asCount(l.free_quantity, `${label} free quantity`, { min: 0 }),
        notes: text(l.notes, 500),
      };
    }),
  };

  // Only forward a label rate when one was actually given. Omitting the key is
  // what tells the database "use the active provider's rate" — sending 0 would
  // silently record an order as having no labels at all.
  if (input.label_cost_cents !== null && input.label_cost_cents !== undefined && input.label_cost_cents !== '') {
    payload.label_cost_cents = asCents(input.label_cost_cents, 'label cost');
  }
  // QA/COA testing billed on the supplier invoice — counted in the invoice
  // total, never in a vial's cost. Same omit-means-keep rule as the label rate:
  // a client that has never heard of this field must not be able to erase a
  // real invoice line just by saving an unrelated edit.
  if (input.qa_fees_cents !== null && input.qa_fees_cents !== undefined && input.qa_fees_cents !== '') {
    payload.qa_fees_cents = asCents(input.qa_fees_cents, 'QA/COA fees');
  }
  if (input.qa_fees_note !== null && input.qa_fees_note !== undefined) {
    payload.qa_fees_note = text(input.qa_fees_note, 200);
  }
  return payload;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_TOKEN_SECRET not configured.' }) };
  }
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!verifyToken(SECRET, authHeader.replace(/^Bearer\s+/i, ''))) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({
        error: 'Supabase is not configured.',
        detail: 'Set SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify → Site settings → Environment variables, then redeploy.',
      }),
    };
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body is not valid JSON' }) };
  }

  const action = input.action || 'save';

  try {
    if (action === 'save') {
      const id = await rpc('save_purchase_order', { p: buildPayload(input) });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
    }

    if (action === 'receive') {
      const id = asUuid(input.id, 'purchase order id', { required: true });
      const when = asDate(input.received_on, 'received date');
      const rows = await rpc('receive_purchase_order', { p_po: id, p_when: when });
      const r = Array.isArray(rows) ? rows[0] : rows;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          received: { lines: Number(r?.lines ?? 0), units: Number(r?.units ?? 0) },
        }),
      };
    }

    if (action === 'delete') {
      const id = asUuid(input.id, 'purchase order id', { required: true });
      await rpc('delete_purchase_order', { p_po: id });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: id }) };
    }

    if (action === 'save-label-provider') {
      const name = text(input.name, 120);
      if (!name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A label provider needs a name' }) };
      }
      const id = await rpc('save_label_provider', {
        p: {
          id: asUuid(input.id, 'label provider id'),
          name,
          cost_per_unit_cents: asCents(input.cost_per_unit_cents, 'label cost'),
          is_active: input.is_active === true,
          notes: text(input.notes, 300),
        },
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id }) };
    }

    if (action === 'delete-label-provider') {
      const id = asUuid(input.id, 'label provider id', { required: true });
      await rpc('delete_label_provider', { p_id: id });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, deleted: id }) };
    }

    if (action === 'map-sold-line') {
      const name = text(input.name, 300);
      const variantId = asUuid(input.variant_id, 'product', { required: true });
      if (!name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Which sold name are you mapping?' }) };
      }
      const rows = await rpc('map_sold_line', { p_alias: name, p_variant: variantId });
      const r = Array.isArray(rows) ? rows[0] : rows;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          mapped: { lines: Number(r?.lines_mapped ?? 0), costed: Number(r?.lines_costed ?? 0) },
        }),
      };
    }

    if (action === 'unmap-sold-line') {
      const name = text(input.name, 300);
      if (!name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Which mapping are you undoing?' }) };
      }
      const n = await rpc('unmap_sold_line', { p_alias: name });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, restored: Number(n ?? 0) }) };
    }

    if (action === 'save-vendor') {
      const id = asUuid(input.id, 'vendor id');
      const name = text(input.name, 120);
      if (!name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'A supplier needs a name' }) };
      }
      // Pack size is the guard against the documented 10x error: Direct
      // Peptides quotes per box of 10, so a box price entered as a vial price
      // understates COGS by an order of magnitude.
      const pack = asCount(input.default_pack_size, 'vials per box', { min: 1 }) || 1;
      const row = { name, default_pack_size: pack };
      const vendor = await table(
        id ? `vendors?id=eq.${id}` : 'vendors',
        id ? 'PATCH' : 'POST',
        row,
      );
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, vendor: Array.isArray(vendor) ? vendor[0] : vendor }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown action "${action}"` }) };
  } catch (err) {
    const timedOut = err.name === 'AbortError';
    const msg = timedOut ? `Supabase timed out after ${TIMEOUT_MS}ms` : err.message;
    if (!err.status || err.status >= 500) console.error('save-purchase-order error:', msg);
    return {
      statusCode: timedOut ? 504 : (err.status || 500), headers,
      body: JSON.stringify({ error: msg, detail: err.detail }),
    };
  }
};
