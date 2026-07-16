// Pet's Palace server-side track — Shopify Custom Pixel (ID 338919767)
// Plak deze volledige code in Shopify admin → Settings → Customer events →
// "Pet's Palace server-side track". Vereiste permissies van de pixel blijven
// Marketing + Analytics; Shopify laadt de pixel alleen met die consent, dus de
// consent-vlaggen hieronder zijn per definitie waar op het moment van draaien.
const ENDPOINT = 'https://track.pets-palace.nl/v1/events';
const CLICK_ID_KEYS = ['gclid', 'gbraid', 'wbraid'];
const STORAGE_KEY = 'pp_click_ids';
const CLICK_ID_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

async function storedClickIds() {
  try {
    const raw = await browser.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    if (Date.now() - Number(parsed.stored_at) > CLICK_ID_MAX_AGE_MS) return {};
    return parsed.ids && typeof parsed.ids === 'object' ? parsed.ids : {};
  } catch {
    return {};
  }
}

async function captureClickIds(href) {
  try {
    const params = new URL(href).searchParams;
    const found = {};
    for (const key of CLICK_ID_KEYS) {
      const value = params.get(key);
      if (value && value.length >= 20 && value.length <= 512) found[key] = value;
    }
    if (Object.keys(found).length === 0) return;
    const merged = { ...(await storedClickIds()), ...found };
    await browser.localStorage.setItem(STORAGE_KEY, JSON.stringify({ stored_at: Date.now(), ids: merged }));
  } catch {
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
        data,
      }),
    });
  } catch {
    // tracking mag de storefront nooit breken
  }
}

function digits(value) {
  const match = String(value ?? '').match(/\d+/g);
  return match ? match.join('') : null;
}

analytics.subscribe('page_viewed', async (event) => {
  const href = event.context?.document?.location?.href ?? '';
  await captureClickIds(href);
  let path = '/';
  try { path = new URL(href).pathname; } catch { /* laat '/' staan */ }
  await send(event, 'page_view', {
    path,
    title: event.context?.document?.title ?? '',
  });
});

analytics.subscribe('product_added_to_cart', async (event) => {
  const cartLine = event.data?.cartLine;
  await send(event, 'add_to_cart', {
    product_id: digits(cartLine?.merchandise?.product?.id),
    variant_id: digits(cartLine?.merchandise?.id),
    quantity: Number(cartLine?.quantity) || 1,
    currency: cartLine?.cost?.totalAmount?.currencyCode ?? null,
    value: Number(cartLine?.cost?.totalAmount?.amount) || null,
  });
});

analytics.subscribe('checkout_started', async (event) => {
  const checkout = event.data?.checkout;
  await send(event, 'begin_checkout', {
    currency: checkout?.totalPrice?.currencyCode ?? null,
    value: Number(checkout?.totalPrice?.amount) || null,
    item_count: Array.isArray(checkout?.lineItems)
      ? checkout.lineItems.reduce((total, line) => total + (Number(line?.quantity) || 0), 0)
      : null,
  });
});
