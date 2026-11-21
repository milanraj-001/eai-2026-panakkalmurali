# Patterns

Every Where entry is a path and line in `capstone/`. Re-check the lines after any edit to these files.

| Pattern | Problem | Where | Why |
|---|---|---|---|
| Normalizer | Web JSON, mobile JSON and b2b XML (windows-1257) all arrive at one endpoint, and the saga must see only one shape. | intake/server.js:390 | `extractInput` detects the format from the Content-Type and body, and maps all three to one internal shape, so nothing downstream knows the source format. |
| Content Enricher | Orders carry no prices, but payment needs an amount in whole cents. | intake/server.js:558 | `enrichOrder` calls pricing for each item and adds unit price, currency and tax rate. An unknown product rejects the whole order with 422. |
| Canonical Data Model | Three source formats would otherwise need pairwise mappings to every consumer. | intake/server.js:596 | The enriched order is validated against `canonical/order.schema.json` before it is published, so the orchestrator only deals with one schema. |
| Idempotent Receiver | A client retry of `POST /orders` would create a second order. | intake/server.js:660, orchestrator/server.js:338 | Intake keys on `Idempotency-Key` plus the body hash. The saga keys on the business key, so the same order under a new key becomes `duplicate`. |
| Guaranteed Delivery | An accepted order must not be lost if the broker or intake restarts. | intake/server.js:747 | The `order.accepted` event is published persistent on a confirm channel, and intake answers 202 only after the broker confirms. |
| Correlation Identifier | One order crosses four services, and its events and calls must be matched. | intake/server.js:751 | Intake generates the `correlationId` and puts it in the headers. Every later message and mock call carries it. |
| Process Manager / Saga | Payment, inventory, shipping and notification are separate systems with no shared transaction. | orchestrator/server.js:253 | `processOrder` runs the steps in order and records each completed step in the saga store, so a failure can be compensated. |
| Compensating Transaction | A failed later step leaves a charge or a reservation behind. | orchestrator/server.js:246 | `compensationFor` maps a completed inventory or payment step to its release or refund call, run in reverse order with provider idempotency keys. |
| Semantic Lock | An order being processed must be visible as in progress, not look untouched. | orchestrator/server.js:382 | The saga publishes `order.processing` before its first step, and intake's `GET /orders/:cid` shows that state. |
| Retry with a delay queue | A temporary provider failure should be retried later, not at once and not forever. | orchestrator/server.js:726 | The consumer nacks without requeue into the queue's dead-letter arguments, so the message waits in the retry queue and returns after its TTL. The notifier does the same at notifier/server.js:190. |
| Dead Letter Channel | A message that keeps failing would loop forever and block the queue. | notifier/server.js:195 | After `MAX_RETRIES` attempts the notifier publishes the message to `orders.dlq.exchange` with `originQueue` and `lastError`, and acks it. |
| Invalid Message Channel | A message that is not JSON can never succeed, so retrying it is pointless. | orchestrator/server.js:701 | The orchestrator publishes it to `orders.invalid.exchange` with its original bytes and headers, then acks it. Nothing replays that queue. |
| Wire Tap | The trace must be recorded without slowing or failing the business flow. | orchestrator/server.js:133 | `emitHop` publishes a hop record to `trace.events` without awaiting a confirm, and catches its own errors, so tracing never fails an order. |
