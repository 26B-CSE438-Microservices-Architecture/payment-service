# Payment Service

Handles payment lifecycle operations for the Trendyol clone platform. This service processes card payments via iyzico (Turkish payment gateway), manages saved cards, handles 3D Secure verification, and publishes payment state changes as events for other services to consume.

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

This maps to iyzico's `paymentPreAuth` / `paymentPostAuth` API regardless of whether 3DS is enabled or not.

### States

| State | Description |
|---|---|
| `CREATED` | Payment record exists, provider has not been called yet |
| `AWAITING_3DS` | Provider requires 3D Secure verification from the customer |
| `AUTHORIZED` | Funds reserved on the card, not yet captured |
| `CAPTURED` | Funds taken from the card (terminal success) |
| `FAILED` | Payment attempt failed (declined, expired, provider error) |
| `VOIDED` | Authorization released before capture (no money moved) |
| `REFUNDED` | Funds returned to user after capture (full refund only) |

### State Transitions

```
CREATED → AUTHORIZED         (provider approved, 3DS not required)
CREATED → AWAITING_3DS       (provider requires 3DS verification)
CREATED → FAILED             (declined / error)
AWAITING_3DS → AUTHORIZED    (3DS callback succeeded)
AWAITING_3DS → FAILED        (3DS callback failed / timed out)
AUTHORIZED → CAPTURED        (order service triggers capture)
AUTHORIZED → VOIDED          (order cancelled before capture)
CAPTURED → REFUNDED          (full refund)
```

### 3D Secure Flow

Controlled by the `PAYMENT_3DS_ENABLED` environment variable.

- **Off:** Payment is authorized immediately via iyzico's `paymentPreAuth.create`. Single request-response.
- **On:** Payment goes through iyzico's `threedsInitializePreAuth.create`. iyzico returns base64-encoded HTML (`threeDSHtmlContent`) that must be rendered in the customer's browser (iframe or WebView). The HTML redirects to the bank's 3DS page. After verification, the bank POSTs back to the `callbackUrl` with `paymentId` and `conversationData`. The caller then forwards these to our 3DS callback endpoint, and we call `threedsPayment.create` to finalize.

The authorize-capture model works the same in both cases — 3DS only affects the authorization step.

---

## API Contract

All monetary amounts are in **minor currency units** (kuruş for TRY). `15000` = 150.00 TL. Never use floats for money.

### Create Payment (Authorize)

Called by the Order Service when a user places an order.

```
POST /payments
Headers:
  Idempotency-Key: <uuid>
  Authorization: Bearer <jwt>
```

**Request Body (new card):**

```json
{
  "orderId": "ord_abc123",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "card": {
    "cardNumber": "5528790000000008",
    "expireMonth": "12",
    "expireYear": "2030",
    "cvc": "123",
    "cardHolderName": "John Doe"
  },
  "saveCard": true,
  "buyer": {
    "id": "user_123", "name": "John", "surname": "Doe",
    "email": "john@example.com", "identityNumber": "74300864791",
    "gsmNumber": "+905350000000", "registrationAddress": "Istanbul",
    "ip": "85.34.78.112", "city": "Istanbul", "country": "Turkey", "zipCode": "34000"
  },
  "items": [
    { "id": "item_1", "name": "Pizza", "category1": "Food", "itemType": "PHYSICAL", "price": "150.00" }
  ],
  "callbackUrl": "https://order-service/3ds-return/{paymentId}"
}
```

**Request Body (saved card):**

```json
{
  "orderId": "ord_abc123",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "savedCardId": "card_abc123",
  "buyer": { ... },
  "items": [ ... ],
  "callbackUrl": "https://order-service/3ds-return/{paymentId}"
}
```

- Send either `card` OR `savedCardId`, never both (400 error)
- `saveCard: true` saves the new card for future use after successful auth (only with `card`, not `savedCardId`)
- `buyer` and `items` are required by iyzico for compliance. Missing fields get placeholder defaults but log warnings.
- `amount` is in minor units (kuruş). 15000 = 150.00 TRY.
- `items[].price` is in major units (TRY) as a string. Sum must equal `amount / 100`.
- `callbackUrl` is optional. Only needed if 3DS is enabled. `{paymentId}` placeholder is replaced by us.

**Response — Authorized (201):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "orderId": "ord_abc123",
    "userId": "user_123",
    "status": "AUTHORIZED",
    "amount": 15000,
    "currency": "TRY",
    "provider": "iyzico",
    "providerTxId": "98765",
    "createdAt": "2026-02-25T14:30:00Z",
    "authorizedAt": "2026-02-25T14:30:01Z"
  }
}
```

**Response — 3DS Required (201):**

```json
{
  "payment": { "id": "pay_jkl345", "status": "AWAITING_3DS", ... },
  "threeDSRedirect": {
    "threeDSHtmlContent": "<base64-encoded HTML>"
  }
}
```

Decode the base64 HTML and render it in the customer's browser (iframe or full page). The HTML auto-submits to the bank's 3DS page.

**Response — Failed (201):**

```json
{
  "payment": {
    "id": "pay_jkl345",
    "status": "FAILED",
    "failureReason": "card_declined",
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

### 3DS Callback

Called after the bank redirects the customer back. **No auth required** (comes from bank redirect via Order Service).

```
POST /payments/:paymentId/3ds/callback
```

**Request Body:**

```json
{
  "paymentId": "98765",
  "conversationData": "opaque-string-from-bank"
}
```

Both fields come from the bank's POST to your `callbackUrl`. Forward them as-is.

**Response (200):** `{ "payment": { "status": "AUTHORIZED" | "FAILED", ... } }`

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

### Saved Cards

#### Save a Card (standalone)

```
POST /cards
Headers:
  Authorization: Bearer <jwt>
```

**Request Body:**

```json
{
  "card": {
    "cardNumber": "5528790000000008",
    "expireMonth": "12",
    "expireYear": "2030",
    "cardHolderName": "John Doe"
  },
  "email": "john@example.com",
  "cardAlias": "My Visa"
}
```

**Response (201):**

```json
{
  "card": {
    "id": "card_abc123",
    "userId": "user_123",
    "last4": "0008",
    "cardAssociation": "MASTERCARD",
    "cardType": "CREDIT",
    "cardBankName": "Halkbank",
    "cardAlias": "My Visa",
    "createdAt": "..."
  }
}
```

#### List Saved Cards

```
GET /cards
Headers:
  Authorization: Bearer <jwt>
```

**Response (200):** `{ "cards": [ ... ] }`

#### Delete a Saved Card

```
DELETE /cards/:cardId
Headers:
  Authorization: Bearer <jwt>
```

**Response:** `204 No Content`

---

### Health Check

```
GET /health
```

Returns 200 if the service, database, and RabbitMQ connection are all healthy. Returns 503 otherwise.

---

## Events Published (RabbitMQ)

Published to a **topic exchange** named `payment.events`. Other services bind their queues to the routing keys they care about.

| Routing Key | Trigger | Primary Consumer |
|---|---|---|
| `payment.authorized` | Card authorization succeeded (direct or after 3DS) | Order Service |
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

- Calls `POST /payments` when a user places an order (with `card` or `savedCardId`)
- Calls `POST /payments/:id/capture` when the restaurant accepts the order
- Calls `POST /payments/:id/cancel` when the order is cancelled
- Proxies `GET/POST/DELETE /cards` for saved card management
- Receives 3DS bank redirect at its own callback URL, forwards `paymentId` + `conversationData` to `POST /payments/:id/3ds/callback`
- Subscribes to `payment.*` events to update its own order state
- Owns the relationship between an order and its "current" payment attempt (stores the latest `paymentId`)

### Gateway / Auth Service

- All requests to this service pass through the gateway.
- The gateway attaches a JWT to each request. This service validates the JWT using the shared `JWT_SECRET`.

### Frontend / Mobile

- Never calls Payment API directly — always goes through Order Service
- Provides card details (or saved card selection) to Order Service, which forwards them to Payment Service
- Renders `threeDSHtmlContent` (base64 decode -> iframe or WebView) when 3DS is required
- Shows saved cards management UI (list, add, delete) via Order Service proxy

**Note on card data flow:** In the current implementation, raw card details pass from the client through Order Service to Payment Service to iyzico. This is a valid integration model (iyzico's Direct API), but in production it would require full PCI DSS SAQ D compliance. iyzico also offers a Checkout Form integration where their hosted JavaScript collects card details directly, so card data never touches the merchant's servers (SAQ A). Either model works — it's a trade-off between UI control and PCI scope.

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
│   │   ├── cards.js                Saved card endpoints (CRUD)
│   │   └── health.js               Health check (DB + RabbitMQ)
│   └── middleware/
│       ├── auth.js                 JWT validation / SKIP_AUTH bypass
│       ├── idempotency.js          Idempotency-Key handling
│       └── errorHandler.js         Consistent error response format
├── core/
│   ├── PaymentService.js           Payment orchestrator
│   ├── CardService.js              Saved card orchestrator
│   └── PaymentStateMachine.js      State transition validation
├── providers/
│   ├── index.js                    Provider factory (reads PAYMENT_PROVIDER)
│   ├── MockProvider.js             Mock provider for development/testing
│   └── IyzicoProvider.js           Real iyzico integration via iyzipay SDK
├── queue/
│   └── publisher.js                RabbitMQ event publisher
├── worker/
│   └── index.js                    Worker entry point (event monitor)
├── lib/
│   └── prisma.js                   Shared Prisma client instance
└── utils/
    └── id.js                       Payment + Card ID generation (pay_, card_ prefixes)

prisma/
├── schema.prisma                   Database models and relations
└── migrations/                     Auto-generated migration files

```

### Layering Principle

```
Route → Middleware → PaymentService / CardService → Provider / Prisma / Publisher
```

Routes never access the database directly. `PaymentService` orchestrates payments, `CardService` orchestrates saved cards. Database access goes through the shared Prisma client.

### Provider Interface

Both `MockProvider` and `IyzicoProvider` implement the same interface:

| Method | Purpose |
|---|---|
| `authorize()` | Pre-authorize a payment (direct or 3DS) |
| `complete3DS()` | Finalize a 3DS payment after bank callback |
| `capture()` | Capture an authorized payment |
| `void()` | Void an authorization |
| `refund()` | Refund a captured payment |
| `registerCard()` | Save a card for future use |
| `deleteCard()` | Remove a saved card |

Switch providers with `PAYMENT_PROVIDER=iyzico` or `PAYMENT_PROVIDER=mock` in `.env`.

---

## Database Schema (Prisma)

Schema is defined in `prisma/schema.prisma`. Migrations are auto-generated by Prisma.

**Payment** — stores each payment attempt:
- `id` (PK, `pay_` prefix + UUID), `idempotencyKey` (unique), `orderId`, `userId`
- `amount` (integer, minor currency units), `currency`, `method`, `status`
- `provider`, `providerTxId`, `failureReason`, `cancelReason`, `threeDSSessionToken`, `metadata` (JSON)
- Timestamps: `createdAt`, `authorizedAt`, `capturedAt`, `cancelledAt`, `updatedAt`
- Indexes on `orderId` and `status`

**PaymentEvent** — append-only audit log. Every state transition is recorded with who triggered it and when.
- `id` (auto-increment PK), `paymentId` (FK -> Payment), `fromStatus`, `toStatus`
- `triggeredBy`, `details` (JSON), `createdAt`
- Index on `paymentId`

**SavedCard** — stores saved cards for users:
- `id` (PK, `card_` prefix + UUID), `userId`, `cardUserKey` (iyzico user key), `cardToken` (iyzico card token)
- `last4`, `cardType`, `cardAssociation`, `cardBankName`, `cardAlias`
- `createdAt`
- Unique constraint on `(userId, cardToken)`, index on `userId`

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
| `PAYMENT_3DS_ENABLED` | `true` to enable 3D Secure |
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
| `CARD_NOT_FOUND` | 404 | Saved card ID doesn't exist |
| `CARD_NOT_OWNED` | 403 | Card belongs to a different user |
| `INVALID_STATE_TRANSITION` | 409 | Action not allowed in current payment state |
| `CONCURRENT_MODIFICATION` | 409 | Another request modified the payment simultaneously |
| `AMOUNT_MISMATCH` | 400 | Capture amount doesn't match authorized amount |
| `MISSING_IDEMPOTENCY_KEY` | 400 | `Idempotency-Key` header not provided |
| `MISSING_CARD_DETAILS` | 400 | Neither card details nor savedCardId provided |
| `UNAUTHORIZED` | 401 | Missing or invalid JWT |

---

## What's Not Implemented

- Cash on delivery payments
- Partial capture / partial refund
- Webhook receiver from payment provider
- Rate limiting (handled by gateway)
- iyzico Checkout Form integration (alternative to Direct API where iyzico hosts the card form)
