# What We Expect From Other Services

This document explains how other microservices should integrate with the Payment Service. It covers every interaction point: HTTP requests, expected responses, RabbitMQ events, and the Checkout Form flow.

---

## Who Talks To Us

| Service | How | What For |
|---|---|---|
| **Order Service** | HTTP (REST) | Create payments, capture, void, refund, saved cards |
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

**Raw card data (cardNumber, CVC, expiry) never flows through our API.** New card payments use iyzico's hosted Checkout Form — the customer enters card details on iyzico's servers. Saved card payments use tokenized `{cardUserKey, cardToken}` pairs. This keeps all services in PCI DSS SAQ A scope.

---

## Flow 1: Saved Card Payment (Direct, NON3D)

```
Customer          Order Service              Payment API           iyzico
   |                    |                         |                   |
   |-- place order ---->|                         |                   |
   |  (select saved     |-- POST /payments ------>|                   |
   |   card)            |  (savedCardId, buyer,   |-- preAuth ------->|
   |                    |   items)                |<-- authorized ----|
   |                    |                         |                   |
   |                    |                         |== DB: CREATED → AUTHORIZED ==|
   |                    |                         |== RMQ: payment.authorized ===|
   |                    |                         |                   |
   |                    |<-- 201 { payment } -----|                   |
   |<-- "authorized" ---|                         |                   |
   |                    |                         |                   |
   |  (restaurant       |                         |                   |
   |   confirms)        |-- POST /capture ------->|                   |
   |                    |                         |-- postAuth ------>|
   |                    |                         |<-- captured ------|
   |                    |                         |                   |
   |                    |                         |== DB: AUTHORIZED → CAPTURED =|
   |                    |                         |== RMQ: payment.captured =====|
   |                    |                         |                   |
   |                    |<-- 200 { payment } -----|                   |
   |<-- "confirmed!" ---|                         |                   |
```

Saved card payments are instant — no form, no redirect.

---

## Flow 2: New Card Payment (Checkout Form)

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
   |--- POST callbackUrl?token=... ------------->|                   |
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

## Flow 3: Void (Restaurant Rejects Before Capture)

```
Order Service              Payment API           iyzico
     |                         |                   |
     |-- POST /cancel -------->|                   |
     |  { reason }             |-- cancel -------->|
     |                         |<-- success -------|
     |                         |                   |
     |                         |== DB: AUTHORIZED ��� VOIDED ==|
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

### `POST /payments` — Create + Authorize

**Headers:**
```
Authorization: Bearer <jwt>
Content-Type: application/json
Idempotency-Key: <unique-key-per-attempt>
```

**Body (new card — Checkout Form flow, no card data):**
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

**Body (saved card — direct authorization, no form):**
```json
{
  "orderId": "ord_abc123",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "savedCardId": "card_abc123",
  "buyer": { ... },
  "items": [ ... ]
}
```

**Notes:**
- **No `card` field.** New card payments go through the Checkout Form — card details are entered on iyzico's hosted form, not passed through our API.
- Send `savedCardId` for saved card payments (instant authorization, no form).
- Omit `savedCardId` for new card payments (triggers Checkout Form flow).
- `amount` is in **minor units** (kurus). 15000 = 150.00 TRY.
- `items[].price` is in **major units** (TRY) as a string. Sum of item prices must equal `amount / 100`.
- `buyer` fields are required by iyzico. If fields are missing, we fill defaults but log warnings.
- `callbackUrl` is required for Checkout Form flow. `{paymentId}` placeholder is replaced by us. Not needed for saved card payments.
- `Idempotency-Key` must be unique per payment attempt. If you send the same key again, you get back the original response (HTTP 200 instead of 201).

**Response (201 — saved card, authorized directly):**
```json
{
  "payment": {
    "id": "pay_abc123",
    "orderId": "ord_abc123",
    "userId": "user_123",
    "amount": 15000,
    "currency": "TRY",
    "status": "AUTHORIZED",
    "provider": "iyzico",
    "providerTxId": "12345678",
    "createdAt": "...",
    "authorizedAt": "..."
  }
}
```

**Response (201 — new card, Checkout Form initialized):**
```json
{
  "payment": {
    "id": "pay_abc123",
    "status": "AWAITING_FORM",
    ...
  },
  "checkoutForm": {
    "token": "cf_token_abc123",
    "content": "<base64-encoded HTML>",
    "paymentPageUrl": "https://sandbox-api.iyzipay.com/..."
  }
}
```

Decode the base64 `content` and render it in the customer's browser (iframe or WebView). This is iyzico's hosted payment form where the customer enters card details securely.

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

## Saved Cards API

Users can save cards for future payments. Card storage uses iyzico's hosted form (PCI-safe) — no raw card data passes through our API.

### `POST /cards` — Initialize Card Storage Form

**Headers:** `Authorization: Bearer <jwt>`

**Body:**
```json
{
  "email": "john@example.com",
  "cardAlias": "My Visa",
  "callbackUrl": "https://your-service.com/card-form-return"
}
```

- `email` is optional (used by iyzico to create the card user)
- `cardAlias` is optional (user-friendly name)
- `callbackUrl` is where iyzico redirects after the user fills the form

**Response (201):**
```json
{
  "cardForm": {
    "token": "cs_token_abc123",
    "content": "<base64-encoded HTML>"
  }
}
```

Decode the base64 `content` and render it in an iframe/WebView. The user enters card details on iyzico's form.

---

### `POST /cards/checkout-form/callback` — Complete Card Storage

**Headers:** `Authorization: Bearer <jwt>` (required — we need the user ID to store the card)

**Body:**
```json
{
  "token": "cs_token_abc123",
  "cardAlias": "My Visa"
}
```

The `token` comes from iyzico's POST to your `callbackUrl`. Forward it with the user's JWT.

**Response (201):**
```json
{
  "card": {
    "id": "card_abc123",
    "userId": "user_42",
    "last4": "0008",
    "cardAssociation": "MASTERCARD",
    "cardType": "CREDIT",
    "cardBankName": "Halkbank",
    "cardAlias": "My Visa",
    "createdAt": "..."
  }
}
```

---

### `GET /cards` — List Saved Cards

**Headers:** `Authorization: Bearer <jwt>`

Returns all saved cards for the authenticated user.

**Response (200):**
```json
{
  "cards": [
    {
      "id": "card_abc123",
      "last4": "0008",
      "cardAssociation": "MASTERCARD",
      "cardType": "CREDIT",
      "cardBankName": "Halkbank",
      "cardAlias": "My Visa",
      "createdAt": "..."
    }
  ]
}
```

---

### `DELETE /cards/:cardId` — Delete a Saved Card

**Headers:** `Authorization: Bearer <jwt>`

Removes the card from both our database and iyzico's storage. Returns `204 No Content` on success.

Only the card owner can delete their own cards (403 `CARD_NOT_OWNED` otherwise).

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
| `payment.authorized` | Card auth succeeded (saved card direct or after checkout form) | Update order to "payment received", proceed with fulfillment |
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
- Handle the `callbackUrl` callback for card storage: receive iyzico's POST with `token`, call our `POST /cards/checkout-form/callback` with `{ "token": "<value>" }` and the user's JWT
- Subscribe to `payment.events` exchange on RabbitMQ and react to state changes
- For saved cards: proxy `GET /cards`, `POST /cards`, `DELETE /cards/:id` calls from frontend to us
- At checkout: send `savedCardId` (from GET /cards response) for saved card payments, or omit it for new card checkout form payments

### From Frontend (mobile team)
- Render `checkoutForm.content` (base64 decode → iframe or WebView) when payment returns `AWAITING_FORM`
- Render `cardForm.content` (base64 decode → iframe or WebView) when saving a new card
- Never call Payment API directly — always go through Order Service
- For saved cards: show "My Cards" management UI (list, add, delete) and card selection at checkout
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
| 400 | `MISSING_CARD_DETAILS` | Invalid request (e.g., missing required fields) |
| 400 | `MISSING_FORM_TOKEN` | Checkout form callback missing `token` field |
| 401 | `UNAUTHORIZED` | Missing/invalid JWT |
| 403 | `CARD_NOT_OWNED` | Trying to use/delete a saved card that belongs to another user |
| 404 | `PAYMENT_NOT_FOUND` | Payment ID doesn't exist |
| 404 | `CARD_NOT_FOUND` | Saved card ID doesn't exist |
| 409 | `INVALID_STATE_TRANSITION` | Can't perform this action in current state (e.g., capture a failed payment) |
| 409 | `CONCURRENT_MODIFICATION` | Optimistic lock conflict — someone else modified this payment simultaneously |
| 502 | `CHECKOUT_FORM_INIT_FAILED` | Failed to initialize checkout form with iyzico |
| 502 | `CHECKOUT_FORM_RETRIEVE_FAILED` | Failed to retrieve checkout form result from iyzico |
| 502 | `CARD_STORAGE_INIT_FAILED` | Failed to initialize card storage form with iyzico |
| 502 | `CARD_STORAGE_RETRIEVE_FAILED` | Failed to retrieve card storage result from iyzico |
| 502 | `CARD_SAVE_FAILED` | Failed to register card with payment provider |

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
CREATED → AWAITING_FORM       (new card: checkout form initialized)
CREATED → AUTHORIZED          (saved card: direct pre-auth succeeded)
CREATED → FAILED              (declined / error)
AWAITING_FORM → AUTHORIZED    (checkout form completed successfully)
AWAITING_FORM → FAILED        (checkout form failed / cancelled)
AUTHORIZED → CAPTURED         (order service triggers capture)
AUTHORIZED → VOIDED           (order cancelled before capture)
CAPTURED → REFUNDED           (full refund)
```
