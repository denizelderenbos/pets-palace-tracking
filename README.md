# Pet's Palace Tracking

Open-source, self-hosted server-side conversion tracking for Pet's Palace.

The service receives the consented funnel events `page_view`, `add_to_cart`,
`begin_checkout` and `purchase`. It records no browser-provided PII. Paid
orders will be accepted only through a Shopify HMAC-verified webhook in the
next implementation phase.

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
browser funnel events from `https://pets-palace.nl`.
