# Pet's Palace Tracking

Open-source, self-hosted server-side conversion tracking for Pet's Palace.

The service receives the consented funnel events `page_view`, `add_to_cart`,
`begin_checkout` and `purchase`. It records no browser-provided PII. Paid
orders are accepted only through the HMAC-verified Shopify `orders/paid`
webhook at `/v1/webhooks/shopify/orders-paid`.

## Runtime

The Docker Compose stack consists of a Node.js collector and a private
PostgreSQL database. It exposes no host ports. A Cloudflare Tunnel will be the
only public route to the collector once configured.

## Development

Copy `.env.example` to `.env`, set a strong `POSTGRES_PASSWORD`, then run:

```sh
docker compose up --build
```

`GET /healthz` checks the database connection. `POST /v1/events` accepts only
browser funnel events from `https://pets-palace.nl`. The webhook validates the
Shopify app client secret and deduplicates deliveries before recording a
purchase.

For keyless Google Cloud access, the service can publish an OpenID Connect
discovery document and JWKS at `/.well-known/openid-configuration` and
`/.well-known/jwks.json`. Configure an RSA signing key only as the Coolify
`WORKLOAD_IDENTITY_PRIVATE_KEY` secret, never in Git. Google Workload Identity
Federation trusts the corresponding public key and exchanges short-lived JWTs
for short-lived Google access tokens.
