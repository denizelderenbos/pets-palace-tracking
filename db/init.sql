CREATE TABLE tracking_events (
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

CREATE INDEX tracking_events_type_occurred_at_idx
  ON tracking_events (event_type, occurred_at DESC);

CREATE INDEX tracking_events_order_id_idx
  ON tracking_events (order_id)
  WHERE order_id IS NOT NULL;

CREATE TABLE webhook_receipts (
  webhook_id UUID PRIMARY KEY,
  topic TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_attempts (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES tracking_events(event_id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  error_code TEXT,
  UNIQUE (event_id, destination)
);
