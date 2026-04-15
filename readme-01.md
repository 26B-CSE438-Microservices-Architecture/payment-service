# Payment Service

Handles payment lifecycle operations for the Trendyol clone platform. This service processes card payments via iyzico (Turkish payment gateway) using iyzico's hosted **Checkout Form** (PCI-safe — raw card data never touches our servers), and publishes payment state changes as events for other services to consume.

**Tech Stack:** Node.js (Express 5), PostgreSQL (Prisma ORM), RabbitMQ, iyzico

---

## Table of Contents

1. [Payment Lifecycle](#payment-lifecycle)
2. [API Contract](#api-contract)
3. [Events Published (RabbitMQ)](#events-published-rabbitmq)
4. [Integration Map](#integration-map)
5. [Internal Architecture](#internal-architecture)
6. [Database Schema](#database-schema)
7. [Docker Setup](#docker-setup)
8. [Infrastructure Requirements](#infrastructure-requirements)

---

## Payment Lifecycle

### Payment Model: Authorize → Capture

This service uses a **pre-authorization model**. When a customer pays, we only _reserve_ the funds (authorize). The funds are actually _taken_ (captured) later when the restaurant confirms the order. This allows voiding the authorization if the order is cancelled, without ever moving money.

This maps to iyzico's `checkoutFormInitializePreAuth` (auth via hosted form) and `paymentPostAuth.create` (capture).

### States

| State | Description |
|---|---|
| `CREATED` | Payment record exists, provider has not been called yet |
| `AWAITING_FORM` | Checkout Form initialized; waiting for customer to complete iyzico's hosted form |
| `AUTHORIZED` | Funds reserved on the card, not yet captured |
| `CAPTURED` | Funds taken from the card (terminal success) |
| `FAILED` | Payment attempt failed (declined, expired, provider error) |
| `VOIDED` | Authorization released before capture (no money moved) |
| `REFUNDED` | Funds returned to user after capture (full refund only) |

### State Transitions

```
CREATED → AWAITING_FORM      (checkout form initialized)
CREATED → FAILED             (init error)
AWAITING_FORM → AUTHORIZED   (checkout form completed successfully)
AWAITING_FORM → FAILED       (checkout form failed / cancelled)
AUTHORIZED → CAPTURED        (order service triggers capture)
AUTHORIZED → VOIDED          (order cancelled before capture)
CAPTURED → REFUNDED          (full refund)
```

### Checkout Form Flow

All payments go through iyzico's hosted Checkout Form. 3D Secure is handled internally by iyzico based on the card — we don't orchestrate it.

1. **Init:** `POST /payments` → we call `checkoutFormInitializePreAuth.create` → iyzico returns a `token` and `content` (HTML for the hosted form). Payment transitions `CREATED → AWAITING_FORM`. We return `{ payment, checkoutForm: { token, content, paymentPageUrl } }` to the caller.
2. **Render:** The caller renders `content` in an iframe/WebView. The customer enters card details on iyzico's servers. iyzico runs 3DS internally if needed.
3. **Callback:** After form completion, iyzico POSTs to the `callbackUrl` with a `token`. The Order Service forwards this to `POST /payments/:id/checkout-form/callback`.
4. **Retrieve:** We call `checkoutForm.retrieve(token)` to get the final result. Payment transitions `AWAITING_FORM → AUTHORIZED | FAILED`.

---

## API Contract

All monetary amounts are in **minor currency units** (kuruş for TRY). `15000` = 150.00 TL. Never use floats for money.

### Create Payment (Initialize Checkout Form)

Called by the Order Service when a user places an order.

```
POST /payments
Headers:
  Idempotency-Key: <uuid>
  Authorization: Bearer <jwt>
```

**Request Body:**

```json
{
  "orderId": "ord_abc123",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "buyer": {
    "id": "user_123", "name": "John", "surname": "Doe",
    "email": "john@example.com", "identityNumber": "74300864791",
    "gsmNumber": "+905350000000", "registrationAddress": "Istanbul",
    "ip": "85.34.78.112", "city": "Istanbul", "country": "Turkey", "zipCode": "34000"
  },
  "items": [
    { "id": "item_1", "name": "Pizza", "category1": "Food", "itemType": "PHYSICAL", "price": "150.00" }
  ],
  "callbackUrl": "https://order-service/checkout-form-return/{paymentId}"
}
```

- **No `card` field.** Card details are entered on iyzico's hosted form, not passed through our API.
- `buyer` and `items` are required by iyzico for compliance. Missing fields get placeholder defaults but log warnings.
- `amount` is in minor units (kuruş). 15000 = 150.00 TRY.
- `items[].price` is in major units (TRY) as a string. Sum must equal `amount / 100`.
- `callbackUrl` is required. `{paymentId}` placeholder is replaced by us.

**Response — Checkout Form Initialized (201):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "orderId": "ord_abc123",
    "userId": "user_123",
    "status": "AWAITING_FORM",
    "amount": 15000,
    "currency": "TRY",
    "provider": "iyzico",
    "createdAt": "2026-02-25T14:30:00Z"
  },
  "checkoutForm": {
    "token": "cf_token_abc123",
    "content": "<base64-encoded or raw HTML>",
    "paymentPageUrl": "https://sandbox-api.iyzipay.com/..."
  }
}
```

Render `content` in the customer's browser (iframe or WebView). MockProvider returns base64-encoded HTML; real iyzico may return raw HTML — try base64-decoding first and fall back to using content as-is.

**Response — Init Failed (201):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "status": "FAILED",
    "failureReason": "checkout_form_init_error",
    ...
  }
}
```

Note: A failed payment still returns 201 because the payment *record* was successfully created. The status field communicates the outcome.

**Response — Duplicate Idempotency Key (200):**

If the same `Idempotency-Key` header is sent again, the original response is returned without reprocessing.

**Retry Behavior:**

A single order can have multiple payment attempts (e.g., first card declined, user tries a different card). Each attempt uses a different `Idempotency-Key`. When a new payment is created for an `orderId` that already has an `AUTHORIZED` payment, the old payment is automatically voided.

---

### Checkout Form Callback

Called after iyzico's hosted form completes and posts back to the `callbackUrl`. **No auth required** (comes from the customer's browser redirect via Order Service).

```
POST /payments/:paymentId/checkout-form/callback
```

**Request Body:**

```json
{
  "token": "cf_token_abc123"
}
```

The `token` comes from iyzico's POST to your `callbackUrl`. Forward it as-is.

**Response (200):** `{ "payment": { "status": "AUTHORIZED" | "FAILED", ... } }`

---

### Capture Payment

Called by the Order Service when the restaurant confirms the order.

```
POST /payments/:paymentId/capture
Headers:
  Authorization: Bearer <jwt>
```

**Request Body:**

```json
{
  "amount": 15000
}
```

- `amount` must match the full authorized amount. Partial capture is not supported.

**Response (200):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "status": "CAPTURED",
    "capturedAt": "2026-02-25T14:35:00Z",
    ...
  }
}
```

---

### Cancel Payment (Void or Refund)

Called by the Order Service when an order is cancelled. The service internally decides whether to void (if `AUTHORIZED`) or refund (if `CAPTURED`).

```
POST /payments/:paymentId/cancel
Headers:
  Authorization: Bearer <jwt>
```

**Request Body:**

```json
{
  "reason": "restaurant_rejected"
}
```

- Always cancels the full amount. Partial refunds are not supported.

**Response (200):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "status": "VOIDED",
    "cancelReason": "restaurant_rejected",
    "cancelledAt": "2026-02-25T14:32:00Z",
    ...
  }
}
```

The `status` field will be `VOIDED` if the payment was authorized but not captured, or `REFUNDED` if it was captured.

---

### Get Payment

```
GET /payments/:paymentId
Headers:
  Authorization: Bearer <jwt>
```

**Response (200):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "orderId": "ord_abc123",
    "userId": "user_123",
    "status": "AUTHORIZED",
    "amount": 15000,
    "currency": "TRY",
    "method": "card",
    "provider": "iyzico",
    "providerTxId": "98765",
    "createdAt": "2026-02-25T14:30:00Z",
    "authorizedAt": "2026-02-25T14:30:01Z",
    "capturedAt": null,
    "failureReason": null
  }
}
```

---

### Get Payments by Order

```
GET /payments?orderId=ord_abc123
Headers:
  Authorization: Bearer <jwt>
```

Returns all payment attempts for a given order (there may be multiple if the user retried after a failure). Results are ordered by creation time, most recent first.

**Response (200):** `{ "payments": [ ... ] }`

---

### Health Check

```
GET /health
```

Returns 200 if the service, database, and RabbitMQ connection are all healthy. Returns 503 otherwise.

---

## Card Saving — Out of Scope

This service does not support saving cards. iyzico's sandbox blocks both save paths (Universal Card Storage isn't enabled on sandbox merchants, and the "save during checkout" checkbox triggers a phone-ownership SMS that never arrives in sandbox), so the feature can't be tested end-to-end. So it was cut. Every payment starts a fresh Checkout Form.

---

## Events Published (RabbitMQ)

Published to a **topic exchange** named `payment.events`. Other services bind their queues to the routing keys they care about.

| Routing Key | Trigger | Primary Consumer |
|---|---|---|
| `payment.authorized` | Card authorization succeeded after checkout form | Order Service |
| `payment.captured` | Funds taken | Order Service |
| `payment.failed` | Payment attempt failed | Order Service |
| `payment.voided` | Authorization released | Order Service |
| `payment.refunded` | Funds returned | Order Service |

**Event Payload Shape:**

```json
{
  "paymentId": "pay_jkl345",
  "orderId": "ord_abc123",
  "userId": "user_123",
  "amount": 15000,
  "currency": "TRY",
  "status": "AUTHORIZED",
  "timestamp": "2026-02-25T14:30:01Z"
}
```

---

## Integration Map

### Order Service (Primary Consumer)

- Calls `POST /payments` when a user places an order (no card data — just amount, buyer, items, callbackUrl)
- Renders `checkoutForm.content` to the customer (or returns it to the frontend for rendering)
- Receives iyzico's callback POST at its own `callbackUrl`, forwards the `token` to `POST /payments/:id/checkout-form/callback`
- Calls `POST /payments/:id/capture` when the restaurant accepts the order
- Calls `POST /payments/:id/cancel` when the order is cancelled
- Subscribes to `payment.*` events to update its own order state
- Owns the relationship between an order and its "current" payment attempt (stores the latest `paymentId`)

### Gateway / Auth Service

- All requests to this service pass through the gateway.
- The gateway attaches a JWT to each request. This service validates the JWT using the shared `JWT_SECRET`.

###  Mobile

- Never calls Payment API directly — always goes through Order Service
- Renders `checkoutForm.content` (try base64 decode → fall back to raw HTML → iframe or WebView) when payment returns `AWAITING_FORM`
- Customer enters card details on iyzico's hosted form — no card UI on our side
- **Mobile-specific:** `postMessage` doesn't reliably work in native WebViews; intercept navigation to `callbackUrl` and extract the `token` from the POST body or URL params.

**PCI scope:** Raw card data (PAN, CVC, expiry) never flows through our servers. The Checkout Form is hosted by iyzico — this keeps all of our services in PCI DSS SAQ A scope rather than SAQ D.

### DevOps

- This service runs **two processes**: an API server and a background worker.
- Requires PostgreSQL (per-service) and RabbitMQ (central, managed by DevOps).
- Exposes `GET /health` for probes.

---

## Internal Architecture

```
src/
├── index.js                        API server entry point
├── config/
│   └── index.js                    Environment-based configuration
├── api/
│   ├── routes/
│   │   ├── payments.js             Payment endpoints
│   │   └── health.js               Health check (DB + RabbitMQ)
│   └── middleware/
│       ├── auth.js                 JWT validation / SKIP_AUTH bypass
│       ├── idempotency.js          Idempotency-Key handling
│       └── errorHandler.js         Consistent error response format
├── core/
│   ├── PaymentService.js           Payment orchestrator
│   └── PaymentStateMachine.js      State transition validation
├── providers/
│   ├── index.js                    Provider factory (reads PAYMENT_PROVIDER)
│   ├── MockProvider.js             Mock provider (simulated checkout form)
│   └── IyzicoProvider.js           Real iyzico integration via iyzipay SDK
├── queue/
│   └── publisher.js                RabbitMQ event publisher
├── worker/
│   └── index.js                    Worker entry point (event monitor)
├── lib/
│   └── prisma.js                   Shared Prisma client instance
└── utils/
    └── id.js                       Payment ID generation (pay_ prefix)

prisma/
├── schema.prisma                   Database models and relations
└── migrations/                     Auto-generated migration files
```

### Layering Principle

```
Route → Middleware → PaymentService → Provider / Prisma / Publisher
```

Routes never access the database directly. `PaymentService` orchestrates payments. Database access goes through the shared Prisma client.

### Provider Interface

Both `MockProvider` and `IyzicoProvider` implement the same interface:

| Method | Purpose |
|---|---|
| `initCheckoutForm()` | Initialize iyzico's hosted payment form (pre-auth mode) |
| `retrieveCheckoutForm()` | Retrieve the final result after the customer completes the form |
| `capture()` | Capture an authorized payment |
| `void()` | Void an authorization |
| `refund()` | Refund a captured payment (try cancel first, fall back to per-item refund) |

Switch providers with `PAYMENT_PROVIDER=iyzico` or `PAYMENT_PROVIDER=mock` in `.env`.

---

## Database Schema (Prisma)

Schema is defined in `prisma/schema.prisma`. Migrations are auto-generated by Prisma.

**Payment** — stores each payment attempt:
- `id` (PK, `pay_` prefix + UUID), `idempotencyKey` (unique), `orderId`, `userId`
- `amount` (integer, minor currency units), `currency`, `method`, `status`
- `provider`, `providerTxId`, `failureReason`, `cancelReason`, `metadata` (JSON — stores `buyer`, `items`, `itemTransactions`, `checkoutFormToken`)
- Timestamps: `createdAt`, `authorizedAt`, `capturedAt`, `cancelledAt`, `updatedAt`
- Indexes on `orderId` and `status`

**PaymentEvent** — append-only audit log. Every state transition is recorded with who triggered it and when.
- `id` (auto-increment PK), `paymentId` (FK → Payment), `fromStatus`, `toStatus`
- `triggeredBy`, `details` (JSON), `createdAt`
- Index on `paymentId`

### Concurrency Control

State transitions use optimistic locking: `UPDATE ... WHERE id = X AND status = expected_status`. If 0 rows affected, it's a conflict (409 CONCURRENT_MODIFICATION).

---

## Docker Setup

```yaml
services:
  payment-postgres:      # PostgreSQL database (local to this service)
  payment-rabbitmq:      # RabbitMQ message broker (local stand-in for central RabbitMQ)
  payment-api:           # Express server — handles HTTP requests
  payment-worker:        # Event monitor — consumes RabbitMQ messages
```

All containers and volumes are prefixed `payment-`.

### Port Mappings

| Service | Host Port | Description |
|---|---|---|
| PostgreSQL | `5432` | Database |
| RabbitMQ | `5672` | AMQP protocol |
| RabbitMQ | `15672` | Management UI |
| API | `3000` | Payment API |

### Running

```bash
docker compose up --build
```

Prisma migrations are applied automatically on API startup via `npx prisma migrate deploy`.

### RabbitMQ Note

The `payment-rabbitmq` container is a **local stand-in** for the central RabbitMQ that the DevOps team manages. When the central instance is available, just change `RABBITMQ_URL` in the environment and remove the rabbitmq service from docker-compose. Zero code changes needed.

---

## Infrastructure Requirements

### Processes

| Process | Description |
|---|---|
| API Server | Handles HTTP requests from other services |
| Worker | Consumes and logs RabbitMQ events |

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `RABBITMQ_URL` | RabbitMQ connection string (central, from DevOps) |
| `PAYMENT_PROVIDER` | Active provider (`iyzico` or `mock`) — **required, no default** |
| `SKIP_AUTH` | `true` bypasses JWT (dev only) |
| `JWT_SECRET` | Shared with Auth Service for JWT validation |
| `IYZICO_API_KEY` | iyzico sandbox/production API key |
| `IYZICO_SECRET_KEY` | iyzico sandbox/production secret key |
| `IYZICO_BASE_URL` | iyzico API base URL (default: sandbox) |
| `PORT` | API server port (default: 3000) |
| `NODE_ENV` | `development`, `production`, `test` |

---

## Error Response Format

All errors follow a consistent format:

```json
{
  "error": {
    "code": "PAYMENT_NOT_FOUND",
    "message": "No payment found with id pay_abc123"
  }
}
```

| Error Code | HTTP Status | Description |
|---|---|---|
| `PAYMENT_NOT_FOUND` | 404 | Payment ID doesn't exist |
| `INVALID_STATE_TRANSITION` | 409 | Action not allowed in current payment state |
| `CONCURRENT_MODIFICATION` | 409 | Another request modified the payment simultaneously |
| `AMOUNT_MISMATCH` | 400 | Capture amount doesn't match authorized amount |
| `MISSING_IDEMPOTENCY_KEY` | 400 | `Idempotency-Key` header not provided |
| `MISSING_FORM_TOKEN` | 400 | Checkout form callback missing `token` field |
| `CHECKOUT_FORM_INIT_FAILED` | 502 | Failed to initialize checkout form with iyzico |
| `CHECKOUT_FORM_RETRIEVE_FAILED` | 502 | Failed to retrieve checkout form result from iyzico |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |

---

## What's Not Implemented

- Card saving (intentionally cut — see "Card Saving — Out of Scope" above)
- Cash on delivery payments
- Partial capture / partial refund
- Webhook receiver from payment provider (iyzico has no global webhook)
