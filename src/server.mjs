import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const port = Number(process.env.PORT ?? 3000);
const trustedOrigin = process.env.TRUSTED_ORIGIN ?? 'https://pets-palace.nl';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const allowedEventTypes = new Set(['page_view', 'add_to_cart', 'begin_checkout', 'purchase']);

async function bootstrapSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracking_events (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'add_to_cart', 'begin_checkout', 'purchase')),
      source TEXT NOT NULL CHECK (source IN ('browser', 'shopify_webhook', 'shopify_pixel')),
      occurred_at TIMESTAMPTZ NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      order_id TEXT,
      attribution_id UUID,
      analytics_consent BOOLEAN NOT NULL DEFAULT false,
      marketing_consent BOOLEAN NOT NULL DEFAULT false,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS tracking_events_type_occurred_at_idx
      ON tracking_events (event_type, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS tracking_events_order_id_idx
      ON tracking_events (order_id) WHERE order_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      webhook_id UUID PRIMARY KEY,
      topic TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL REFERENCES tracking_events(event_id) ON DELETE CASCADE,
      destination TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at TIMESTAMPTZ,
      error_code TEXT,
      UNIQUE (event_id, destination)
    );
  `);
}

function sendJson(response, status, body, origin) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (origin === trustedOrigin) headers['Access-Control-Allow-Origin'] = trustedOrigin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid_json');
  }
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function cleanPayload(eventType, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  // Never accept arbitrary browser data. Shopify's paid-order webhook will have
  // its own HMAC-verified, explicitly mapped payload in a later phase.
  const allowedFields = {
    page_view: ['path', 'title'],
    add_to_cart: ['product_id', 'variant_id', 'quantity', 'currency', 'value'],
    begin_checkout: ['currency', 'value', 'item_count'],
  };
  const fields = allowedFields[eventType] ?? [];
  return Object.fromEntries(fields.flatMap((field) => (
    Object.hasOwn(value, field) ? [[field, value[field]]] : []
  )));
}

async function healthcheck() {
  await pool.query('SELECT 1');
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS' && url.pathname === '/v1/events' && origin === trustedOrigin) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': trustedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return response.end();
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    try {
      await healthcheck();
      return sendJson(response, 200, { ok: true }, origin);
    } catch {
      return sendJson(response, 503, { ok: false, service: 'database' }, origin);
    }
  }

  if (request.method === 'POST' && url.pathname === '/v1/events') {
    if (origin !== trustedOrigin) return sendJson(response, 403, { error: 'untrusted_origin' }, origin);
    try {
      const event = await readJson(request);
      const eventType = event.event_type;
      if (!allowedEventTypes.has(eventType) || eventType === 'purchase') {
        return sendJson(response, 422, { error: 'invalid_event_type' }, origin);
      }
      if (!isUuid(event.event_id)) return sendJson(response, 422, { error: 'invalid_event_id' }, origin);
      if (event.attribution_id && !isUuid(event.attribution_id)) return sendJson(response, 422, { error: 'invalid_attribution_id' }, origin);

      const occurredAt = new Date(event.occurred_at ?? Date.now());
      if (Number.isNaN(occurredAt.getTime())) return sendJson(response, 422, { error: 'invalid_occurred_at' }, origin);

      await pool.query(
        `INSERT INTO tracking_events
          (event_id, event_type, source, occurred_at, order_id, attribution_id, analytics_consent, marketing_consent, payload)
         VALUES ($1, $2, 'browser', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.event_id,
          eventType,
          occurredAt.toISOString(),
          typeof event.order_id === 'string' ? event.order_id.slice(0, 128) : null,
          event.attribution_id ?? null,
          event.consent?.analytics === true,
          event.consent?.marketing === true,
          cleanPayload(eventType, event.data),
        ],
      );
      return sendJson(response, 202, { accepted: true, event_id: event.event_id }, origin);
    } catch (error) {
      const knownError = error instanceof Error && ['payload_too_large', 'invalid_json'].includes(error.message);
      return sendJson(response, knownError ? 400 : 500, { error: knownError ? error.message : 'internal_error' }, origin);
    }
  }

  return sendJson(response, 404, { error: 'not_found', request_id: randomUUID() }, origin);
});

bootstrapSchema()
  .then(() => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`pets-palace-tracking listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error('Unable to initialise the tracking database', error);
    process.exit(1);
  });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await pool.end();
    server.close(() => process.exit(0));
  });
}
