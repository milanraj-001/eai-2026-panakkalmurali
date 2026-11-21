# EAI 2026 capstone: order integration system

Four services (intake, orchestrator, notifier, observer) on RabbitMQ, built from my PA4 to PA7 work. An order arrives in one of three formats, becomes one canonical event, runs through a payment, inventory, shipping and notification saga with compensation, and every hop is traceable.

## How to run

Needs Docker Compose 2.20 or later, Node 20, and at least 4 GB of memory for Docker.

    docker compose up -d --build --wait
    npm --prefix tests ci
    npm --prefix tests run test:stage        # public tests, stages 0 to 6
    docker compose down -v                   # stop and delete all state

Hand-rolled mode is the default (SAGA_ENGINE=handrolled). Send an order by hand:

    curl -i -X POST http://localhost:8800/orders -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" --data-binary @tests/fixtures/web-order.json

Use a fresh orderId each time, because the saga dedupes on the business key.

## Services

| Service | Port | Role |
|---|---|---|
| intake | 8800 | POST /orders, GET /orders/:cid, GET /dlq, POST /dlq/replay |
| observer | 8801 | GET /trace/:cid, GET /ops/metrics |
| orchestrator | 8802 | saga consumer, GET /sagas/stuck, POST /sagas/:cid/compensate |
| notifier | 8803 | failure notices with dedupe, retry and DLQ |

All four answer GET /health. State lives in named volumes under /data.

## Documents

See docs/: architecture, orchestration (BPMN and SVG), patterns, failure analysis, runbook, agent readiness, AI usage and the ADRs (docs/adr/).

## Status

- Public tests: stages 0 to 5 pass 28 of 28 against the running stack; the stage 6 document tests pass.
- Step 6 (no public tests) was checked by hand against the mocks: the first-step retry path, park and replay, outcome republish on redelivery, restart and kill survival of the stores, stuck detection with operator compensation, broker-outage reconnect without a container restart, and five concurrent sagas.

## Known limitations

- Stuck detection works on redelivery after an orchestrator restart (a saga with recorded steps and no outcome). It has no separate timer, so a saga whose message was lost is not detected, and a redelivery inside a live run could be marked stuck without a crash (ADR-010).
- Trace hops are published fire-and-forget, without broker confirms, so a hop can be lost during a broker outage and leave a gap in a trace (ADR-009).
- Notices are at-least-once by design: a duplicate notice is possible (ADR-008).
- Intake retries an outcome for an unknown order only a few times before dropping it, so an outcome that arrives long before its order is saved can be lost.
- I checked the first-step retry path by hand for a standard order (payment). I did not check the b2b equivalent (inventory as the first step) by hand.

## Advanced component

Not implemented.

The Temporal mode is not built. The worker service is declared in the compose file under the temporal profile and is left as given, and docs/adr/adr-011.md is the unchanged template.
