# What We Expect From Other Services

This document explains how other microservices should integrate with the Payment Service. It covers every interaction point: HTTP requests, expected responses, RabbitMQ events, and the Checkout Form flow.

---

## Who Talks To Us

| Service | How | What For |
|---|---|---|
| **Order Service** | HTTP (REST) | Create payments, capture, void, refund |
| **Order Service** | RabbitMQ (consumer) | React to payment state changes |
| **Auth Service** | JWT (indirect) | Issues JWTs that we validate |
| **Frontend** (mobile)| HTTP (indirect, via Order Service) | Renders checkout form in iframe/WebView |

The Order Service is our primary caller. The frontend never calls us directly — everything goes through the Order Service, except the checkout form callback which iyzico POSTs to the `callbackUrl` you provide.

---

## Authentication

Every request (except `POST /payments/:id/checkout-form/callback` and `GET /health`) requires:

```
Authorization: Bearer <jwt>
```

The JWT must be signed with the shared `JWT_SECRET`. We read `sub` from the payload as the user ID. The Auth Service is responsible for issuing these tokens — we only validate them.

**If the Auth Service isn't ready yet:** Set `SKIP_AUTH=true` in `.env` and send `X-User-Id: <userId>` header instead. But this should not be used in production.

---

## PCI Compliance Note

**Raw card data (cardNumber, CVC, expiry) never flows through our API.** Every payment uses iyzico's hosted Checkout Form — the customer enters card details on iyzico's servers. This keeps all services in PCI DSS SAQ A scope.

---

## Card saving — out of scope

This service does not support saving cards. Both iyzico paths (standalone Universal Card Storage and the "save card" checkbox inside Checkout Form) are blocked in iyzico sandbox, so we can't test them end-to-end. The feature was cut with the professor's approval. If you need card saving later, prior commits on this branch contain a working implementation that can be revived.

Practically: there is no `POST /cards`, no `savedCardId` field on payment requests, no `GET /cards` for the frontend to render a card list. Every payment starts a fresh Checkout Form.

---

## Flow 1: Payment (Checkout Form)

```
Customer          Order Service              Payment API           iyzico
   |                    |                         |                   |
   |-- place order ---->|                         |                   |
   |                    |-- POST /payments ------>|                   |
   |                    |  (buyer, items,         |-- CF initPreAuth->|
   |                    |   callbackUrl)          |<- token,content --|
   |                    |                         |                   |
   |                    |                         |== DB: CREATED → AWAITING_FORM ==|
   |                    |                         |  (no RMQ event yet)              |
   |                    |                         |                   |
   |                    |<-- 201 { payment,       |                   |
   |                    |    checkoutForm } ------|                   |
   |                    |                         |                   |
   |<-- formContent ----|                         |                   |
   |  (render in iframe |                         |                   |
   |   or WebView)      |                         |                   |
   |                    |                         |                   |
   | (user fills iyzico's form, iyzico handles 3DS internally)       |
   |                    |                         |                   |
   |--- POST callbackUrl?token=... -------------->|                   |
   |                    |                         |                   |
   | (Order Service receives iyzico's callback POST)                 |
   |                    |-- POST /checkout-form/callback -->|         |
   |                    |   { token }             |-- CF retrieve -->|
   |                    |                         |<-- result -------|
   |                    |                         |                   |
   |                    |                         |== DB: AWAITING_FORM → AUTHORIZED|
   |                    |                         |== RMQ: payment.authorized ======|
   |                    |                         |                   |
   |                    |<-- 200 { payment } -----|                   |
   |<-- "authorized" ---|                         |                   |
```

**Key points about `callbackUrl`:**
- The `callbackUrl` controls where iyzico redirects the customer's browser/WebView after form completion.
- `{paymentId}` placeholder gets replaced with the actual payment ID.
- Order Service should pass its own URL (e.g., `"https://order-service.example.com/checkout-form-return/{paymentId}"`).
- When the form completes, iyzico POSTs to the callbackUrl with a `token` field. Extract it and call our `POST /payments/:id/checkout-form/callback` with `{ "token": "<value>" }`.
- If `callbackUrl` is not provided, we default to our own endpoint.

---

## Flow 2: Capture (Restaurant Confirms)

```
Order Service              Payment API           iyzico
     |                         |                   |
     |-- POST /capture ------->|                   |
     |                         |-- postAuth ------>|
     |                         |<-- captured ------|
     |                         |                   |
     |                         |== DB: AUTHORIZED → CAPTURED =|
     |                         |== RMQ: payment.captured =====|
     |                         |                   |
     |<-- 200 { payment } -----|                   |
```

---

## Flow 3: Void (Restaurant Rejects Before Capture)

```
Order Service              Payment API           iyzico
     |                         |                   |
     |-- POST /cancel -------->|                   |
     |  { reason }             |-- cancel -------->|
     |                         |<-- success -------|
     |                         |                   |
     |                         |== DB: AUTHORIZED → VOIDED ==|
     |                         |== RMQ: payment.voided ======|
     |                         |                   |
     |<-- 200 { payment } -----|                   |
```

---

## Flow 4: Refund (After Capture)

```
Order Service              Payment API           iyzico
     |                         |                   |
     |-- POST /cancel -------->|                   |
     |  { reason }             |-- cancel -------->|  (try same-day cancel first)
     |                         |<-- fail/success --|
     |                         |                   |
     |                         |  (if cancel failed, per-item refund)
     |                         |-- refund item1 -->|
     |                         |<-- success -------|
     |                         |-- refund item2 -->|
     |                         |<-- success -------|
     |                         |                   |
     |                         |== DB: CAPTURED → REFUNDED ==|
     |                         |== RMQ: payment.refunded ====|
     |                         |                   |
     |<-- 200 { payment } -----|                   |
```

Same endpoint (`POST /cancel`) handles both void and refund. We check the current state internally.

---

## HTTP API Reference

### `POST /payments` — Create + Initialize Checkout Form

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
Idempotency-Key: <unique-key-per-attempt>
```

**Body:**
```json
{
  "orderId": "ord_abc123",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "buyer": {
    "id": "user_123",
    "name": "John",
    "surname": "Doe",
    "email": "john@example.com",
    "identityNumber": "74300864791",
    "gsmNumber": "+905350000000",
    "registrationAddress": "Some Address, Istanbul",
    "ip": "85.34.78.112",
    "city": "Istanbul",
    "country": "Turkey",
    "zipCode": "34000"
  },
  "items": [
    {
      "id": "item_1",
      "name": "Margherita Pizza",
      "category1": "Food",
      "itemType": "PHYSICAL",
      "price": "100.00"
    },
    {
      "id": "item_2",
      "name": "Cola",
      "category1": "Beverages",
      "itemType": "PHYSICAL",
      "price": "50.00"
    }
  ],
  "callbackUrl": "https://your-service.com/checkout-form-return/{paymentId}"
}
```

**Notes:**
- **No `card` field.** Card details are entered on iyzico's hosted form, not passed through our API.
- `amount` is in **minor units** (kurus). 15000 = 150.00 TRY.
- `items[].price` is in **major units** (TRY) as a string. Sum of item prices must equal `amount / 100`.
- `buyer` fields are required by iyzico. If fields are missing, we fill defaults but log warnings.
- `callbackUrl` is required. `{paymentId}` placeholder is replaced by us.
- `Idempotency-Key` must be unique per payment attempt. If you send the same key again, you get back the original response (HTTP 200 instead of 201).

**Response (201):**
```json
{
  "payment": {
    "id": "pay_abc123",
    "status": "AWAITING_FORM",
    ...
  },
  "checkoutForm": {
    "token": "cf_token_abc123",
    "content": "<base64-encoded HTML or raw HTML>",
    "paymentPageUrl": "https://sandbox-api.iyzipay.com/..."
  }
}
```

Render `content` in the customer's browser (iframe or WebView). MockProvider returns base64; iyzico may return raw HTML — try base64-decoding first and fall back to using the content as-is.

**Response (200 — duplicate idempotency key):**

Same body as the original response. No new payment created.

---

### `POST /payments/:id/checkout-form/callback` — Complete Checkout Form

**No auth required** (this is called by the Order Service after iyzico's form completion callback).

**Body:**
```json
{
  "token": "cf_token_abc123"
}
```

The `token` comes from iyzico's POST to your `callbackUrl`. Forward it as-is.

**Response:** `{ "payment": { "status": "AUTHORIZED" | "FAILED", ... } }`

---

### `POST /payments/:id/capture` — Capture

**Headers:** `Authorization: Bearer <jwt>`

**Body:** `{ "amount": 15000 }` (must match authorized amount, partial capture not supported)

**Response:** `{ "payment": { "status": "CAPTURED", ... } }`

---

### `POST /payments/:id/cancel` — Void or Refund

**Headers:** `Authorization: Bearer <jwt>`

**Body:** `{ "reason": "customer requested cancellation" }`

- If payment is `AUTHORIZED` → voids (releases hold, no money moved)
- If payment is `CAPTURED` → refunds (returns money)
- Any other status → `409 INVALID_STATE_TRANSITION`

**Response:** `{ "payment": { "status": "VOIDED" | "REFUNDED", ... } }`

---

### `GET /payments/:id` — Get Payment

**Headers:** `Authorization: Bearer <jwt>`

**Response:** `{ "payment": { ... } }`

---

### `GET /payments?orderId=X` — Get Payments by Order

**Headers:** `Authorization: Bearer <jwt>`

Returns all payment attempts for an order (useful for seeing retries).

**Response:** `{ "payments": [ ... ] }`

---

## RabbitMQ Events

We publish to topic exchange `payment.events`. Subscribe with routing key pattern `payment.#` to get everything, or specific keys like `payment.authorized`.

Every event has this payload:
```json
{
  "paymentId": "pay_abc123",
  "orderId": "ord_abc123",
  "userId": "user_123",
  "amount": 15000,
  "currency": "TRY",
  "status": "AUTHORIZED",
  "timestamp": "2026-03-15T12:00:00.000Z"
}
```

| Routing Key | When | What You Should Do |
|---|---|---|
| `payment.authorized` | Card auth succeeded after checkout form | Update order to "payment received", proceed with fulfillment |
| `payment.captured` | Funds taken from card | Confirm order to customer |
| `payment.failed` | Auth failed (declined, form failed, provider error) | Show error to customer, allow retry |
| `payment.voided` | Authorization released (before capture) | Mark order as cancelled |
| `payment.refunded` | Money returned to customer (after capture) | Mark order as refunded |

**Important:** For the Checkout Form flow, you might receive `payment.authorized` or `payment.failed` asynchronously via RabbitMQ before or after the HTTP response from the checkout form callback. Your Order Service should handle both paths — use whichever arrives first and ignore the duplicate.

---

## What We Need From You

### From Auth Service
- Issue JWTs with `{ sub: "<userId>" }` signed with the shared `JWT_SECRET`
- We validate the signature and expiry, nothing else

### From Order Service
- Generate unique `orderId` values (you own order IDs, we don't)
- Generate unique `Idempotency-Key` per payment attempt (e.g., `ord_abc123_attempt_1`)
- Provide `buyer` object with user details (required by iyzico for compliance)
- Provide `items` array with basket contents (required by iyzico — item prices in TRY as strings, must sum to `amount / 100`)
- Handle the `callbackUrl` callback for checkout form: receive iyzico's POST with `token`, call our `POST /payments/:id/checkout-form/callback` with `{ "token": "<value>" }`
- Subscribe to `payment.events` exchange on RabbitMQ and react to state changes

### From Frontend (mobile team)
- Render `checkoutForm.content` (base64 decode if possible, otherwise use as-is → iframe or WebView) when payment returns `AWAITING_FORM`
- Never call Payment API directly — always go through Order Service
- **Mobile-specific notes:**
  - `postMessage` from iyzico's iframe doesn't reliably work in native WebViews. Instead, intercept navigation to the `callbackUrl` and extract the `token` from the POST body or URL params.
  - Apple Pay / Google Pay are available in iyzico's checkout form on real devices but won't work in the desktop simulator.
  - `buyer.identityNumber` (TC kimlik no) must be a real 11-digit number in production. The placeholder `74300864791` works in sandbox only.
  - `buyer.ip` should be the customer's real IP, not `127.0.0.1`. Order Service must forward `X-Forwarded-For` from the mobile app.

### From DevOps
- Central RabbitMQ instance — when ready, we just change `RABBITMQ_URL`
- Our exchange name is `payment.events` (topic type), we only assert it, we don't own the RabbitMQ instance

---

## Error Codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `MISSING_IDEMPOTENCY_KEY` | `Idempotency-Key` header not sent |
| 400 | `AMOUNT_MISMATCH` | Capture amount doesn't match authorized amount |
| 400 | `MISSING_FORM_TOKEN` | Checkout form callback missing `token` field |
| 401 | `UNAUTHORIZED` | Missing/invalid JWT |
| 404 | `PAYMENT_NOT_FOUND` | Payment ID doesn't exist |
| 409 | `INVALID_STATE_TRANSITION` | Can't perform this action in current state (e.g., capture a failed payment) |
| 409 | `CONCURRENT_MODIFICATION` | Optimistic lock conflict — someone else modified this payment simultaneously |
| 502 | `CHECKOUT_FORM_INIT_FAILED` | Failed to initialize checkout form with iyzico |
| 502 | `CHECKOUT_FORM_RETRIEVE_FAILED` | Failed to retrieve checkout form result from iyzico |

All errors return:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation"
  }
}
```

---

## State Machine

```
CREATED → AWAITING_FORM       (checkout form initialized)
CREATED → FAILED              (init error)
AWAITING_FORM → AUTHORIZED    (checkout form completed successfully)
AWAITING_FORM → FAILED        (checkout form failed / cancelled)
AUTHORIZED → CAPTURED         (order service triggers capture)
AUTHORIZED → VOIDED           (order cancelled before capture)
CAPTURED → REFUNDED           (full refund)
```
