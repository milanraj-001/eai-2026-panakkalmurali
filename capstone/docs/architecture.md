# Architecture

## System context

Orders arrive at intake in three formats. The system calls pricing synchronously and the four providers through the saga. An operator uses the HTTP endpoints of the services and the RabbitMQ management UI.

```mermaid
flowchart LR
  web["Web shop JSON"] -->|"POST /orders"| sys
  mobile["Mobile app JSON"] -->|"POST /orders"| sys
  b2b["B2B partner XML windows-1257"] -->|"POST /orders"| sys
  operator["Operator"] -->|"GET /ops/metrics, GET /trace, GET /dlq, POST /dlq/replay, POST /sagas/cid/compensate"| sys
  subgraph sys["Order integration system: intake, orchestrator, notifier, observer on RabbitMQ"]
    core["four services"]
  end
  sys -->|"GET /pricing"| pricing["Pricing"]
  sys -->|"authorize, refund"| payment["Payment"]
  sys -->|"reserve, release"| inventory["Inventory"]
  sys -->|"create"| shipping["Shipping"]
  sys -->|"send"| notification["Notification"]
```

## Integration architecture

Intake publishes the canonical order to `orders.exchange`. The orchestrator consumes `saga.queue`, runs the saga over HTTP, and publishes lifecycle and outcome events to `orders.outcome`. Intake follows those events to keep `GET /orders` current, and the notifier consumes the failure events to send customer notices. Every service writes hop records to `trace.events`, and the observer stores them from `trace.store`.

A temporary failure goes through the retry queue back to its origin queue. After `MAX_RETRIES` attempts the message goes to `orders.dlq.exchange` and waits in `orders.dlq`. A message that cannot be parsed goes to `orders.invalid.exchange` and is never retried or replayed.

```mermaid
flowchart LR
  client["Clients"] -->|"POST /orders"| intake["intake 8800"]
  intake -->|"order.accepted, confirmed publish"| xorders(["orders.exchange fanout"])
  xorders --> qsaga["saga.queue"]
  qsaga --> orch["orchestrator 8802"]
  orch -->|"HTTP steps with idempotency keys"| providers["payment, inventory, shipping, notification mocks"]
  orch -->|"order.processing, completed, failed, compensated, parked, needs_attention"| xoutcome(["orders.outcome topic"])
  xoutcome -->|"outcome events"| qintake["intake.outcomes.queue"]
  qintake --> intake
  xoutcome -->|"order.failed, order.compensated"| qnotif["notifications.queue"]
  qnotif --> notifier["notifier 8803"]
  notifier -->|"POST notification/send"| providers

  qsaga -.->|"nack, temporary failure"| xretry(["orders.retry.exchange direct"])
  qnotif -.->|"nack, temporary failure"| xretry
  xretry --> qsagaretry["saga.retry.queue ttl 1s"]
  xretry --> qnotifretry["notifications.retry.queue ttl 1s"]
  qsagaretry -.->|"after ttl"| xreturn(["orders.return.exchange direct"])
  qnotifretry -.->|"after ttl"| xreturn
  xreturn --> qsaga
  xreturn --> qnotif

  orch -->|"after MAX_RETRIES"| xdlq(["orders.dlq.exchange fanout"])
  notifier -->|"after MAX_RETRIES"| xdlq
  xdlq --> qdlq["orders.dlq"]
  intake -->|"GET /dlq, POST /dlq/replay"| qdlq
  intake -->|"replay with originQueue as routing key"| xreturn

  orch -->|"not JSON, invalid, no correlationId"| xinvalid(["orders.invalid.exchange fanout"])
  notifier -->|"malformed"| xinvalid
  xinvalid --> qinvalid["orders.invalid"]

  intake -.->|"hop records"| xtrace(["trace.events fanout, wire tap"])
  orch -.->|"hop records"| xtrace
  notifier -.->|"hop records"| xtrace
  xtrace --> qtrace["trace.store"]
  qtrace --> observer["observer 8801"]
  observer -->|"GET /trace/cid, GET /ops/metrics"| operator["Operator"]
```
