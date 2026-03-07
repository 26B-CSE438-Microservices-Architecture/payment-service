# Payment Service

Handles payment lifecycle operations for the Trendyol clone platform. This service processes card payments via a third-party provider and publishes payment state changes as events for other services to consume.

**Tech Stack:** Node.js (Express), PostgreSQL (Prisma ORM), RabbitMQ

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

### States

| State | Description |
|---|---|
| `CREATED` | Payment record exists, no processing has occurred yet |
| `AUTHORIZED` | Funds reserved on the card, not yet captured |
| `CAPTURED` | Funds taken from the card (terminal success) |
| `FAILED` | Payment attempt failed (declined, expired, provider error) |
| `VOIDED` | Authorization released before capture (no money moved) |
| `REFUNDED` | Funds returned to user after capture (full refund only) |

### State Transitions

```
CREATED → AUTHORIZED         (provider approved)
CREATED → FAILED             (declined / error)
AUTHORIZED → CAPTURED        (order service triggers capture)
AUTHORIZED → VOIDED          (order cancelled before capture)
CAPTURED → REFUNDED          (full refund)
```

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

**Request Body:**

```json
{
  "orderId": "ord_abc123",
  "userId": "usr_def456",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": {
    "type": "card",
    "card": {
      "token": "tok_xyz789"
    }
  },
  "metadata": {
    "restaurantId": "rst_ghi012"
  }
}
```

- `card.token` is a token produced by the payment provider's client-side SDK. **This service never receives raw card numbers.**

**Response — Card Authorized (201):**

```json
{
  "paymentId": "pay_jkl345",
  "orderId": "ord_abc123",
  "status": "AUTHORIZED",
  "amount": 15000,
  "currency": "TRY",
  "createdAt": "2026-02-25T14:30:00Z"
}
```

**Response — Card Declined (201):**

```json
{
  "paymentId": "pay_jkl345",
  "orderId": "ord_abc123",
  "status": "FAILED",
  "amount": 15000,
  "currency": "TRY",
  "failureReason": "card_declined",
  "createdAt": "2026-02-25T14:30:00Z"
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
  "paymentId": "pay_jkl345",
  "status": "CAPTURED",
  "capturedAmount": 15000,
  "capturedAt": "2026-02-25T14:35:00Z"
}
```

---

### Cancel Payment (Void or Refund)

Called by the Order Service when an order is cancelled. The service internally decides whether to void (if `AUTHORIZED`) or refund (if `CAPTURED`).

```
POST /payments/:paymentId/cancel
```

**Request Body:**

```json
{
  "reason": "restaurant_rejected"
}
```

- `reason` is required for the audit trail.
- Always cancels the full amount. Partial refunds are not supported.

**Response (200):**

```json
{
  "paymentId": "pay_jkl345",
  "status": "VOIDED",
  "cancelledAmount": 15000,
  "cancelledAt": "2026-02-25T14:32:00Z"
}
```

The `status` field will be `VOIDED` if the payment was authorized but not captured, or `REFUNDED` if it was captured.

---

### Get Payment

```
GET /payments/:paymentId
```

**Response (200):**

```json
{
  "paymentId": "pay_jkl345",
  "orderId": "ord_abc123",
  "userId": "usr_def456",
  "status": "AUTHORIZED",
  "amount": 15000,
  "currency": "TRY",
  "paymentMethod": "card",
  "provider": "stripe",
  "createdAt": "2026-02-25T14:30:00Z",
  "authorizedAt": "2026-02-25T14:30:01Z",
  "capturedAt": null,
  "failureReason": null
}
```

---

### Get Payments by Order

```
GET /payments?orderId=ord_abc123
```

Returns all payment attempts for a given order (there may be multiple if the user retried after a failure). Results are ordered by creation time, most recent first.

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
| `payment.authorized` | Card authorization succeeded | Order Service |
| `payment.captured` | Funds taken | Order Service |
| `payment.failed` | Payment attempt failed | Order Service |
| `payment.voided` | Authorization released | Order Service |
| `payment.refunded` | Funds returned | Order Service |

**Event Payload Shape:**

```json
{
  "event": "payment.authorized",
  "paymentId": "pay_jkl345",
  "orderId": "ord_abc123",
  "userId": "usr_def456",
  "amount": 15000,
  "currency": "TRY",
  "timestamp": "2026-02-25T14:30:01Z"
}
```

---

## Integration Map

### Order Service (Primary Consumer)

- Calls `POST /payments` when a user places an order.
- Calls `POST /payments/:id/capture` when the restaurant accepts the order.
- Calls `POST /payments/:id/cancel` when the order is cancelled.
- Subscribes to `payment.*` events to update its own order state.
- Owns the relationship between an order and its "current" payment attempt (stores the latest `paymentId`).

### Gateway / Auth Service

- All requests to this service pass through the gateway.
- The gateway attaches a JWT to each request. This service validates the JWT.

### Frontend / Mobile

- Integrates the payment provider's client-side SDK (e.g., Stripe.js) to tokenize card details.
- Sends the token to the Order Service, which forwards it to the Payment Service.
- **Never sends raw card numbers to any backend service.**

### DevOps

- This service runs **two processes**: an API server and a background worker.
- Requires PostgreSQL (per-service) and RabbitMQ (central, managed by DevOps).
- Exposes `GET /health` for probes.

---

## Internal Architecture

```
src/
├── api/
│   ├── routes/
│   │   ├── payments.js             Route definitions
│   │   └── health.js               Health check
│   └── middleware/
│       ├── auth.js                 JWT validation
│       └── idempotency.js          Idempotency-Key check
│
├── core/
│   ├── PaymentService.js           Orchestrator — the central brain
│   └── PaymentStateMachine.js      Validates and enforces state transitions
│
├── providers/
│   └── MockProvider.js             Mock provider for development/testing
│
├── worker/
│   └── index.js                    Worker entry point
│
├── queue/
│   └── publisher.js                Publish events to RabbitMQ
│
├── config/
│   └── index.js                    Environment-based configuration
│
├── generated/prisma/               Auto-generated Prisma client (gitignored)
│
└── index.js                        API server entry point

prisma/
├── schema.prisma                   Database models and relations
└── migrations/                     Auto-generated migration files
```

### Layering Principle

```
Route → Middleware → PaymentService → Provider / Prisma / Publisher
```

Routes never access the database directly. The `PaymentService` is the sole orchestrator. Database access goes through Prisma client directly — no extra repository layer.

---

## Database Schema (Prisma)

Schema is defined in `prisma/schema.prisma`. Migrations are auto-generated by Prisma.

**Payment** — stores each payment attempt:
- `id` (PK), `idempotencyKey` (unique), `orderId`, `userId`
- `amount` (integer, minor currency units), `currency`, `method`, `status`
- `provider`, `providerTxId`, `failureReason`, `metadata` (JSON)
- Timestamps: `createdAt`, `authorizedAt`, `capturedAt`, `cancelledAt`, `updatedAt`
- Indexes on `orderId` and `status`

**PaymentEvent** — append-only audit log. Every state transition is recorded with who triggered it and when.
- `id` (auto-increment PK), `paymentId` (FK → Payment), `fromStatus`, `toStatus`
- `triggeredBy`, `details` (JSON), `createdAt`
- Index on `paymentId`

### Concurrency Control

State transitions use Prisma interactive transactions (`prisma.$transaction`) to prevent race conditions (e.g., capture and cancel arriving simultaneously for the same payment).

---

## Docker Setup

```yaml
# docker-compose.yml
services:
  postgres:    # Payment DB (local to this service)
  api:         # Express server — handles HTTP requests
  worker:      # Consumes RabbitMQ messages
```

- **PostgreSQL** is local to this service.
- **RabbitMQ** is central, managed by the DevOps team. Both `api` and `worker` connect to it via `RABBITMQ_URL`.
- Both `api` and `worker` use the same Docker image with different start commands.

Run with: `docker compose up --build`

Prisma migrations are applied automatically on `api` startup via `npx prisma migrate deploy`.

---

## Infrastructure Requirements

### Processes

| Process | Description |
|---|---|
| API Server | Handles HTTP requests from other services |
| Worker | Consumes RabbitMQ messages and publishes events |

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `RABBITMQ_URL` | RabbitMQ connection string (central, from DevOps) |
| `PAYMENT_PROVIDER` | Active provider (`mock` for now) |
| `PORT` | API server port (default: 3000) |
| `NODE_ENV` | `development`, `production`, `test` |

---

## What's Not in MVP

The following are intentionally excluded from the initial implementation and can be added later:

- Cash on delivery payments
- Partial capture / partial refund
- 3D Secure (3DS) flow
- Saved payment methods / wallet
- Webhook receiver from payment provider
- Rate limiting (handled by gateway)
    