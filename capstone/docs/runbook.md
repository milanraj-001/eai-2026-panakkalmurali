# Runbook

All commands run from `capstone/`. Ports: intake 8800, observer 8801, orchestrator 8802, notifier 8803, management UI 15680 (user `eai`, password `eai-capstone`). First look at any alert: `curl -s http://localhost:8801/ops/metrics`.

## dlq_not_empty

**Meaning.** `orders.dlq` holds at least one message: something failed `MAX_RETRIES` (3) times and was parked, not lost.

**Likely causes.**
- A provider outage before the first saga step: payment (or inventory for b2b) kept answering 5xx or timing out, so the order was parked.
- The notification provider failed `order_not_completed` notices, so the notifier dead-lettered them (originQueue `notifications.queue`).

**Diagnose.**
1. `curl -s http://localhost:8800/dlq` shows each entry's correlationId, originQueue, attempts and lastError.
2. `curl -s http://localhost:8801/trace/<cid>` shows the retry hops (`saga.retry` or `notify.retry`) and the `*.dead_letter` hop.
3. `curl -s http://localhost:4801/admin/config` (payment, 4802 inventory, 4804 notification) shows whether a failure is still switched on, and `/admin/logs?correlationId=<cid>` the calls made.

**Fix.** Fix the cause first, then replay one order: `curl -s -X POST http://localhost:8800/dlq/replay -H "Content-Type: application/json" -d '{"correlationId":"<cid>"}'`. A replay that is still failing gets its 3 attempts again and returns to the DLQ, nothing is lost. Do not replay with an empty body until you know every entry is fixed.

**Verify.** `/dlq` shows `count: 0`, `dlqDepth` is 0 and the alert is no longer firing; `GET /orders/<cid>` shows `completed` for a parked saga, and the provider's `/admin/effects` shows one charge, not two.

## invalid_not_empty

**Meaning.** `orders.invalid` holds a message that was permanently unreadable (not JSON, not a valid canonical order, or no correlationId header) and was quarantined without retry.

**Likely causes.**
- A producer sent a malformed body to `orders.exchange` (someone published by hand, or a client bug that bypassed intake).
- A schema change on the producer side that the consumers do not accept.

**Diagnose.**
1. `curl -s http://localhost:8801/ops/metrics` shows `invalidDepth`.
2. Management UI, queue `orders.invalid`, Get messages: the original bytes and headers are kept there.
3. `docker compose logs orchestrator notifier` shows "Invalid message quarantined" with the parse reason.

**Fix.** Nothing replays `orders.invalid` by design. Find and fix the producer, resubmit the order through `POST /orders` with a new Idempotency-Key if it is real, then purge the quarantined message in the management UI once you have kept what you need.

**Verify.** `invalidDepth` is 0, the alert is clear, and the next valid order is processed normally (a poison message never blocks the queue).

## saga_consumer_missing

**Meaning.** `saga.queue` has no consumer, so no order will be processed: orders stay `accepted` and messages pile up.

**Likely causes.**
- The orchestrator container is down or restarting.
- The orchestrator is up but lost its broker connection and has not re-consumed yet (for example right after a broker restart).

**Diagnose.**
1. `docker compose ps` and `curl -s -o /dev/null -w '%{http_code}' http://localhost:8802/health` (503 means it is not consuming).
2. `docker compose logs --tail 40 orchestrator` for "RabbitMQ unavailable" or a crash.
3. `docker exec cap-rabbitmq rabbitmqctl list_queues name messages_ready consumers`.

**Fix.** If the broker is down, start it: `docker start cap-rabbitmq`; services reconnect on their own within 30 s with no container restart. If only the orchestrator is down: `docker compose up -d orchestrator`. An order that was mid-saga when it died will come back as `needs_attention` (see stuck_sagas).

**Verify.** `saga.queue` shows 1 consumer, `/health` on 8802 answers 200, the alert clears, and a new order reaches `completed`.

## notifier_consumer_missing

**Meaning.** `notifications.queue` has no consumer: customers are not being told about failed or compensated orders, and notices queue up.

**Likely causes.**
- The notifier container is stopped or crashed.
- The notifier lost its broker connection and has not re-consumed.

**Diagnose.**
1. `docker compose ps` and `curl -s -o /dev/null -w '%{http_code}' http://localhost:8803/health`.
2. `docker compose logs --tail 40 notifier`.
3. `docker exec cap-rabbitmq rabbitmqctl list_queues name messages_ready consumers | grep notif`.

**Fix.** `docker compose up -d notifier`. The queued notices are delivered when it returns; its processed-ids store keeps a redelivered outcome from sending a second notice.

**Verify.** `notifications.queue` shows 1 consumer, ready drains to 0, and both `notifier_consumer_missing` and `notifier_consumer_lag` clear.

## saga_consumer_lag

**Meaning.** More than 5 messages are ready (waiting, not yet delivered) in `saga.queue`: the orchestrator is not keeping up.

**Threshold: 5.** It equals `SAGA_CONCURRENCY`. The orchestrator takes up to 5 messages at once and holds them unacked, so those do not count as ready. A burst of up to 5 orders is therefore absorbed with ready near 0. More than 5 ready means a second full batch is waiting behind a full set of running sagas, which only happens when sagas are slow (a slow provider, for example shipping at 2 s per call) or the consumer is stalled. A lower threshold would fire on normal bursts; a higher one would let a real backlog grow before anyone is told.

**Likely causes.**
- A provider is slow, so every saga takes seconds (check shipping and payment delays).
- The orchestrator is stalled or being restarted while orders keep arriving.

**Diagnose.**
1. `curl -s http://localhost:8801/ops/metrics` for `saga.queue` ready and unacked.
2. `curl -s http://localhost:4803/admin/config` (and 4801, 4802) for `delayMs` or failures; `/admin/logs` shows call durations.
3. `docker compose logs --tail 40 orchestrator`.

**Fix.** Remove the cause of the slowness at the provider. If the orchestrator is stalled, restart it with `docker compose up -d orchestrator`.

**Verify.** `saga.queue` ready falls back to 0, unacked to 0, and the alert clears.

## notifier_consumer_lag

**Meaning.** More than 5 messages are ready in `notifications.queue`: failure notices are not being sent as fast as they are produced.

**Threshold: 5.** The notifier does one provider call per notice and only failed or compensated orders produce a notice, so the normal flow is far below 5 waiting. I used the same figure as the saga queue: a backlog of more than 5 failure notices means the notifier is stalled, down, or the notification provider is slow, and an operator should know before customers wait long.

**Likely causes.**
- The notification provider is slow or failing, so each notice takes longer and retries pile up.
- The notifier was stopped and notices accumulated.

**Diagnose.**
1. `curl -s http://localhost:8801/ops/metrics` for `notifications.queue` ready, and `dlqDepth`.
2. `curl -s http://localhost:4804/admin/config` and `/admin/logs`.
3. `docker compose logs --tail 40 notifier`.

**Fix.** Fix or wait out the provider; start the notifier if it is down (`docker compose up -d notifier`). Notices that exhausted their retries are in the DLQ: fix the provider, then replay them.

**Verify.** `notifications.queue` ready returns to 0 and the alert clears; the notification mock's `/admin/effects` shows one notice per affected order.

## stuck_sagas

**Meaning.** One or more sagas are in `needs_attention` (the orchestrator restarted while the saga was running) or `compensation_failed` (a compensation call failed).

**Likely causes.**
- The orchestrator crashed or was restarted mid-saga, so steps were recorded but no outcome.
- A refund or release call failed during compensation, so the rest were not attempted.

**Diagnose.**
1. `curl -s http://localhost:8802/sagas/stuck` lists each order's completed and compensated steps.
2. `curl -s http://localhost:8801/trace/<cid>` shows the `saga.stuck` hop and the last step reached.
3. The providers' `/admin/effects?orderId=<orderId>` (4801 payment, 4802 inventory, 4803 shipping) show what really happened. This is the ground truth, not the saga store.

**Fix.** Before pressing compensate, read the effects: compensation refunds the payment and releases the reservation, but a shipment that already left stays shipped, and shipping and notification have no compensation. If compensating is the right call: `curl -s -X POST http://localhost:8802/sagas/<cid>/compensate`. It runs only the outstanding compensations and is safe to repeat (a second call returns the same answer and adds no effect). For `compensation_failed`, fix the failing provider first, then call it again.

**Verify.** The order is `compensated` (code `operator_compensated` for a crash, or the original failure code for a failed compensation), `/sagas/stuck` returns an empty list, `stuckSagas` is 0 and the alert clears. The effects show exactly one refund and one release.
