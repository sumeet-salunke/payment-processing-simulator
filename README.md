# Payment Processing Simulator

A production-style payment processing backend and checkout simulator engineered in **Node.js, Express, MongoDB/Mongoose, and Redis/BullMQ**, paired with a **React/Vite** mobile-ready payment page.

The simulator models mission-critical payment architecture including **atomic state machines, multi-document transactions, client idempotency, signed webhook delivery with deduplication, background retry queues with exponential backoff, in-flight attempt overlap locking, order expiration background workers, and deterministic failure injection**.

---

## 1. System Architecture

```text
               +-------------------------------------------------------------+
               |                       Customer Device                       |
               |             (Browser / Mobile QR Code Scanner)              |
               +-------------------------------------------------------------+
                                       |              ^
                 1. Scan QR Session URL|              | 6. Poll / Status
                                       v              |
               +-------------------------------------------------------------+
               |                    React Payment Webpage                    |
               |                (/payment/:sessionId - Vite)                 |
               +-------------------------------------------------------------+
                                       |
                     2. Click Pay Now  | (Idempotency-Key: idem-xxx)
                                       v
+-------------------------------------------------------------------------------------------+
|                                    Express API Backend                                    |
|                                                                                           |
|  [CORS & Security]  -->  [Request Validation]  -->  [Client Idempotency Filter]           |
|                                                                 |                         |
|  +--------------------------------------------------------------v----------------------+  |
|  | Payment Session Service                                                            |  |
|  | - Verifies Session Expiration (410 if expired)                                      |  |
|  | - Verifies Order Status (409 if already PAID)                                       |  |
|  | - Evaluates In-Flight Attempt Locking (409 if existing attempt is PROCESSING)       |  |
|  +--------------------------------------------------------------+----------------------+  |
|                                                                 |                         |
|  +--------------------------------------------------------------v----------------------+  |
|  | Payment Service                                                                     |  |
|  | - Creates Payment Attempt Document (attemptNumber incremented, status: PENDING)     |  |
|  | - Transitions Payment to PROCESSING                                                 |  |
|  | - Invokes Payment Provider Simulation                                               |  |
|  +--------------------------------------------------------------+----------------------+  |
|                                                                 |                         |
|  +--------------------------------------------------------------v----------------------+  |
|  | Simulated Payment Provider                                                          |  |
|  | - Processes simulated authorization                                                 |  |
|  | - Signs payload with HMAC-SHA256                                                    |  |
|  | - Dispatches signed webhook to POST /api/webhooks/payment                           |  |
|  +-------------------------------------------------------------------------------------+  |
|                                                                                           |
|  +-------------------------------------------------------------------------------------+  |
|  | Webhook Ingestion & Transactional Settlement                                        |  |
|  | - Verifies HMAC SHA-256 with timingSafeEqual                                        |  |
|  | - Enforces Webhook Idempotency (eventId deduplication in WebhookEvents)             |  |
|  | - Executes MongoDB Multi-Document Transaction:                                      |  |
|  |     * Atomically transitions Payment to SUCCESS or FAILED                           |  |
|  |     * Atomically transitions Order to PAID (on success)                             |  |
|  |     * Atomically marks WebhookEvent as PROCESSED                                    |  |
|  | - If Transaction Fails: WebhookEvent set to FAILED & enqueued in BullMQ retry queue  |  |
+-------------------------------------------------------------------------------------------+
               |                                              |
               v                                              v
+-----------------------------+               +-------------------------------+
|       MongoDB Atlas         |               |         Redis / BullMQ        |
| - Orders                    |               | - Webhook Retry Queue         |
| - Payments (Attempts)       |               | - Exponential Backoff         |
| - PaymentSessions           |               | - Background Retry Worker     |
| - IdempotencyKeys           |               +-------------------------------+
| - WebhookEvents             |
+-----------------------------+
```

---

## 2. Directory Structure

### Backend (`/backend`)
```text
backend/
├── src/
│   ├── config/              # Centralized configuration (DNS resolvers, Redis connection)
│   ├── constants/           # Enums for Order, Payment, Webhook, and Failure modes
│   ├── controllers/         # HTTP request/response handlers
│   ├── databases/           # MongoDB Mongoose connection manager
│   ├── helpers/             # Business state machine, ID generators, invariant verification
│   ├── middlewares/         # CORS, error handling, centralized validation
│   ├── models/              # Mongoose schemas (Order, Payment, PaymentSession, etc.)
│   ├── queues/              # BullMQ queue instances and non-blocking job enqueueing
│   ├── repositories/        # Database access layer (isolated query & update methods)
│   ├── routes/              # Express route declarations
│   ├── services/            # Domain logic (order, payment, session, webhook, failure)
│   ├── utils/               # ApiError, ApiResponse, asyncHandler wrappers
│   ├── workers/             # BullMQ background workers for retry processing
│   ├── app.js               # Express application initialization and middleware chain
│   └── server.js            # Server entrypoint, background order sweeper, graceful shutdown
└── tests/                   # Native Node.js test runner test suites
    ├── clientIdempotency.test.js
    ├── consistencyAndReliability.test.js
    ├── paymentAttempts.test.js
    ├── paymentFlow.integration.test.js
    ├── paymentSession.test.js
    ├── productionHardening.test.js
    └── reliability.test.js
```

### Frontend (`/frontend`)
```text
frontend/
├── src/
│   ├── api/                 # API client layer (Fetch wrapper with error standardization)
│   ├── pages/               # PaymentPage.jsx (simulation UI, state indicators, retries)
│   ├── App.jsx              # Client router (/payment/:sessionId route)
│   ├── index.css            # Responsive styles and animations
│   └── main.jsx             # React DOM root mounting
├── index.html
└── vite.config.js
```

---

## 3. Core Architectural Lifecycles & Principles

### A. Order Lifecycle & Background Expiration
```text
                  +-------------------+
                  |      PENDING      |
                  +-------------------+
                     /             \
 (Payment SUCCESS)  /               \ (expiresAt reached & no active PROCESSING payment)
                   v                 v
            +------------+     +---------------+
            |    PAID    |     |   CANCELLED   |
            +------------+     +---------------+
```
- Orders default to `PENDING` with a 30-minute expiration timestamp (`expiresAt`).
- A background sweeper (`orderService.sweepExpiredOrders()`) runs periodically in `server.js`.
- **Invariants**:
  - `PAID` orders can never be cancelled.
  - An order with an active `PROCESSING` payment attempt is **guarded from cancellation** to prevent race conditions during transaction completion.

### B. Payment State Machine & Attempt Modeling
Payments are modeled as individual **Attempt Documents** linked to an `orderId`:
```text
Order: ORD-1001
 ├── Attempt #1 (PAY-A) -> status: FAILED     (recorded permanently)
 └── Attempt #2 (PAY-B) -> status: SUCCESS    --> Order transitions to PAID
```
Transitions follow a strict, uni-directional state machine:
```text
PENDING ──> PROCESSING ──> SUCCESS (terminal)
                      └──> FAILED  (terminal)
```
- **In-Flight Overlap Guard**: If an attempt is currently `PROCESSING`, any subsequent payment creation for that order is rejected with `409 Conflict`.
- **Terminal Protection**: Once an attempt reaches `SUCCESS` or `FAILED`, no backward or duplicate transitions are permitted.

### C. Client Request Idempotency
- Requests to `/api/payments/:paymentId/process` and `/api/payment-sessions/:sessionId/pay` support the `Idempotency-Key` header.
- Handled via `IdempotencyKey` collection:
  - If a duplicate request is received while the first is `PROCESSING`, it returns `409 Conflict`.
  - Once the first request completes, subsequent retries return the exact **cached response** and status code without executing downstream logic or provider calls.

### D. QR-Based Payment Sessions
- QR codes point to `/payment/:sessionId` — the URL **never includes an amount, status, or customer credentials**.
- The backend remains the single source of truth for amounts and statuses.
- Sessions automatically transition to `EXPIRED` if accessed after `expiresAt`.

### E. Signed Webhooks & Event Idempotency
- Provider signs webhook payloads with `HMAC-SHA256` using `WEBHOOK_SECRET`.
- Signature is verified using `crypto.timingSafeEqual` over the raw request buffer (`req.rawBody`).
- Every webhook payload contains an `eventId`.
- Duplicate delivery of an already `PROCESSED` event is immediately acknowledged (`200 OK`) without re-running MongoDB transactions.

### F. MongoDB Multi-Document Transactions
- Payment transitions to `SUCCESS`, Order transitions to `PAID`, and WebhookEvent transitions to `PROCESSED` occur within a single atomic MongoDB transaction.
- If any stage aborts, all documents roll back to their pre-transaction state, and the webhook event is marked `FAILED` for background retry.

### G. Redis / BullMQ Retries
- Failed webhook events are dispatched to a BullMQ queue (`webhookRetryQueue`).
- Configured with exponential backoff (`delay = 5000 * 2^(attempt - 1)`).
- If Redis is unavailable in local development or test environments, enqueueing gracefully times out without crashing or blocking HTTP transactions.

---

## 4. API Reference

| Method | Endpoint | Description | Key Headers / Body |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/health` | System health, MongoDB status, uptime | None |
| `POST` | `/api/orders` | Create a new order | Body: `{ userId, amount, currency? }` |
| `GET` | `/api/orders/:orderId/payments` | Fetch all payment attempts for order | Params: `orderId` |
| `POST` | `/api/orders/:orderId/payment-session` | Create QR payment session | Params: `orderId` |
| `GET` | `/api/payment-sessions/:sessionId` | Retrieve session and order metadata | Params: `sessionId` |
| `POST` | `/api/payment-sessions/:sessionId/pay` | Pay through active session | Headers: `Idempotency-Key` (opt), Body: `{ result: "success" \| "failed" }` |
| `POST` | `/api/payments` | Create a new payment attempt | Body: `{ orderId }` |
| `POST` | `/api/payments/:paymentId/process` | Process a payment attempt | Headers: `Idempotency-Key` (opt), Body: `{ result }` |
| `POST` | `/api/webhooks/payment` | Ingest signed webhook | Headers: `x-signature`, Body: Signed event |

---

## 5. Local Setup & Configuration

### Prerequisites
- **Node.js**: v18+ (tested on Node.js v24)
- **MongoDB**: MongoDB 5.0+ replica set (or MongoDB Atlas) for multi-document transaction support
- **Redis**: Redis 6.0+ (optional: if omitted, worker/queue runs in graceful fallback mode)

### 1. Environment Configuration
Copy `.env.example` in `backend/`:
```bash
cp backend/.env.example backend/.env
```

**Environment Variables Reference (Names Only):**
- `PORT`: HTTP server port (e.g. `5000`)
- `NODE_ENV`: Runtime mode (`development` | `production`)
- `MONGO_URI`: MongoDB connection string with replica set support
- `WEBHOOK_SECRET`: Secret key for HMAC-SHA256 signature verification
- `REDIS_HOST`: Redis host (e.g. `127.0.0.1`)
- `REDIS_PORT`: Redis port (e.g. `6379`)
- `REDIS_PASSWORD`: Optional Redis auth password
- `FRONTEND_URL`: Allowed frontend origin in production (e.g. `http://localhost:5173`)
- `PUBLIC_FRONTEND_URL`: Public host for QR payload URLs
- `ORDER_EXPIRATION_SWEEP_INTERVAL_MS`: Interval for background sweeper (default `60000`)

### 2. Backend Installation & Startup
```bash
cd backend
npm install
npm start
```

### 3. Frontend Installation & Startup
```bash
cd frontend
npm install
npm run dev -- --host
```

---

## 6. Running Tests

The test suite runs using Node.js's native test runner (`node --test`).

```bash
cd backend
npm test
```

### Test Coverage (7 Suites, 90 Tests)
1. **`clientIdempotency.test.js`**: Concurrency duplicate handling, cached response replay, conflict rejection on mismatched payload.
2. **`paymentAttempts.test.js`**: Incremental attempt counter, multi-attempt history tracking, duplicate attempt race prevention.
3. **`paymentSession.test.js`**: Session creation, QR payload validity, dynamic expiration, client amount tampering rejection.
4. **`consistencyAndReliability.test.js`**: Business state invariants, illegal transition prevention, duplicate webhook deduplication.
5. **`reliability.test.js`**: Transaction rollback on simulated database and order update faults, retry exhaustion handling.
6. **`paymentFlow.integration.test.js`**: Complete end-to-end integration flow from Order -> Session -> Pay -> Webhook -> Paid.
7. **`productionHardening.test.js`**: In-flight attempt overlap locking, background expiration sweeper, active attempt safety guard, centralized request validation, and health diagnostics.

---

## 7. Graceful Shutdown & Reliability Features

- **SIGINT / SIGTERM Handling**:
  1. Stops HTTP server from accepting new connections.
  2. Stops the background order expiration sweeper.
  3. Closes BullMQ background worker and queues cleanly.
  4. Closes MongoDB connections without cutting off active transactions.
  5. Process exits cleanly with code `0`.
- **CORS Hardening**:
  - Development: Permissive for local, localhost, and LAN mobile devices.
  - Production: Strictly validates origin against configured `FRONTEND_URL`.
- **Error Standardization**:
  - All errors return structured JSON with safe error codes (`BAD_REQUEST`, `NOT_FOUND`, `CONFLICT`, etc.) without exposing internal stack traces or database driver details.
