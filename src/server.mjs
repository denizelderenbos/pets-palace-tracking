import http from 'node:http';
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, randomUUID, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';

const port = Number(process.env.PORT ?? 3000);
const trustedOrigin = process.env.TRUSTED_ORIGIN ?? 'https://pets-palace.nl';
const databaseUrl = process.env.DATABASE_URL;
const shopifyWebhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
const shopifyShopDomain = process.env.SHOPIFY_SHOP_DOMAIN ?? 'pets-palace-eu.myshopify.com';
const workloadIdentityIssuer = process.env.WORKLOAD_IDENTITY_ISSUER ?? 'https://track.pets-palace.nl';
const workloadIdentityKeyId = process.env.WORKLOAD_IDENTITY_KEY_ID ?? 'pets-palace-tracking-v1';
const workloadIdentityPrivateKey = process.env.WORKLOAD_IDENTITY_PRIVATE_KEY;
const workloadIdentityPublicJwk = workloadIdentityPrivateKey
  ? {
      ...createPublicKey(createPrivateKey(workloadIdentityPrivateKey.replace(/\\n/g, '\n'))).export({ format: 'jwk' }),
      alg: 'RS256',
      kid: workloadIdentityKeyId,
      use: 'sig',
    }
  : null;
const googleWifAudience = process.env.GOOGLE_WIF_AUDIENCE;
const googleServiceAccount = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const googleAdsCustomerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
const googleAdsConversionActionId = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
const googleDataManagerEnabled = process.env.GOOGLE_DATA_MANAGER_ENABLED === 'true';

if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const allowedEventTypes = new Set(['page_view', 'add_to_cart', 'begin_checkout', 'purchase']);

function isTrustedBrowserOrigin(origin) {
  if (origin === 'null') return true;
  if (origin === trustedOrigin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (url.hostname.endsWith('.myshopify.com') || url.hostname.endsWith('.shopifycdn.com') || url.hostname.endsWith('.shopify.com'));
  } catch {
    return false;
  }
}

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
  if (isTrustedBrowserOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  response.writeHead(status, headers);
  response.end(JSON.stringify(body));
}

async function readBody(request, maximumBytes = 32_768) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maximumBytes) throw new Error('payload_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request);
  try {
    return JSON.parse(body.toString('utf8'));
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

function stableUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function hasValidShopifyHmac(rawBody, signature) {
  if (!shopifyWebhookSecret || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', shopifyWebhookSecret).update(rawBody).digest('base64');
  const suppliedBytes = Buffer.from(signature, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
}

function cleanPaidOrder(order) {
  const lineItems = Array.isArray(order.line_items) ? order.line_items.slice(0, 100).map((item) => ({
    product_id: item.product_id ?? null,
    variant_id: item.variant_id ?? null,
    quantity: Number(item.quantity) || 0,
    price: item.price ?? null,
  })) : [];
  return {
    order_number: order.order_number ?? null,
    name: typeof order.name === 'string' ? order.name.slice(0, 64) : null,
    currency: typeof order.currency === 'string' ? order.currency.slice(0, 3).toUpperCase() : null,
    value: order.current_total_price ?? order.total_price ?? null,
    line_items: lineItems,
    click_ids: extractClickIds(order.landing_site),
  };
}

function extractClickIds(landingSite) {
  if (typeof landingSite !== 'string' || landingSite.length > 4096) return {};
  try {
    const params = new URL(landingSite, 'https://pets-palace.nl').searchParams;
    return Object.fromEntries(['gclid', 'gbraid', 'wbraid'].flatMap((key) => {
      const value = params.get(key);
      return value ? [[key, value.slice(0, 512)]] : [];
    }));
  } catch {
    return {};
  }
}

async function healthcheck() {
  await pool.query('SELECT 1');
}

function b64url(value) { return Buffer.from(value).toString('base64url'); }

async function googleAccessToken() {
  if (!workloadIdentityPrivateKey || !googleWifAudience || !googleServiceAccount) throw new Error('google_auth_not_configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: workloadIdentityKeyId }));
  const claims = b64url(JSON.stringify({ iss: workloadIdentityIssuer, sub: 'tracking-service', aud: workloadIdentityIssuer, iat: now, exp: now + 600 }));
  const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${signer.sign(createPrivateKey(workloadIdentityPrivateKey.replace(/\\n/g, '\n'))).toString('base64url')}`;
  const sts = await fetch('https://sts.googleapis.com/v1/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', audience: googleWifAudience, scope: 'https://www.googleapis.com/auth/cloud-platform', subject_token: assertion }) });
  const federated = await sts.json(); if (!sts.ok) throw new Error(`sts_${sts.status}`);
  const iam = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(googleServiceAccount)}:generateAccessToken`, { method: 'POST', headers: { Authorization: `Bearer ${federated.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/datamanager'], lifetime: '900s' }) });
  const token = await iam.json(); if (!iam.ok) throw new Error(`iam_${iam.status}`); return token.accessToken;
}

async function deliverPendingPurchases() {
  if (!googleDataManagerEnabled || !googleAdsCustomerId || !googleAdsConversionActionId) return;
  const rows = await pool.query(`SELECT d.id, e.event_id, e.occurred_at, e.order_id, e.payload FROM delivery_attempts d JOIN tracking_events e ON e.event_id=d.event_id WHERE d.destination='google_data_manager' AND d.status='pending' ORDER BY d.id LIMIT 50`);
  if (!rows.rowCount) return;
  try {
    const events = rows.rows.map(({ event_id, occurred_at, order_id, payload }) => ({ transactionId: order_id, eventTimestamp: occurred_at.toISOString(), currency: payload.currency, conversionValue: Number(payload.value), eventSource: 'WEB', adIdentifiers: payload.click_ids, destinationReferences: ['purchase'], additionalEventParameters: [{ parameterName: 'event_id', value: event_id }] }));
    const response = await fetch('https://datamanager.googleapis.com/v1/events:ingest', { method: 'POST', headers: { Authorization: `Bearer ${await googleAccessToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ destinations: [{ reference: 'purchase', operatingAccount: { accountType: 'GOOGLE_ADS', accountId: googleAdsCustomerId }, loginAccount: { accountType: 'GOOGLE_ADS', accountId: googleAdsCustomerId }, productDestinationId: googleAdsConversionActionId }], events }) });
    if (!response.ok) throw new Error(`datamanager_${response.status}`);
    await pool.query(`UPDATE delivery_attempts SET status='sent', sent_at=now() WHERE id = ANY($1)`, [rows.rows.map((r) => r.id)]);
  } catch (error) { console.error('Google Data Manager delivery failed', error); }
}

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS' && url.pathname === '/v1/events' && isTrustedBrowserOrigin(origin)) {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
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

  if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
    if (!workloadIdentityPublicJwk) return sendJson(response, 503, { error: 'workload_identity_not_configured' }, origin);
    return sendJson(response, 200, {
      issuer: workloadIdentityIssuer,
      jwks_uri: `${workloadIdentityIssuer}/.well-known/jwks.json`,
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    }, origin);
  }

  if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
    if (!workloadIdentityPublicJwk) return sendJson(response, 503, { error: 'workload_identity_not_configured' }, origin);
    return sendJson(response, 200, { keys: [workloadIdentityPublicJwk] }, origin);
  }

  if (request.method === 'POST' && url.pathname === '/v1/webhooks/shopify/orders-paid') {
    try {
      const rawBody = await readBody(request, 1_048_576);
      if (!hasValidShopifyHmac(rawBody, request.headers['x-shopify-hmac-sha256'])) {
        return sendJson(response, 401, { error: 'invalid_webhook_signature' }, origin);
      }
      if (request.headers['x-shopify-shop-domain'] !== shopifyShopDomain) {
        return sendJson(response, 403, { error: 'untrusted_shop' }, origin);
      }
      const webhookId = request.headers['x-shopify-webhook-id'];
      if (!isUuid(webhookId)) return sendJson(response, 422, { error: 'invalid_webhook_id' }, origin);
      const order = JSON.parse(rawBody.toString('utf8'));
      if (!order?.id) return sendJson(response, 422, { error: 'invalid_order' }, origin);

      const receipt = await pool.query(
        `INSERT INTO webhook_receipts (webhook_id, topic)
         VALUES ($1, 'orders/paid') ON CONFLICT (webhook_id) DO NOTHING RETURNING webhook_id`,
        [webhookId],
      );
      if (receipt.rowCount === 0) return sendJson(response, 202, { accepted: true, duplicate: true }, origin);

      await pool.query(
        `INSERT INTO tracking_events
          (event_id, event_type, source, occurred_at, order_id, analytics_consent, marketing_consent, payload)
         VALUES ($1, 'purchase', 'shopify_webhook', $2, $3, false, false, $4)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          stableUuid(`shopify-order:${order.id}`),
          new Date(order.processed_at ?? order.created_at ?? Date.now()).toISOString(),
          String(order.id),
          cleanPaidOrder(order),
        ],
      );
      await pool.query(`INSERT INTO delivery_attempts (event_id, destination, status) VALUES ($1, 'google_data_manager', 'pending') ON CONFLICT DO NOTHING`, [stableUuid(`shopify-order:${order.id}`)]);
      return sendJson(response, 202, { accepted: true }, origin);
    } catch (error) {
      const knownError = error instanceof Error && ['payload_too_large'].includes(error.message);
      return sendJson(response, knownError ? 413 : 500, { error: knownError ? error.message : 'internal_error' }, origin);
    }
  }

  if (request.method === 'POST' && url.pathname === '/v1/events') {
    if (!isTrustedBrowserOrigin(origin)) return sendJson(response, 403, { error: 'untrusted_origin' }, origin);
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
      setInterval(() => deliverPendingPurchases().catch((error) => console.error(error)), 30_000).unref();
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
