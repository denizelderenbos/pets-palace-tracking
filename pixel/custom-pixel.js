// Pet's Palace server-side track — Shopify Custom Pixel (ID 338919767)
// Plak deze volledige code in Shopify admin → Settings → Customer events →
// "Pet's Palace server-side track". Vereiste permissies van de pixel blijven
// Marketing + Analytics; Shopify laadt de pixel alleen met die consent, dus de
// consent-vlaggen hieronder zijn per definitie waar op het moment van draaien.
// Let op: de pixel-editor accepteert geen optional chaining (?.) of ??.
const ENDPOINT = 'https://track.pets-palace.nl/v1/events';
const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'];
const STORAGE_KEY = 'pp_click_ids';
const CLICK_ID_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function get(object, path) {
  let value = object;
  for (let i = 0; i < path.length; i += 1) {
    if (value === null || value === undefined) return undefined;
    value = value[path[i]];
  }
  return value;
}

async function storedClickIds() {
  try {
    const raw = await browser.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    if (Date.now() - Number(parsed.stored_at) > CLICK_ID_MAX_AGE_MS) return {};
    if (parsed.ids && typeof parsed.ids === 'object') return parsed.ids;
    return {};
  } catch (error) {
    return {};
  }
}

async function captureClickIds(href) {
  try {
    const params = new URL(href).searchParams;
    const found = {};
    for (let i = 0; i < CLICK_ID_KEYS.length; i += 1) {
      const key = CLICK_ID_KEYS[i];
      const value = params.get(key);
      if (value && value.length >= 20 && value.length <= 512) found[key] = value;
    }
    if (Object.keys(found).length === 0) return;
    const merged = Object.assign({}, await storedClickIds(), found);
    await browser.localStorage.setItem(STORAGE_KEY, JSON.stringify({ stored_at: Date.now(), ids: merged }));
  } catch (error) {
    // click-ID-opslag is best effort; events zelf mogen hier nooit op stranden
  }
}

async function send(event, eventType, data) {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        event_id: event.id,
        event_type: eventType,
        occurred_at: event.timestamp,
        consent: { analytics: true, marketing: true },
        click_ids: await storedClickIds(),
        data: data,
      }),
    });
  } catch (error) {
    // tracking mag de storefront nooit breken
  }
}

function digits(value) {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/\d+/g);
  if (match) return match.join('');
  return null;
}

analytics.subscribe('page_viewed', async (event) => {
  const href = get(event, ['context', 'document', 'location', 'href']) || '';
  await captureClickIds(href);
  let path = '/';
  try {
    path = new URL(href).pathname;
  } catch (error) {
    // laat '/' staan
  }
  await send(event, 'page_view', {
    path: path,
    title: get(event, ['context', 'document', 'title']) || '',
  });
});

analytics.subscribe('product_added_to_cart', async (event) => {
  const cartLine = get(event, ['data', 'cartLine']) || {};
  await send(event, 'add_to_cart', {
    product_id: digits(get(cartLine, ['merchandise', 'product', 'id'])),
    variant_id: digits(get(cartLine, ['merchandise', 'id'])),
    quantity: Number(cartLine.quantity) || 1,
    currency: get(cartLine, ['cost', 'totalAmount', 'currencyCode']) || null,
    value: Number(get(cartLine, ['cost', 'totalAmount', 'amount'])) || null,
  });
});

analytics.subscribe('checkout_started', async (event) => {
  const checkout = get(event, ['data', 'checkout']) || {};
  const lineItems = Array.isArray(checkout.lineItems) ? checkout.lineItems : [];
  let itemCount = 0;
  for (let i = 0; i < lineItems.length; i += 1) {
    itemCount += Number(get(lineItems[i], ['quantity'])) || 0;
  }
  await send(event, 'begin_checkout', {
    currency: get(checkout, ['totalPrice', 'currencyCode']) || null,
    value: Number(get(checkout, ['totalPrice', 'amount'])) || null,
    item_count: itemCount,
  });
});
