# The capstone (PA8)

| | |
|---|---|
| **Published** | **2026-11-04**: this brief, the kit and the public tests, complete, in one release |
| **Kickoff** | S8 — Operating what you built · 2026-11-11, C113 |
| **Deadline** | **2026-11-20 (Friday), 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-11-23 (Monday), 20:00**. After it, no capstone is accepted |
| **Weight** | **50% of the final grade**: the capstone half |
| **Mark** | points out of **115**: 30 from the public tests, 60 from the hidden tests, 10 manual, 15 for the advanced component. See [GRADING.md](GRADING.md) |
| **Pass** | **41.0 points**, after the late penalty and the defence |
| **Graded only if** | the progression gate is clear: Session 0 and PA1–PA7 all submitted before their cut-offs |
| **Defence** | oral, about 20 minutes, pass or fail. See [GRADING.md](GRADING.md) |
| **Individual** | yes. Not a group project |
| **You need** | Docker Compose **2.20 or later** (R-3.1.8, [how to check](#check-docker-compose-first)), Node 20, and at least **4 GB of memory for Docker** (§3.6) |

---

## Read this first

- **This is your own PA4–PA7 work, made into one system.** Copy your PA code into `capstone/` and change it there. Leave `pa4/` … `pa7/` as they are: their history is the evidence that you wrote them.
- **If one of your PAs does not work, fix it inside `capstone/`.** No reference solutions are released, for any PA. Fixing your own earlier work is part of the capstone.
- **Green public tests mean the system runs. They do not mean it is right.** The public tests are 30 of 115 points. Step 6 in §2 has no public tests, and it is where the hidden points are: the hidden tests check it, and check steps 0–5 again with other cases.
- **A 10 needs the advanced component** (§4.11). Without it, the ceiling is 100 points: a 9.
- **The requirements are frozen from 2026-11-04.** §3, §4, §5, §6 and §9 number every requirement, for example `R-4.2.7`. A correction after publication can only make a requirement easier, and it is listed under [Changes](#changes).

---

## 1) What you build

One running system, in `capstone/` of your semester repository. It takes an order in any of the three PA4 formats. It publishes one canonical event, and it runs your PA6 saga from that event. It tells the customer when an order could not be completed. And it lets an operator see the whole journey of one order, through every hop, and act on what went wrong.

```mermaid
%%{init: {"flowchart": {"wrappingWidth": 260}}}%%
flowchart TB
  client(["Client<br/>web JSON · mobile JSON · b2b XML"])
  intake["<b>cap-intake</b> :8800<br/>Normalizer · idempotency<br/>DLQ operations"]
  pricing["<b>cap-pricing</b> :4110"]
  accepted[("order.accepted")]
  orch["<b>cap-orchestrator</b> :8802<br/>saga · compensation<br/>stuck sagas"]
  mocks["<b>provider mocks</b> :4801–4804<br/>payment · inventory<br/>shipping · notification"]
  outcomes[("lifecycle and<br/>outcome events")]
  notifier["<b>cap-notifier</b> :8803<br/>failure notices"]
  hops[("hop records")]
  observer["<b>cap-observer</b> :8801<br/>trace · metrics · alerts"]
  temporal["<b>cap-temporal</b>"]
  worker["<b>cap-worker</b>"]

  client -->|"POST /orders"| intake
  intake -->|"enrich"| pricing
  intake --> accepted --> orch
  orch -->|"saga steps"| mocks
  orch --> outcomes -->|"failed, compensated"| notifier
  notifier -->|"notice"| mocks
  intake & orch & notifier --> hops
  hops --> observer
  orch -.->|"advanced: start workflow"| temporal
  temporal -.->|"tasks"| worker
  worker -.->|"saga steps"| mocks

  classDef yours fill:#dbe8ff,stroke:#2563eb,stroke-width:2px,color:#0b1b3a
  classDef kit fill:#eceff3,stroke:#6b7280,color:#111827
  classDef msg fill:#fff4d6,stroke:#b7791f,color:#3b2a06
  classDef adv stroke-dasharray: 5 4
  class intake,orch,notifier,observer,worker yours
  class pricing,mocks,temporal kit
  class accepted,outcomes,hops msg
  class worker,temporal adv
```

*Blue: the services you write. Grey: the kit. Yellow: messages on `cap-rabbitmq`. Dashed: the advanced component (§4.11).* The text diagram below is the same system, with the exchanges, the queues and the endpoints:

```
 POST /orders  (web JSON | mobile JSON | b2b XML in windows-1257)   Idempotency-Key: …
      │
      ▼
 cap-intake ── Normalizer: detect → translate (PA4) → enrich (pricing) → filter → validate
      │        202 {correlationId} · GET /orders/:cid · GET /dlq · POST /dlq/replay
      │ order.accepted  (persistent, publisher-confirmed)
      ▼
 orders.exchange (fanout) ──► saga.queue ◄── orders.return.exchange ◄── saga.retry.queue (TTL 1 s)
                                  │
                                  ▼
 cap-orchestrator ── dedupe on businessKey → [orderType b2b? skip payment]
      │              payment → inventory → shipping → notification   (HTTP to the mocks)
      │              compensate in reverse · first-step outage → retry path → DLQ
      │              up to SAGA_CONCURRENCY sagas at once · GET /sagas/stuck · POST /sagas/:cid/compensate
      │ lifecycle and outcome events (at-least-once)
      ▼
 orders.outcome (topic) ── order.failed | order.compensated ──► notifications.queue ──► cap-notifier (PA5)
                                                                    └─► notification mock, kind=order_not_completed

 every service ── hop records ──► trace.events (fanout, WIRE TAP) ──► trace.store ──► cap-observer
                                                                   GET /trace/:cid · GET /ops/metrics
 failure channels:  orders.dlq.exchange → orders.dlq        orders.invalid.exchange → orders.invalid
 advanced:          SAGA_ENGINE=temporal → the orchestrator starts a Temporal workflow; cap-worker runs it
```

You write four services: **intake**, **orchestrator**, **notifier** and **observer**, plus a **worker** if you take on the advanced component. Most of their code already exists, in your PA4–PA7 folders. The kit gives you the broker, its topology, the mocks, the schemas, the public tests and the document templates (§5).

---

## 2) Where to start

### Check Docker Compose first

Your `docker-compose.yml` pulls in the kit's services with `include:`, and Docker Compose understands `include:` from version 2.20 on (R-3.1.8). Check yours before anything else. The command is the same in Bash, Git Bash and PowerShell:

```bash
docker compose version
```

It prints one line, for example `Docker Compose version v2.29.7`. Read the numbers after the `v`:

| You see | Your Compose |
|---|---|
| `v2.20` or later: `v2.24.6`, `v2.39.1` | is fine |
| a first number above 2: `v5.3.1` | is fine |
| `v2.3` to `v2.19`: `v2.17.3` | **is too old.** Read the second number as a whole number: 17 is less than 20 |
| `docker: 'compose' is not a docker command` | **is missing:** you have no Compose v2 at all |

Too old, or missing: update Docker Desktop (its menu → *Check for updates*), or Rancher Desktop, and run the command again. On Linux without Docker Desktop, upgrade the `docker-compose-plugin` package. `docker-compose`, with a hyphen, is the old Compose v1, which this course does not use.

### The nine steps

Build it in the nine steps below, in this order. Each of steps 0–5 and step 7 turns one stage of the public tests green. Step 6 has no public tests, and step 8 is the advanced component.

Get the kit as you got every PA ([the root README](../README.md#starting-an-assignment)): `git pull` in your clone of `eai-2026`, then copy the whole `capstone/` folder into your repository. `canonical/` is there already, from PA4. A correction after publication is listed under [Changes](#changes), with the files to copy again.

Work in `capstone/`:

```bash
npm --prefix tests ci                      # once, and again when a Changes entry names tests/
docker compose up -d --build --wait        # after every change to your code
npm --prefix tests run test:stage -- 3     # the public tests of stages 0, 1, 2 and 3
```

In PowerShell, run `node tests/stage.mjs 3` instead of the last line (§7).

| Step | Build | Possible after | Public tests | Checking it by hand |
|---|---|---|---|---|
| 0 | Copy your PA code in. A first version of each of your four services: its Dockerfile, a broker connection, a consumer on its queue (intake has none yet), and `GET /health` ([below](#step-0-in-detail)) | now (PA4 is out) | stage 0 | `docker compose ps`, the management UI on <http://localhost:15680> (user `eai`, password `eai-capstone`) |
| 1 | Intake, the Normalizer: bytes → PA4 → pricing → canonical → publish, plus idempotency (§4.1), and `GET /orders/:cid` answering `accepted` (R-4.4.2) | S4 | stage 1 | `curl` each fixture ([below](#sending-an-order-by-hand)). Bind a temporary queue to `orders.exchange` in the UI and look at the event |
| 2 | The saga consumer and the happy path, b2b included (§4.2), with its lifecycle and outcome events (R-4.5.1, R-4.5.2), and `GET /orders` following the saga's state (§4.4) | S5 (consumer), S6 (saga) | stage 2 | the mocks' `/admin/logs` and `/admin/effects` (§5.2), `GET /orders/:cid` |
| 3 | The compensation matrix (§4.3) | S6 | stage 3 | make a mock fail with `/admin/config`, then read `/admin/effects` (§5.2) |
| 4 | The invalid channel (R-4.2.2, R-4.5.8), the notifier with its retry path and DLQ (§4.5), DLQ operations (§4.6) | S5 | stage 4 | publish `{ not json` to `orders.exchange` from the UI. `GET /dlq`, `POST /dlq/replay` |
| 5 | The wire tap, the observer, the trace, `/ops/metrics`, deep health (§4.8, §4.9) | S5 metadata; this brief is self-contained | stage 5 | `GET /trace/:cid`. Stop the notifier and watch the alerts |
| 6 | **Hardening. No public tests:** the first-step retry path, outcome republish on redelivery, restart-proof stores, stuck detection and operator compensation, runtime reconnect, concurrency | S7 | none: the hidden tests | [Checking step 6 by hand](#checking-step-6-by-hand), below |
| 7 | The documents (§6) | start any time, alongside the code; finish last. The pattern links need your code, and the failure analysis the traces of your finished system | stage 6 | stage 6 needs no running stack |
| 8 | The advanced component: Temporal mode (§4.11) | S7 (PA7) | none: [GRADING.md](GRADING.md) §6 | [Checking the advanced component](#checking-the-advanced-component), in §7 |

**Steps and stages.** The steps are numbered 0–8, and the public test stages 0–6. They are the same up to 5. Step 6 has no public tests, so step 7, the documents, is public stage 6. The test IDs in [GRADING.md](GRADING.md) §3 carry their stage: P1.3 is the third test of stage 1.

### Step 0 in detail

The given `docker-compose.yml` already declares your four services, with their names, ports, variables, `mem_limit`s, volumes and healthchecks. It builds each one from `<service>/Dockerfile`, with `capstone/` as the build context. It passes each service its port inside the container as `PORT`, which the healthcheck calls, and it mounts `../canonical` read-only at `/canonical` for intake and the orchestrator.

You write the Dockerfiles, and a first version of each service that connects to the broker, consumes its queue, and answers `GET /health` as R-4.9.12 says. The observer consumes `trace.store`, the orchestrator `saga.queue`, and the notifier `notifications.queue`. Intake consumes nothing yet, so its `consumers` is `{}`. If it consumes a queue later, to follow `orders.outcome` for instance, it lists that queue from then on, and stage 0 accepts that. Stage 0 (`test:stage -- 0`) checks all this, with your compose file and the broker's topology, and every later stage runs stage 0 first. Your PA5 consumer code is most of it. Until they have real work, the orchestrator (step 2) and the notifier (step 4) may simply ack what they receive. The `worker` service is declared too, in the profile `temporal`: nothing builds it before step 8, and without step 8 you leave it as it is. `docker compose config` does not need a `worker/` folder.

**Identifiers from step 1 on.** Every message your services publish carries `headers.correlationId` and `headers.causationId`, and every call to a mock carries `X-Correlation-Id` and `X-Causation-Id`: intake's pricing calls from step 1, the saga's calls from step 2 (R-3.3.9). A causation id is the id of the hop that published the message or made the call (§4.8): generate that id, a UUID v4, before you publish or call. Publishing the hops themselves is step 5.

**What waits for a later step.**

- Stage 3 checks the compensation matrix without its first-step retry rows (R-4.3.2, R-4.3.7), which are step 6, and without the customer's notice, which is step 4.
- Stage 4's DLQ entries come from the notifier (R-4.5.7). By hand, make the notification mock fail `order_not_completed` notices (§5.2), then fail an order.
- Until step 6, `GET /sagas/stuck` may answer `{"sagas": []}`, so that `/ops/metrics` has its `stuckSagas` from step 5.
- No public test stops the broker. `/health` answering `503` while it is down (R-4.9.13) belongs to step 5, and reconnecting after it (R-4.9.14) to step 6. The hidden tests check both.
- Stage 6 does not check `docs/adr/adr-011.md`. Without step 8, keep the template file as it is, so that the ADR index's link to it still resolves.
- Business-key dedupe (R-4.2.3) is part of step 2, and concurrency (R-4.2.1, §4.10) part of step 6. No public test checks either; the hidden tests check both.
- No public test reads your store files. Keep your state in the files of §3.5 from step 1 on (R-3.5.1): step 6 checks that it survives restarts.
- No public test reads your README either. The grader reads its `## Advanced component` line (R-5.3.2) before it runs the advanced suite.

**Step 6 is where the hidden points are.** Green public tests mean the system runs. They do not mean it is right. The hidden tests, 60 of the 115 points, check the same requirements as the public ones with other cases, and the step 6 requirements that no public test checks.

**Use fresh `orderId`s when you test by hand.** The saga dedupes on the business key (§4.2), so a fixture you submit twice is marked `duplicate` the second time. Change its `orderId`, or reset everything with `docker compose down -v`.

### Sending an order by hand

```bash
curl -i -X POST http://localhost:8800/orders -H "Content-Type: application/json" -H "Idempotency-Key: demo-web-1" --data-binary @tests/fixtures/web-order.json
curl -i -X POST http://localhost:8800/orders -H "Content-Type: application/json" -H "Idempotency-Key: demo-mobile-1" --data-binary @tests/fixtures/mobile-order.json
curl -i -X POST http://localhost:8800/orders -H "Content-Type: application/xml" -H "Idempotency-Key: demo-b2b-1" --data-binary @tests/fixtures/b2b-order.xml
curl http://localhost:8800/orders/<the correlationId it answered>
```

`--data-binary` sends the file's bytes unchanged; `-d` would strip its line breaks. The commands in this brief are for Bash, or Git Bash on Windows. In PowerShell, type `curl.exe`, not `curl`, and quote the file argument: `--data-binary "@tests/fixtures/web-order.json"`. PowerShell 5.1 strips the quotes inside a JSON body it hands to `curl.exe`, so send an inline JSON body with `Invoke-RestMethod -Method Post -Uri <url> -ContentType application/json -Body '<the JSON>'` instead.

### Checking step 6 by hand

Each check uses the mocks' admin API (§5.2). Reset the mocks after each one:

```bash
for port in 4801 4802 4803 4804; do curl -s -X POST http://localhost:$port/admin/reset; done
```

**The first-step retry path** (R-4.2.12–R-4.2.14). Make payment fail twice with a 503, then submit a web order:

```bash
curl -X POST http://localhost:4801/admin/config -H "Content-Type: application/json" -d '{"authorize":{"failMode":"times","failTimes":2,"failStatus":503}}'
```

It completes, payment's `/admin/effects` shows one charge, and the trace has two `saga.retry` hops. With `"failMode":"always"`, the order ends `parked` after `MAX_RETRIES` attempts, and `GET /dlq` lists it. Set `"failMode":"never"`, then `POST /dlq/replay` with `{"correlationId":"<cid>"}`: it completes, with one charge. Add `"effectThenFail":true` to see the unknown state: payment charged, but your call failed. The retry must still leave one charge.

**Outcome republish on redelivery** (R-4.2.4). In the management UI, bind a temporary queue to `orders.exchange` and another to `orders.outcome` (routing key `#`). Submit an order and let it complete. Take its event from the first queue, and publish it again to `orders.exchange` from the exchange's page, with the same body and the headers `correlationId`, `causationId` and `businessKey`. No mock sees a new call, and the order's outcome event arrives again in the second queue, with a new `messageId`.

**Restart-proof stores** (R-3.5.4). Submit an order and let it complete. Run `docker compose restart intake orchestrator notifier observer`, and wait until `docker compose ps` shows them healthy. `GET /orders/:cid` still shows `completed`. The same `POST`, with the same key and body, answers the same `correlationId`. `GET /trace/:cid` still has every hop. Do it again with `docker kill cap-intake cap-orchestrator cap-notifier cap-observer`, then `docker compose up -d --wait`.

**Stuck detection and operator compensation** (§4.7). Make shipping slow, submit a web order with a fresh `orderId`, and kill the orchestrator a second later. That is while it still waits for shipping: after `REQUEST_TIMEOUT_MS` (2.5 s) it would give up and compensate instead.

```bash
curl -X POST http://localhost:4803/admin/config -H "Content-Type: application/json" -d '{"create":{"delayMs":5000}}'
sed "s/WEB-2026-001/WEB-S$RANDOM/" tests/fixtures/web-order.json |
  curl -s -X POST http://localhost:8800/orders -H "Content-Type: application/json" -H "Idempotency-Key: s-$RANDOM" --data-binary @-
sleep 1; docker kill cap-orchestrator
docker start cap-orchestrator
```

Within `SAGA_STUCK_AFTER_MS` of the start, the order is `needs_attention`, `GET http://localhost:8802/sagas/stuck` lists it, and `/ops/metrics` fires `stuck_sagas`. Nothing ran again: one charge and one reservation in `/admin/effects`. The shipment is there too: the carrier finished the call it was given. Then `curl -X POST http://localhost:8802/sagas/<cid>/compensate` gives `compensated`, with one refund and one release. Call it again: the same answer, and no new effect.

**Runtime reconnect** (R-4.9.14, R-4.9.15). Run `docker stop cap-rabbitmq`. Every service's `/health` answers 503, and `POST /orders` answers `503 broker_unavailable`. Run `docker start cap-rabbitmq`. Within 30 s of it being healthy, every `/health` answers 200 again, with no restart of your containers: `docker inspect -f "{{.RestartCount}} {{.State.StartedAt}}" cap-intake` shows the same as before. Then submit an order: it completes.

**Concurrency** (§4.10). Make shipping take 2 s (`{"create":{"delayMs":2000}}` on port 4803), then submit five web orders at once, each with its own `orderId`:

```bash
for i in 1 2 3 4 5; do
  sed "s/WEB-2026-001/WEB-C$RANDOM-$i/" tests/fixtures/web-order.json |
    curl -s -X POST http://localhost:8800/orders -H "Content-Type: application/json" -H "Idempotency-Key: c-$RANDOM-$i" --data-binary @- &
done; wait
```

With `SAGA_CONCURRENCY=5`, all five complete in a little over one shipping delay, not five. In shipping's `/admin/logs`, the five calls overlap in time.

---

## 3) The contract

Names, ports, variables, paths and the broker topology are fixed, because the tests, the grader and the defence drill depend on them.

**How to read §3 to §9.** Every statement marked **R-…** is a requirement. Text without an ID explains a requirement; it adds none. If two requirements seem to disagree, ask (see [CONTRIBUTING.md](../CONTRIBUTING.md)) before you choose.

### 3.1 Containers

- **R-3.1.1** The Compose project is named `capstone`. The folder name gives it that name, so do not set another.
- **R-3.1.2** Every service has the container name and host ports in the table below.
- **R-3.1.3** The kit services are defined in `docker-compose.kit.yml`. Your `docker-compose.yml` pulls that file in with `include:`, and defines your services.
- **R-3.1.4** Each of your services keeps its state only in its named volume from the table, mounted at `/data`. Never a bind mount.
- **R-3.1.5** Each of your services declares its `mem_limit` (§3.6) and a healthcheck that calls its `GET /health` (§4.9). The worker needs no healthcheck.
- **R-3.1.6** `temporal` and `worker` are in the Compose profile `temporal`. Without that profile the stack runs in hand-rolled mode.
- **R-3.1.7** RabbitMQ's user is `eai`, password `eai-capstone`, not `guest` (see PA2's ADR-001).
- **R-3.1.8** You build and run the stack with Docker Compose 2.20 or later: the `include:` of R-3.1.3 needs it. §2 says how to check your version.

| Service | Container | Host port(s) | Owner | Built from | Named volume |
|---|---|---|---|---|---|
| `rabbitmq` | `cap-rabbitmq` | 5680 AMQP, 15680 UI | kit | `rabbitmq:3.13-management` + `rabbitmq/definitions.json` | `rabbitmq-data` |
| `pricing` | `cap-pricing` | 4110 | kit | PA4's `mock-pricing`, extended | — |
| `payment` | `cap-payment` | 4801 | kit | PA6's mock, extended | — |
| `inventory` | `cap-inventory` | 4802 | kit | PA6's mock, extended | — |
| `shipping` | `cap-shipping` | 4803 | kit | PA6's mock, extended | — |
| `notification` | `cap-notification` | 4804 | kit | PA6's mock, extended | — |
| `temporal` *(profile `temporal`)* | `cap-temporal` | 7240, 8240 UI | kit | PA7's image, `temporalio/temporal:1.9.1` | `temporal-data` |
| `intake` | `cap-intake` | 8800 | **you** | your PA4 translators + PA5 order-service | `intake-data` |
| `observer` | `cap-observer` | 8801 | **you** | new | `observer-data` |
| `orchestrator` | `cap-orchestrator` | 8802 | **you** | your PA6 saga + PA5 consumer code | `orchestrator-data` |
| `notifier` | `cap-notifier` | 8803 | **you** | your PA5 notification-service | `notifier-data` |
| `worker` *(profile `temporal`)* | `cap-worker` | — | **you** | your PA7 worker | — |

The ports inside your own containers are yours to choose; only the host ports are fixed. The given `docker-compose.yml` passes each service its inside port as `PORT`, and its healthcheck calls that port: if you change one, change both. None of these ports collides with an earlier PA, so an old stack left running does not block this one.

### 3.2 The broker topology

- **R-3.2.1** `rabbitmq/definitions.json` declares every exchange and queue below, with these types and arguments, and RabbitMQ loads it at start. You may add exchanges, queues and bindings. You may not rename, retype or re-argument anything listed here. It is not replaced at grading.

**Exchanges**, all durable:

| Exchange | Type | Role |
|---|---|---|
| `orders.exchange` | fanout | `order.accepted`, the canonical event (PA5) |
| `orders.retry.exchange` | direct | the TTL retry path; routing key = the origin queue (PA5) |
| `orders.return.exchange` | direct | back to the origin queue only (PA5) |
| `orders.dlq.exchange` | fanout | the dead letter channel (PA5) |
| `orders.invalid.exchange` | fanout | the invalid message channel (PA5) |
| `orders.outcome` | **topic** | lifecycle and outcome events (new) |
| `trace.events` | fanout | the wire tap for hop records (new) |

**Queues**, all durable:

| Queue | Arguments | Bound from (routing key) |
|---|---|---|
| `saga.queue` | `x-dead-letter-exchange: orders.retry.exchange`, `x-dead-letter-routing-key: saga.queue` | `orders.exchange` (`""`), `orders.return.exchange` (`saga.queue`) |
| `saga.retry.queue` | `x-message-ttl: 1000`, DLX `orders.return.exchange`, DLRK `saga.queue` | `orders.retry.exchange` (`saga.queue`) |
| `notifications.queue` | DLX `orders.retry.exchange`, DLRK `notifications.queue` | `orders.outcome` (`order.failed`, `order.compensated`), `orders.return.exchange` (`notifications.queue`) |
| `notifications.retry.queue` | `x-message-ttl: 1000`, DLX `orders.return.exchange`, DLRK `notifications.queue` | `orders.retry.exchange` (`notifications.queue`) |
| `orders.dlq` | none | `orders.dlq.exchange` (`""`) |
| `orders.invalid` | none | `orders.invalid.exchange` (`""`) |
| `trace.store` | none | `trace.events` (`""`) |

- **R-3.2.2** A temporary failure goes through the retry path: into the origin queue's retry queue, and after its TTL back to **that queue only**. PA5's `nack(msg, false, false)` does exactly this, through the queue's dead-letter arguments. The attempt number comes from the `x-death` header, as in PA5's `getRetryCount`.
- **R-3.2.3** After the `MAX_RETRIES`-th failed attempt, the consumer publishes the message to `orders.dlq.exchange` with the headers `originQueue` and `lastError`, and then acks it.

These queues already exist with arguments. If your code asserts one of them, assert it with exactly these arguments, or not at all. A mismatch is `PRECONDITION_FAILED`, and RabbitMQ closes the channel that sent it.

### 3.3 Identifiers and headers

| ID | Name | Where it lives | Rule |
|---|---|---|---|
| **R-3.3.1** | `correlationId` | AMQP `headers.correlationId`; HTTP `X-Correlation-Id`; the key of `GET /orders/:cid` and `GET /trace/:cid` | A UUID v4 that **intake generates** for each accepted submission. The same value for that order everywhere. A client's own `X-Correlation-Id` is ignored |
| **R-3.3.2** | `causationId` | AMQP `headers.causationId`; HTTP `X-Causation-Id` | The `hopId` of the hop that caused this message or call (§4.8) |
| **R-3.3.3** | `messageId` | AMQP `properties.messageId` | A new UUID v4 on **every** message your services publish. A republish (a replay, an outcome republish) gets a new one too |
| **R-3.3.4** | `businessKey` | the `order.accepted` headers, the outcome envelope, the stores, `GET /orders` | `${source}:${orderId}`, for example `web:WEB-2026-001` |
| **R-3.3.5** | `Idempotency-Key` from the client | HTTP header on `POST /orders` | Mandatory. 1–128 characters from `[A-Za-z0-9._:-]` |
| **R-3.3.6** | `Idempotency-Key` to the providers | HTTP header on every call to payment and inventory | Payment: `authorize:${businessKey}`, `refund:${businessKey}`. Inventory: `reserve:${businessKey}`, `release:${businessKey}`. Shipping and notification take none |
| **R-3.3.7** | `originQueue` | AMQP header on a DLQ message | The queue the message failed on (PA5) |
| **R-3.3.8** | `lastError` | AMQP header on a DLQ message | A short reason, for example `payment 503` or `timeout` |

- **R-3.3.9** Every message your services publish to `orders.exchange`, `orders.outcome`, `orders.return.exchange` or `orders.dlq.exchange` carries `headers.correlationId` and `headers.causationId`. Every call to a mock carries `X-Correlation-Id` and `X-Causation-Id`.
- **R-3.3.10** The canonical order body is never extended: `additionalProperties: false` still applies. Identifiers travel in headers, never in the body.

### 3.4 Environment

- **R-3.4.1** Your services read every value below from these environment variables. Never hardcode a URL, a credential, a timeout or a limit.
- **R-3.4.2** The names are fixed. The given `docker-compose.yml` and `docker-compose.kit.yml` set the values: keep them. You may add variables of your own.

| Variable | Used by | Value |
|---|---|---|
| `RABBITMQ_URL` | all your services | `amqp://eai:eai-capstone@rabbitmq:5672` |
| `PRICING_URL`, `PRICING_API_KEY` | intake | `http://pricing:4100`, PA4's key |
| `PAYMENT_URL`, `INVENTORY_URL`, `SHIPPING_URL`, `NOTIFICATION_URL` | orchestrator, worker, notifier | `http://payment:4001` … `http://notification:4004` |
| `REQUEST_TIMEOUT_MS` | intake (pricing), orchestrator, notifier | `2500` |
| `MAX_RETRIES` | orchestrator, notifier | `3` |
| `SAGA_CONCURRENCY` | orchestrator | `5` |
| `SAGA_STUCK_AFTER_MS` | orchestrator | `10000` |
| `SAGA_ENGINE` | orchestrator | `handrolled` (default) or `temporal` |
| `TEMPORAL_ADDRESS` | orchestrator, worker | `temporal:7233` |
| `ORDER_ITEMS_MAX` | intake | `50` |
| `DATA_DIR` | all your services | `/data` |

A value your services need that is not in this table, such as the management API's URL for the observer or the orchestrator's URL for `GET /sagas/stuck`, is a variable of your own, set in your `docker-compose.yml` (R-3.4.2).

### 3.5 Stores

- **R-3.5.1** Your services keep their state in JSON or JSONL files at the paths below, and nowhere else: no database, and nothing that must survive a restart kept only in memory.
- **R-3.5.2** Each file validates against its schema in `grading/schema/`. For a JSONL file, each line does.
- **R-3.5.3** Write a JSON store atomically: write a temporary file in the same folder, then rename it over the old one.
- **R-3.5.4** The stores survive `docker compose restart`, `stop` and `start`, and a `docker kill`. `docker compose down -v` deletes them all.

| Service | Path | Schema | Content |
|---|---|---|---|
| intake | `/data/idempotency-store.json` | `idempotency-store.schema.json` | key → `{bodySha256, state: in_flight \| done, response: {status, body}, correlationId?, createdAt}` |
| intake | `/data/orders.json` | `order-status.schema.json` (each value) | correlationId → the `GET /orders` view (§4.4) |
| orchestrator | `/data/saga-store.json` | `saga-store.schema.json` | `{sagas, businessKeys}`. `sagas`: correlationId → `{businessKey, state, steps: [{step, status, at}], compensations: [{step, status, at}], operatorCompensation?, outcome: {routingKey, envelope}, owner, updatedAt}`. `businessKeys`: businessKey → correlationId, the dedupe index |
| notifier | `/data/processed-ids.json` | `processed-ids.schema.json` | an array: the correlationIds already notified |
| notifier | `/data/notification.log` | — (JSONL) | one line per notice sent, as in PA5 |
| observer | `/data/trace-store.jsonl` | `trace-hop.schema.json` (each line) | one hop per line |

`owner` is your device for detecting a crash, for example an id the orchestrator draws at every start (§4.7). `outcome` is the outcome event that a redelivery republishes (§4.2).

The tests and the grader read these files through `docker exec` and `docker cp`. Named volumes, not bind mounts, because an atomic rename is unreliable on Docker Desktop bind mounts, and because `down -v` must reset everything.

### 3.6 Limits

- **R-3.6.1** From a clean clone, with the base images already pulled, `docker compose up -d --build --wait` is healthy within **5 minutes**, or **7 minutes** with `--profile temporal`. A stack that is not healthy in time is graded as FAILED TO START ([GRADING.md](GRADING.md)).
- **R-3.6.2** `mem_limit` is **256m** on intake, observer, orchestrator and notifier, and **768m** on the worker. A container that goes over its limit is killed, and exits with code 137.
- **R-3.6.3** The worker's image is based on `node:20-bookworm-slim`: Temporal's SDK needs glibc. For your other services we recommend the same image, or `python:3.12-slim`.

The kit's own limits are 512m for RabbitMQ, 128m for each mock and 768m for Temporal. With yours, the whole stack is limited to 2.2 GB, or 3.7 GB with the advanced component, so give Docker at least 4 GB.

For scale, a complete hand-rolled implementation of this brief builds from nothing and is healthy in about a minute. Under the full test load, none of its four services used more than 75 MiB. With the advanced component, it builds from nothing and is healthy in under three minutes, and its worker stays under 120 MiB. If yours needs much more of any of these, find out why before you submit.

---

## 4) Behaviour

### 4.0 What changes from your PA code

A summary. The requirements are in §4.1–§4.11.

| From | What changes in the capstone |
|---|---|
| PA4 | Translators take **bytes from an HTTP body**, not file paths. An **unknown product rejects the whole order** (422); PA4 dropped the item with a warning. A pricing outage is temporary (503), not a warning |
| PA5 | order-service becomes the intake. The payment and inventory consumers are **retired**. The notifier consumes **outcome events**, calls the notification mock, and is at-least-once. The DLQ gains `GET /dlq` and **selective replay**. Services **reconnect at runtime**. Headers gain `causationId` and `messageId`. Stores move to **named volumes** |
| PA6 | The saga is **started by `saga.queue`**, not by HTTP, and there is no response trace. **A first-step 5xx or timeout goes to the retry path**, with provider idempotency keys. **b2b skips payment.** Sagas run **concurrently**. Stuck detection and operator compensation are new. Outcome events are published **at-least-once** |
| PA7 *(advanced)* | The workflow is **started by the consumer**, with `workflowId = businessKey`. Outcome events and trace hops are published from activities. The b2b branch is new |

### 4.1 Intake — `cap-intake:8800`

**`POST /orders`** is the Normalizer: one endpoint, three formats. It detects the format of the raw body, then translates it.

| ID | Request | Treated as |
|---|---|---|
| **R-4.1.1** | `Content-Type: application/xml` or `text/xml` | **b2b.** Decode the bytes by the `encoding` in the XML declaration (the fixtures declare `windows-1257`). A `charset` parameter on the `Content-Type`, when present, wins (RFC 7303). The tests send none |
| **R-4.1.2** | `Content-Type: application/json`, and the body has `orderId` and an object `customer` | **web** |
| **R-4.1.3** | `Content-Type: application/json`, and the body has `oid` | **mobile** |
| **R-4.1.4** | `Content-Type: application/json`, matching neither shape | `400 validation_error` |
| **R-4.1.5** | any other media type, or none | `415 unsupported_media_type` |

- **R-4.1.6** You may detect web and mobile by another rule. Document it in the Normalizer row of `docs/patterns.md` (§6).
- **R-4.1.7** **Tolerant reader.** Unknown JSON fields, and unknown XML elements and attributes, are ignored.
- **R-4.1.8** A field the translation needs that is missing gives `400 validation_error`.
- **R-4.1.9** After detection, in this order: translate (PA4); enrich every item from pricing; filter the payment data out; validate against `canonical/order.schema.json` and `items.length ≤ ORDER_ITEMS_MAX`; publish.
- **R-4.1.10** The same logical order, sent in any of the three formats, becomes the same canonical order, except for `orderId`, `orderType`, `source` and `receivedAt`: PA4's structural identity.

| ID | Outcome | HTTP | Body | Published? | Idempotency record |
|---|---|---|---|---|---|
| **R-4.1.11** | Accepted | `202` | `{correlationId, status: "accepted"}` | yes. Answer only **after the broker has confirmed** the publish | `done`, with the response |
| **R-4.1.12** | Missing or malformed `Idempotency-Key`; unparseable body; a missing required field; a translated order that fails the canonical schema; more than `ORDER_ITEMS_MAX` items | `400` | `{code: "validation_error", message}` | no | none: the key stays free |
| **R-4.1.13** | The same key and the same body, where "the same body" means the same bytes (compare SHA-256 of the raw body) | the stored status | the stored body: for an accepted order, the same `correlationId` | **no** | unchanged |
| **R-4.1.14** | The same key with a different body, whether or not the first request has finished | `409` | `{code: "idempotency_payload_mismatch"}` | no | unchanged |
| **R-4.1.15** | The same key and body while the first request is still being processed | `409` | `{code: "idempotency_conflict"}` | no | unchanged |
| **R-4.1.16** | An unknown product: pricing answers `404` | `422` | `{code: "unknown_product", productIds: [...]}`: every unknown id, as normalized for pricing (`PROD-…`). The whole order is rejected | no | `done`: the same key and body get the same `422` again |
| **R-4.1.17** | Pricing unavailable: any answer other than a product or a `404`, no answer within `REQUEST_TIMEOUT_MS`, or no connection | `503` + `Retry-After: <whole seconds, ≥ 1>` | `{code: "pricing_unavailable"}` | no | none: the same key works once pricing is back |
| **R-4.1.18** | The broker does not confirm the publish | `503` + `Retry-After` | `{code: "broker_unavailable"}` | not confirmed | none |

**The `order.accepted` event.**

- **R-4.1.19** Its body is the canonical order, unchanged. It is published to `orders.exchange` with `persistent: true` and publisher confirms.
- **R-4.1.20** Its headers are `correlationId` (the one `POST` returned), `causationId` (the `intake.publish` hop, §4.8) and `businessKey`. Its `properties.messageId` is set (R-3.3.3).

Intake also serves `GET /orders/:correlationId` (§4.4), `GET /dlq` and `POST /dlq/replay` (§4.6), and `GET /health` (§4.9).

### 4.2 The saga consumer — `cap-orchestrator:8802`, hand-rolled mode

**Consuming**

- **R-4.2.1** It consumes `saga.queue` with `prefetch ≥ SAGA_CONCURRENCY`, and runs up to `SAGA_CONCURRENCY` sagas at once (§4.10).
- **R-4.2.2** It parses the message **inside** `try`. A message that is not JSON, is not valid against the canonical schema, or has **no `correlationId` header** is permanent: publish it to `orders.invalid.exchange` with its original bytes and headers, ack it, and never retry it.

**Dedupe and redelivery**

- **R-4.2.3** The same `businessKey` under a **different** `correlationId` is a duplicate: record state `duplicate` with `duplicateOf` (the first order's `correlationId`), publish `order.duplicate`, ack. No step runs. This holds whatever state the first order is in.
- **R-4.2.4** The same `correlationId`, for a saga that already has an outcome (`completed`, `failed`, `compensated`, `compensation_failed`, `needs_attention` or `duplicate`), is a redelivery: **republish the stored outcome event** (the same envelope, a new `messageId`), then ack. No step runs.
- **R-4.2.5** The same `correlationId`, for a saga whose steps were running under an orchestrator run that no longer exists, is **stuck** (§4.7). No step runs.
- **R-4.2.6** No saga step ever runs twice for one `correlationId`. The one exception is the first step in the retry path (R-4.2.12), which repeats the same call with the same provider key.

R-4.2.4 heals a crash between persisting an outcome and publishing it: the unacked message comes back, and the outcome goes out again.

**Running the saga**

- **R-4.2.7** Before its first step, the saga publishes `order.processing`: the semantic lock (S7), visible through `GET /orders`.
- **R-4.2.8** **Route on `orderType`, never on `source`.** `standard` and `express`: payment → inventory → shipping → notification. `b2b` is invoiced, so there is no payment: inventory → shipping → notification.
- **R-4.2.9** The steps are PA6's HTTP calls. Every call carries `X-Correlation-Id`, `X-Causation-Id` (§4.8, rule 5), and for payment and inventory the provider `Idempotency-Key` (R-3.3.6).

| Step | Call | Body | Provider key | Compensation |
|---|---|---|---|---|
| payment | `POST {PAYMENT_URL}/payment/authorize` | `{orderId, amount}` | `authorize:<businessKey>` | `POST {PAYMENT_URL}/payment/refund`, `{orderId}`, key `refund:<businessKey>` |
| inventory | `POST {INVENTORY_URL}/inventory/reserve` | `{orderId, items}` | `reserve:<businessKey>` | `POST {INVENTORY_URL}/inventory/release`, `{orderId}`, key `release:<businessKey>` |
| shipping | `POST {SHIPPING_URL}/shipping/create` | `{orderId}` | none | none |
| notification | `POST {NOTIFICATION_URL}/notification/send` | `{orderId, recipient}` | none | none |

- **R-4.2.10** `amount` is the sum of `unitPrice × quantity`, added up in whole cents as integers, and sent as a decimal string with two fraction digits (`"63.90"`). `recipient` is `customer.email`.
- **R-4.2.11** A call that has not answered within `REQUEST_TIMEOUT_MS` has timed out.

**The first step fails** (payment; inventory for b2b)

- **R-4.2.12** A **temporary** failure (a 5xx, a timeout, or no connection) means nothing is known: the provider may already have charged or reserved. If this attempt is below `MAX_RETRIES`: `nack` it into the retry path, keep the state `processing`, and write a `saga.retry` hop.
- **R-4.2.13** At attempt `MAX_RETRIES`: write a `saga.dead_letter` hop, publish the message to `orders.dlq.exchange` with `originQueue: saga.queue` and `lastError`, then ack it. The state becomes `parked`, and `order.parked` is published.
- **R-4.2.14** A retry repeats the call with the same provider key, so it never produces a second effect.
- **R-4.2.15** A **permanent** failure (a 4xx): the state becomes `failed`, with the mock's `code`. Nothing is compensated.

**A later step fails**

- **R-4.2.16** Any later step that fails (a 4xx, a 5xx, a timeout, or no connection): compensate the completed steps in reverse order (§4.3), with the compensation keys. The outcome is `compensated`, with the failing call's code: the mock's `code`, `timeout`, or `unreachable`.
- **R-4.2.17** A compensation call that fails: the state becomes `compensation_failed`, and the remaining compensations are not attempted.

**Finishing**

- **R-4.2.18** Persist the saga's new state together with its outcome event, then publish the event, then ack the message.
- **R-4.2.19** With R-4.2.4, outcome events are **at-least-once**. Every consumer of `orders.outcome` tolerates duplicates.

To ack before the publish, you would need a real outbox. ADR-007 asks you to argue your choice.

### 4.3 Compensation matrix

| ID | `orderType` | Fails at | Compensations, in order | State · code |
|---|---|---|---|---|
| **R-4.3.1** | standard / express | payment, 4xx | none | `failed` · the mock's code |
| **R-4.3.2** | standard / express | payment, 5xx or timeout | none: the retry path, key `authorize:` | `processing` → `completed`, or `parked` |
| **R-4.3.3** | standard / express | inventory | `payment_refund` | `compensated` · the code |
| **R-4.3.4** | standard / express | shipping | `inventory_release`, `payment_refund` | `compensated` · the code, or `timeout` |
| **R-4.3.5** | standard / express | notification (saga step 4) | `inventory_release`, `payment_refund` | `compensated` · the code. PA6's semantics, kept on purpose |
| **R-4.3.6** | b2b | inventory, 4xx | none | `failed` · the mock's code |
| **R-4.3.7** | b2b | inventory, 5xx or timeout | none: the retry path, key `reserve:` | `processing` → `completed`, or `parked` |
| **R-4.3.8** | b2b | shipping | `inventory_release` | `compensated` · the code, or `timeout` |
| **R-4.3.9** | b2b | notification | `inventory_release` | `compensated` · the code |
| **R-4.3.10** | any | a compensation call | the remaining ones are not attempted | `compensation_failed` · the code of the step that failed |

### 4.4 Order lifecycle — `GET /orders/:correlationId`

- **R-4.4.1** `200 {correlationId, businessKey, orderId, source, orderType, state, code?, duplicateOf?, updatedAt}`, valid against `order-status.schema.json`, or `404` for a correlationId intake never accepted.
- **R-4.4.2** It answers `200`, state `accepted`, as soon as `POST /orders` has answered `202`.
- **R-4.4.3** `code` is present for `failed`, `compensated` and `compensation_failed`. `duplicateOf` is present for `duplicate`.

| ID | State | Set when | May move to |
|---|---|---|---|
| **R-4.4.4** | `accepted` | intake published the order | any other state |
| **R-4.4.5** | `processing` | the saga started (the semantic lock), or is in the retry path | `parked`, `completed`, `failed`, `compensated`, `compensation_failed`, `needs_attention` |
| **R-4.4.6** | `parked` | the saga's message was dead-lettered | `processing` (a replay), or any state `processing` may move to |
| **R-4.4.7** | `compensation_failed` | a compensation call failed | `compensated`, `compensation_failed` (operator compensation) |
| **R-4.4.8** | `needs_attention` | stuck detected (§4.7) | `compensated`, `compensation_failed` (operator compensation) |
| **R-4.4.9** | `completed`, `failed`, `compensated`, `duplicate` | terminal | nothing |

- **R-4.4.10** Lifecycle events are at-least-once, and may arrive late. An event that is not an allowed move from the current state is ignored, never applied. A terminal state never moves backwards.
- **R-4.4.11** The state reflects a published lifecycle event within **2 s**.

How intake learns the state is your choice: it can subscribe to `orders.outcome` (`#`), or ask the orchestrator. ADR-007 asks you to argue it.

### 4.5 Outcome events and the notifier — `cap-notifier:8803`

- **R-4.5.1** Lifecycle and outcome events are published to `orders.outcome` with `persistent: true`, at-least-once, with one of these routing keys: `order.processing`, `order.parked`, `order.completed`, `order.failed`, `order.compensated`, `order.compensation_failed`, `order.needs_attention`, `order.duplicate`.
- **R-4.5.2** The body is the envelope `{correlationId, businessKey, orderId, source, orderType, recipient, state, code?, duplicateOf?, occurredAt}`, valid against `outcome-event.schema.json`. The headers are `correlationId` and `causationId` (the `saga.outcome` hop), and `properties.messageId` is set.

**The notifier** consumes `notifications.queue`, which receives `order.failed` and `order.compensated` through the shipped bindings.

- **R-4.5.3** It dedupes redelivered outcome events on `correlationId`, persisted in `/data/processed-ids.json` so that the record survives a restart. It checks before it sends, and records after a successful send. A duplicate is acked, and a `notify.duplicate` hop is written.
- **R-4.5.4** It sends `POST {NOTIFICATION_URL}/notification/send` with `{orderId, recipient, kind: "order_not_completed", reason: <the event's code>}`, and with `X-Correlation-Id` and `X-Causation-Id`.
- **R-4.5.5** It appends one JSON line to `/data/notification.log` for each notice sent.
- **R-4.5.6** **Notices are at-least-once, by design.** When the provider sent a notice but the call reported a failure or timed out, a retry or a replay may send a second notice. That is accepted: the notification provider offers no idempotency key, and a duplicate notice is not a duplicate charge.
- **R-4.5.7** A failed send (not a 2xx, a timeout, or no connection) is temporary: it goes through the retry path with a `notify.retry` hop, and after `MAX_RETRIES` attempts to `orders.dlq.exchange` with `originQueue: notifications.queue` and `lastError`, with a `notify.dead_letter` hop.
- **R-4.5.8** A malformed message goes to `orders.invalid.exchange`, as in R-4.2.2.

ADR-008 asks why a notice may be sent twice while a charge must not happen twice.

### 4.6 The invalid channel, and DLQ operations on intake

- **R-4.6.1** `GET /dlq` answers `200 {count, entries: [{messageId, correlationId, originQueue, attempts, lastError, deadLetteredAt}]}`, valid against `dlq-list.schema.json`. `attempts` is how many times the message failed before it was dead-lettered.
- **R-4.6.2** `GET /dlq` is **non-destructive**: afterwards `orders.dlq` holds the same messages, none lost and none duplicated. Their order may change.
- **R-4.6.3** `POST /dlq/replay` with the body `{}` replays every entry. With `{correlationId}`, it replays only the entries with that correlationId.
- **R-4.6.4** Each replayed entry is republished to `orders.return.exchange` with routing key = its `originQueue`, headers from `withoutRetryHistory` (so it gets fresh attempts), `causationId` = the `dlq.replay` hop, and a new `messageId`.
- **R-4.6.5** The DLQ entry is acked only after the broker has confirmed the republish.
- **R-4.6.6** `POST /dlq/replay` answers `200 {replayed, remaining}`: how many were replayed, and how many are left in the DLQ.
- **R-4.6.7** **Nothing ever replays `orders.invalid`.** A message there keeps its original bytes and headers.
- **R-4.6.8** A replayed message whose cause is not fixed gets its `MAX_RETRIES` attempts again, and returns to the DLQ: not lost, not duplicated, not stuck.
- **R-4.6.9** A poison message never blocks a queue: the next valid message is processed within its normal time.

Peeking at a RabbitMQ queue is genuinely awkward: AMQP has no "look without taking". `withoutRetryHistory` is in your PA5 `shared/rabbit.ts`.

### 4.7 Stuck sagas and operator compensation (on the orchestrator)

- **R-4.7.1** **Detection.** After an orchestrator restart, a saga whose steps were running under the previous run is marked `needs_attention` within `SAGA_STUCK_AFTER_MS` of the orchestrator starting. `order.needs_attention` is published, and a `saga.stuck` hop written.
- **R-4.7.2** No step of a stuck saga is ever re-run automatically.
- **R-4.7.3** The detection rule is yours. ADR-010 names it, and its false positives.
- **R-4.7.4** `GET /sagas/stuck` answers `200 {sagas: [{correlationId, businessKey, state, completedSteps, compensatedSteps, since}]}`, listing every saga in `needs_attention` or `compensation_failed`.
- **R-4.7.5** `POST /sagas/:correlationId/compensate` runs, in reverse order, the compensations of the completed steps that are not yet compensated, with the keys from R-3.3.6. Shipping and notification have none. It records `operatorCompensation` in the saga store, writes a `saga.operator_compensate` hop, and publishes the outcome.

| ID | State when it is called | Response | Effect |
|---|---|---|---|
| **R-4.7.6** | `needs_attention` | `200 {correlationId, state}`, `state` = `compensated` or `compensation_failed` | runs the outstanding compensations. When they all succeed, the order is `compensated` with the code `operator_compensated`: no step failed |
| **R-4.7.7** | `compensation_failed` | `200 {correlationId, state}` | runs **only** the compensations that have not yet succeeded. When they all succeed, the order is `compensated` with the code of the step whose failure started the compensation, as in R-4.2.16 |
| **R-4.7.8** | `compensated`, **with** `operatorCompensation` recorded | `200`, the same body as the call that finished it | none: an idempotent repeat |
| **R-4.7.9** | an operator compensation already running for this saga | `409 {code: "compensation_in_progress"}` | none |
| **R-4.7.10** | `compensated` with no operator record, `completed`, `failed`, `duplicate`, `processing`, `parked`, `accepted` | `409 {code: "saga_not_stuck"}` | none |
| **R-4.7.11** | an unknown correlationId | `404` | none |

- **R-4.7.12** In `temporal` mode, `GET /sagas/stuck` answers `{sagas: []}`, and compensate answers `409 saga_not_stuck`.

### 4.8 The trace — the wire tap and `cap-observer:8801`

- **R-4.8.1** Every one of your services publishes one **hop record** to `trace.events` for each unit of work: one hop for each operation in the table below, each time it happens.
- **R-4.8.2** Publishing a hop never blocks or fails the business operation. ADR-009 asks you to argue how.
- **R-4.8.3** The observer consumes `trace.store`, and appends each hop to `/data/trace-store.jsonl`.
- **R-4.8.4** `GET /trace/:correlationId` answers `200 {correlationId, hops: [...]}`, sorted by `startedAt` and valid against `trace.schema.json`, or `404`.

`/trace.html` is optional and ungraded: build it if you want your own drill tool.

- **R-4.8.5** A hop is valid against `trace-hop.schema.json`:

| Field | Rule |
|---|---|
| `hopId` | a new UUID v4 |
| `correlationId` | the order's |
| `causationId` | the `hopId` of the hop that caused this one, or `null` for the root only (rules below) |
| `service` | `intake`, `orchestrator`, `notifier`, `observer` or `worker` |
| `operation` | one of the names in the table below |
| `status` | `success`, `failed`, `timeout`, `retried`, `dead_lettered`, `quarantined`, `skipped` or `duplicate` |
| `attempt` | ≥ 1: the delivery attempt of the message being handled (from `x-death`), or 1 |
| `messageId` | optional: the AMQP `messageId` of the message consumed or published |
| `startedAt`, `finishedAt` | ISO-8601 timestamps |
| `durationMs` | `finishedAt − startedAt`, whole milliseconds |
| `detail` | optional object, for example `{code}` |

Use the statuses the operation names suggest: `retried` on a `*.retry` hop, `dead_lettered` on a `*.dead_letter` hop, `quarantined` on `invalid.quarantine`, `duplicate` on `notify.duplicate` and on the `saga.dedupe` of a duplicate.

- **R-4.8.6** The operation names are fixed:

| Service | Operations |
|---|---|
| intake | `intake.receive` (the root) · `intake.translate` · `intake.enrich` · `intake.publish` · `dlq.replay` |
| orchestrator | `saga.consume` · `saga.dedupe` · `payment` · `inventory` · `shipping` · `notification` · `inventory_release` · `payment_refund` · `saga.retry` · `saga.dead_letter` · `saga.outcome` · `saga.stuck` · `saga.operator_compensate` · `workflow.start` (temporal mode) |
| notifier | `notify.consume` · `notify.send` · `notify.duplicate` · `notify.retry` · `notify.dead_letter` |
| any consumer | `invalid.quarantine`, written only when the message has a `correlationId` header |
| worker | the saga step names above, and `saga.outcome` when an activity publishes the outcome event, all with `service: "worker"` |

- **R-4.8.7** A b2b saga makes no payment call, so its trace has no payment hop.

**Causation rules.** These are exact, because the hidden tests check them.

- **R-4.8.8** Rule 1. `intake.receive` is the only hop with `causationId: null`. Within one service, each hop is caused by the previous hop of the same flow, except where rules 3 and 6 say otherwise.
- **R-4.8.9** Rule 2. A published message carries `headers.causationId` = the `hopId` of the hop that published it: `intake.publish`, `saga.outcome`, `saga.dead_letter`, `notify.dead_letter` or `dlq.replay`. The consumer's first hop (`saga.consume` or `notify.consume`) has `causationId` = that header.
- **R-4.8.10** Rule 3, **retry.** `nack` cannot rewrite headers, so **every delivery attempt of one message has the same `causationId`**: the publisher's hop. The attempts differ by `attempt` (from `x-death`). Each failed attempt is followed by a `saga.retry` or `notify.retry` hop, caused by that attempt's consume hop. If you republish explicitly instead of nacking, that is correct too, as long as rules 2 and 3 still hold.
- **R-4.8.11** Rule 4, **replay.** `dlq.replay` is caused by the DLQ message's `causationId` (its `*.dead_letter` hop). The replayed message carries `causationId` = the `dlq.replay` hop.
- **R-4.8.12** Rule 5, **mock calls.** `X-Causation-Id` = the `hopId` of the step hop that stands for the call. Generate the `hopId` before the call.
- **R-4.8.13** Rule 6, **compensation.** `inventory_release` is caused by the failed step's hop. `payment_refund` is caused by `inventory_release` when both run, and by the failed step's hop otherwise.

### 4.9 Operations: metrics, alerts, deep health, reconnect

**`GET /ops/metrics`**, on the observer:

```jsonc
{ "generatedAt": "…",
  "queues": { "saga.queue": {"ready": 0, "unacked": 0, "consumers": 1}, "notifications.queue": {…},
              "orders.dlq": {…}, "orders.invalid": {…}, "trace.store": {…} },
  "dlqDepth": 0, "invalidDepth": 0, "stuckSagas": 0,
  "alerts": [ {"key": "dlq_not_empty", "firing": false, "value": 0, "threshold": null}, … ] }
```

- **R-4.9.1** It is valid against `ops-metrics.schema.json`, and `queues` holds `ready`, `unacked` and `consumers` for the five queues shown.
- **R-4.9.2** `dlqDepth` is the number of messages in `orders.dlq`, ready and unacked; `invalidDepth` the same for `orders.invalid`. `stuckSagas` is the number of sagas `GET /sagas/stuck` lists.
- **R-4.9.3** `alerts` holds exactly the seven keys below, each as `{key, firing, value, threshold}`. `firing` is exactly the predicate applied to `value`.

| ID | Key | `value` | Fires when | `threshold` |
|---|---|---|---|---|
| **R-4.9.4** | `dlq_not_empty` | `dlqDepth` | value > 0 | `null` |
| **R-4.9.5** | `invalid_not_empty` | `invalidDepth` | value > 0 | `null` |
| **R-4.9.6** | `saga_consumer_missing` | `saga.queue` consumers | value = 0 | `null` |
| **R-4.9.7** | `notifier_consumer_missing` | `notifications.queue` consumers | value = 0 | `null` |
| **R-4.9.8** | `saga_consumer_lag` | `saga.queue` ready | value > threshold | yours: a whole number, 1–20 |
| **R-4.9.9** | `notifier_consumer_lag` | `notifications.queue` ready | value > threshold | yours: a whole number, 1–20 |
| **R-4.9.10** | `stuck_sagas` | `stuckSagas` | value > 0 | `null` |

- **R-4.9.11** Your runbook justifies both lag thresholds (§6). The tests read the threshold you declare as the alert's `threshold` in `/ops/metrics`, and go past it.

`stuckSagas` comes from `GET /sagas/stuck`. For the queue figures, know your sources. A passive queue declare (`checkQueue` in amqplib) gives `ready` and `consumers` exactly, at the moment you ask. RabbitMQ's management API (port 15672 inside the Compose network) is the only source of `unacked`, but it can report an idle queue's figures several seconds late: a message just dead-lettered may not show there yet.

**`GET /health`**, on intake, observer, orchestrator and notifier:

- **R-4.9.12** `200 {status: "ok", checks: {broker: "up", consumers: {"<queue>": n}}}` when the service is connected to the broker and consuming every queue it consumes. `consumers` lists each queue this service consumes, with its consumer count.
- **R-4.9.13** `503 {status: "degraded", checks: {…}}` otherwise, including while the broker is down.

**Reconnect.**

- **R-4.9.14** After a broker restart, every service reconnects, declares again what it declares, and consumes again, within **30 s** of the broker being healthy.
- **R-4.9.15** It does this **without a container restart**. The process does not exit; a restart by Docker's restart policy counts as a container restart.

### 4.10 Concurrency

- **R-4.10.1** Sagas for different orders run concurrently, up to `SAGA_CONCURRENCY` at once.
- **R-4.10.2** The steps within one saga never overlap.
- **R-4.10.3** The stores stay consistent under concurrency: no lost update, and no second saga for one business key.

### 4.11 Temporal mode — the advanced component (15 points)

Start it with:

```bash
SAGA_ENGINE=temporal docker compose --profile temporal up -d --build --wait
```

- **R-4.11.1** The orchestrator's `saga.queue` consumer **starts** the workflow type `checkout` on the task queue `checkout` (namespace `default`), with `workflowId = businessKey`. Then it acks, and writes a `workflow.start` hop.
- **R-4.11.2** `WorkflowExecutionAlreadyStarted` for the same `correlationId` is a redelivery: ack.
- **R-4.11.3** `WorkflowExecutionAlreadyStarted` for a different `correlationId` is a duplicate, as in R-4.2.3.
- **R-4.11.4** The workflow is your PA7 port plus the b2b branch. Outcome events and trace hops are published **from activities**, never from workflow code.
- **R-4.11.5** The retry policy is PA7's: `maximumAttempts` 3, `initialInterval` 200 ms, `backoffCoefficient` 2, with `startToCloseTimeout` 2500 ms. A 4xx is non-retryable. The provider idempotency keys still apply.
- **R-4.11.6** A payment outage shorter than the retry budget is absorbed by the activity retries. There is no DLQ in this path.
- **R-4.11.7** A shipping timeout is attempted 3 times, then compensated (PA7's semantics).
- **R-4.11.8** Everything else is as in the core: the same states, the same lifecycle and outcome events, the same trace operations (with `service: "worker"` for the steps), the same effects on the mocks.
- **R-4.11.9** `docs/adr/adr-011.md` lists at least 3 items under `## What the engine took over`, and names what it did not take over.
- **R-4.11.10** Your `capstone/README.md` declares the advanced component (R-5.3.2). If it does not, the advanced suite does not run.

The 15 points are all or nothing: every advanced test must pass ([GRADING.md](GRADING.md)).

---

## 5) The kit, and what you build

### 5.1 What is in the kit

```
capstone/
  README.md                  this brief. Replace it with your own (R-5.3.2)
  GRADING.md                 the scale, the areas and points, the manual criteria
  doctor-spec.md             OPTIONAL: a spec for your own conformance checker. Not graded
  docker-compose.kit.yml     the kit services: rabbitmq, pricing, the four mocks, temporal (profile)
  docker-compose.yml         include: [docker-compose.kit.yml], and your services, declared with their
                             fixed names, ports, env, mem_limit, named volumes and healthchecks. Yours to edit
  .env.example               SAGA_ENGINE=handrolled
  .dockerignore              keeps node_modules, mocks, tests and docs out of your build context
  rabbitmq/                  definitions.json (§3.2), rabbitmq.conf
  mocks/                     pricing, payment, inventory, shipping, notification
  grading/schema/            the JSON Schemas named in §3 and §4
  tests/public/              the staged public tests, one file per stage (§7)
  tests/lib/                 what the tests share: targets, mocks, broker, fixtures, schemas
  tests/fixtures/            web, mobile and b2b orders
  docs/                      the templates for §6
```

### 5.2 The mocks, by hand

The mocks stand in for the providers. Your services call only their business endpoints (§4.2). Their `/admin` endpoints are for you and the tests: to see what happened, and to make things go wrong. Your code never calls `/admin`: at grading the mocks are replaced (R-5.3.3).

**Payment (4801), inventory (4802), shipping (4803) and notification (4804):**

| Endpoint | What it gives you |
|---|---|
| `GET /admin/logs?orderId=…` (or `?correlationId=…`) | every call, with the headers it carried (`x-correlation-id`, `x-causation-id`, `idempotency-key`) and when it arrived and was answered |
| `GET /admin/effects?orderId=…` | what really happened: charges, refunds, reservations, releases, shipments, notices. A call that timed out on your side may still have had its effect: this is the ground truth |
| `POST /admin/config` | make an operation fail or slow down (below) |
| `GET /admin/config` | the settings in force |
| `POST /admin/reset` | clears the logs, the effects and the stored idempotency keys, and puts the settings back to their defaults |

`POST /admin/config` takes settings per operation: `authorize` and `refund` on payment, `reserve` and `release` on inventory, `create` on shipping, `send` on notification. For example, `{"reserve":{"failMode":"always"}}` on port 4802 makes every reservation fail.

| Setting | Meaning |
|---|---|
| `failMode` | `never`, `always`, `times` (the first `failTimes` calls fail, then calls succeed) |
| `failStatus` | the HTTP status of the failure: 400–599, default 422 |
| `failCode` | the `code` in its body. Default: the provider's own code for a 4xx (`payment_declined`, `inventory_unavailable`, `shipping_unavailable`, `refund_failed`, `release_failed`, `notification_failed`), `service_unavailable` for a 5xx |
| `delayMs` | wait this long before answering, failure or not. Longer than `REQUEST_TIMEOUT_MS` is a timeout |
| `effectThenFail` | the failure happens **after** the effect: the provider did the work, but your call failed or timed out. The unknown state of R-4.2.12 |
| `failForOrderIds`, `failForKinds` (notification) | only the matching calls fail |

A delayed call performs its effect when the delay ends, even if your service gave up waiting. Payment and inventory honour `Idempotency-Key`: a key that already had an effect gets the stored answer again, with no new effect.

**Pricing (4110)** is PA4's mock, and every endpoint but `/health` needs `X-API-Key: pa4-pricing-key-2026`, PA4's key. `POST /admin/config` takes `{"outage":true}` (every `/pricing` call answers 500), `{"delayMs":…}` and `{"status401":true}`. `PUT /admin/pricing/:productId` changes a product, as in PA4. `GET /admin/logs` and `POST /admin/reset` work as above.

The full reference is the comment at the top of `mocks/providers/src/engine.ts` and of `mocks/pricing/server.js`.

### 5.3 Your repository, and what grading replaces

```
eai-2026-<surname>/
  canonical/                       from PA4, unchanged
  pa4/ … pa7/                      untouched: their history is the evidence that you wrote them
  capstone/
    (the kit files, as given)
    intake/  observer/  orchestrator/  notifier/  worker/ (advanced)  shared/ (optional)
    README.md                      yours: how to run it, SAGA_ENGINE, known limitations
    docs/ …                        §6
```

- **R-5.3.1** Your services are built from `intake/`, `observer/`, `orchestrator/`, `notifier/` and, for the advanced component, `worker/`. Code they share may live in `shared/`.
- **R-5.3.2** Your `capstone/README.md` replaces this brief. It says how to run your system and what its known limitations are, and it has a section `## Advanced component` whose first line is `Implemented.` or `Not implemented.`
- **R-5.3.3** At grading, `../canonical/`, `docker-compose.kit.yml`, `mocks/` and `grading/schema/` are replaced with the official copies. A change you make to any of them does not count.
- **R-5.3.4** Your `tests/` is never run at grading. The grader runs its own copy of the tests, from outside your repository.
- **R-5.3.5** `docker-compose.yml` and `rabbitmq/definitions.json` are not replaced. You may add to them. §9 and the stage 0 public tests check their fixed parts.

### 5.4 Broken prior work

Fixing your PA4–PA7 code inside `capstone/` is expected, and it is simply part of the capstone. No reference solutions are released.

### 5.5 Dependencies

- **R-5.5.1** Allowed: `amqplib`, `express` or `fastify`, `fast-xml-parser`, `ajv` (with `ajv-formats`), `@temporalio/*`, `uuid`, and test and development tooling. In Python: `pika` or `aio-pika`, `flask` or `fastapi`, `lxml`, `jsonschema`, `temporalio`.
- **R-5.5.2** Any other dependency is named, with its reason, in `docs/ai-usage.md` (§6).
- **R-5.5.3** Forbidden: saga or workflow libraries other than Temporal; messaging frameworks that hide acks, retries or DLQs (for example `rascal`, or NestJS microservices); OpenTelemetry auto-instrumentation used **instead of** your own header propagation; any database container.

### 5.6 Language

TypeScript is supported. Python is permitted everywhere: it is graded identically, black-box, and it is unsupported, as in the [SYLLABUS](../SYLLABUS.md).

---

## 6) Documents

All of them live in `capstone/docs/`, and the kit has a template for each. The public tests in stage 6 check what a machine can check: that the files, headings, rows and links are there. The 10 manual points judge your reasoning, by the criteria in [GRADING.md](GRADING.md).

The templates give each file's headings as the tests expect them, the link format for `patterns.md`, and the ADR index with its links. They keep their prompts in HTML comments (`<!-- … -->`). A comment is not your text: a heading counts only with text of yours under it. Delete each prompt when you have written its section.

| ID | File | Required content |
|---|---|---|
| **R-6.1** | `architecture.md` | `## System context` and `## Integration architecture`, each with a ` ```mermaid ` block. The integration architecture shows every exchange and queue, the retry, DLQ and invalid paths, and the wire tap, and names at least 6 of the exchanges and queues in §3.2 |
| **R-6.2** | `orchestration.bpmn`, plus an `orchestration.svg` or `orchestration.png` export | Real BPMN 2.0 XML, from bpmn.io or Camunda Modeler: a message start event, the b2b exclusive gateway, one task per step, error boundary events, timer boundary events for timeouts, compensation, and one end event per outcome |
| **R-6.3** | `patterns.md` | A table with the columns Pattern · Problem · Where · Why, and at least 8 rows, the Normalizer among them. **Where** is a link to a `file:line` in your code that resolves. A row that claims something the code does not do is a false claim, and costs points ([GRADING.md](GRADING.md), M4) |
| **R-6.4** | `failure-analysis.md` | The ten scenarios below, each under its own heading, each with: Trigger · What the system does, with a real trace excerpt in a fenced block · Final state · The alert that fires, or `none, by design` with the reason · Operator action. **Describe a known defect as it actually behaves** |
| **R-6.5** | `runbook.md` | One section per alert key in §4.9 (all seven): its meaning, at least 2 likely causes, diagnostic commands, the fix, and how to verify the fix. It justifies your two lag thresholds |
| **R-6.6** | `agent-readiness.md` | `## Tools` (3–5 tools an agent could use on this system, read tools apart from write tools, with input schemas) · `## Injection paths` · `## Controls` · `## Not exposed` |
| **R-6.7** | `ai-usage.md` | `## Tools used` · `## What for` · `## What I changed or rejected` · `## What I verified, and how` · `## Dependencies beyond the allow-list` |
| **R-6.8** | `adr/README.md` | An index table (number, title, status, link) for ADR-000 to ADR-006, linking to your own PA ADRs (`../../../pa1/docs/adr-000.md` … `../../../pa7/docs/adr-006.md`), and ADR-007 to ADR-010 (and 011). Every link resolves |
| **R-6.9** | `adr/adr-007.md` … `adr-010.md` | The course's four headings: `## Context` · `## Decision` · `## Alternatives considered` · `## Consequences`. The templates carry the questions (below) |
| **R-6.10** | `adr/adr-011.md` *(advanced)* | PA7's ADR-006 headings: the four above, plus `## What the engine took over`, with at least 3 items under it (R-4.11.9) |

**The ten failure-analysis scenarios:**

1. payment declined
2. inventory unavailable
3. shipping timeout
4. a refund fails (`compensation_failed`, then operator compensation)
5. a payment outage before step 1 (retry → parked → replay)
6. a failure-notice delivery outage (notifier DLQ → replay)
7. the orchestrator crashes mid-saga
8. a broker restart
9. a duplicate submission with a new Idempotency-Key
10. a malformed message

**The four ADRs, and what each must answer:**

- **ADR-007, the seam.** Why is the saga started by an event and not by HTTP? When does the consumer ack, and what does each choice lose? What happens if the orchestrator crashes after persisting the terminal state and before publishing the outcome? How do prefetch and `SAGA_CONCURRENCY` interact? How does `GET /orders` learn the state, and why can it never move backwards?
- **ADR-008, the dedup layers.** For each layer (the intake `Idempotency-Key`, the saga business key, the provider keys), name one concrete failure that only that layer catches. Why are notices at-least-once, while a charge must be exactly-once in effect? What does business-key dedupe do to a customer who orders again after a decline?
- **ADR-009, the trace design.** Wire tap, scatter-gather, or OpenTelemetry? Is publishing a hop confirmed, or fire-and-forget, and what does a lost hop cost? Causation across a retry, given that `nack` cannot rewrite headers. What happens when the observer is down?
- **ADR-010, stuck sagas.** Your detection rule, and its false positives. Why not resume automatically? The compensation matrix, b2b included. What an operator must know before pressing compensate. What Temporal changes.

---

## 7) Testing

The public tests are in `tests/public/`, one file per stage. Run them from `capstone/`, against your stack in hand-rolled mode:

```bash
npm --prefix tests ci                              # once, and again whenever the kit's tests change
docker compose up -d --build --wait
npm --prefix tests run test:stage -- 2             # stages 0, 1 and 2
npm --prefix tests run test:stage                  # every stage, 0 to 6
npm --prefix tests run test:stage -- 1 -t P1.3     # one test: anything after the stage number goes to vitest
npm --prefix tests run test:stage -- 6 -t P6       # the document tests only: no stack needed
```

`-t` runs only the tests whose name matches, so `-t P6` skips every other test, stage 0's too. `node tests/stage.mjs 3` does the same as `npm --prefix tests run test:stage -- 3`, and `node tests/stage.mjs 6 -t P6` the same as the last line. Use that form in PowerShell, which can swallow the `--` before npm sees it.

**What the tests do.**

- Before each test, they wait until `saga.queue`, `notifications.queue` and their retry queues hold no message, then reset every mock. A queue that nothing consumes is skipped. A message still going round after 30 s fails the next test with "… to hold no ready and no unacked message before the next test": one of your handlers fails on that message every time. See §10.
- Every order a test sends has a fresh `orderId` and a fresh `Idempotency-Key`, so no test collides with your own orders, or with another test.
- They run one at a time. Some stop and start your containers: P5.4 stops `cap-notifier`, then starts it again.
- Stage 0 reads your `docker-compose.yml` through `docker compose config`. Stage 6 reads your `docs/`, and needs no running stack.

**What a failure tells you.** Each failure names the requirement IDs, the README section and what the test observed:

```
Failed: R-4.9.12, R-3.1.2 (README §4.9, §3.1):
  - intake: R-3.1.2 (README §3.1): GET http://localhost:8800/health: no answer (ECONNREFUSED).
    Is cap-intake running and healthy? `docker compose ps` shows your containers; …
```

**Where the tests look.** At the ports and container names of §3.1 on `localhost`, so with your stack running on your machine you set nothing. For a stack elsewhere, set environment variables before the command: `CAP_HOST` for another host, `CAP_INTAKE_URL` and its siblings for one service, `CAP_AMQP_URL`, `CAP_MANAGEMENT_URL`, `CAP_CONTAINER_<SERVICE>` for a container name, or `CAP_COMPOSE_PROJECT` to find everything through a Compose project. The full list is at the top of `tests/lib/targets.ts`.

**A doctor of your own.** Optional, and not graded: [doctor-spec.md](doctor-spec.md) specifies a conformance checker you can build for yourself. It checks the contract's fixed parts (names, ports, variables, limits, volumes, the topology, the document files, `/health`) in seconds.

**At grading.** Your `tests/` is never run (R-5.3.4). The grader runs the official copy of these tests from outside your repository, then the hidden tests, in hand-rolled mode ([GRADING.md](GRADING.md) §7). Changing a test here changes nothing at grading. A test that fails only sometimes usually means a race in your code: find it before the grader does.

**The hidden tests** check the same requirements with other cases, and step 6. They are not published. §4 is what they test, and [Checking step 6 by hand](#checking-step-6-by-hand) is the best preparation.

### Checking the advanced component

No public tests cover it. [GRADING.md](GRADING.md) §6 lists its seven conditions, T1–T7, in their graded wording, and all seven must pass. The table below is how to check each one by hand. Start in temporal mode, and time it:

```bash
docker compose down -v
SAGA_ENGINE=temporal docker compose --profile temporal up -d --build --wait
```

In PowerShell, set the variable first: `$env:SAGA_ENGINE="temporal"`. Or copy `.env.example` to `.env` and change it there; your `.env` is never read at grading (§9).

| | How to check it by hand |
|---|---|
| T1 | `up --wait` finishes within 7 minutes (R-3.6.1). The Temporal UI, <http://localhost:8240>, shows workers polling the task queue `checkout`. `GET http://localhost:8802/sagas/stuck` answers `{"sagas":[]}`, and `POST /sagas/<cid>/compensate` answers `409 saga_not_stuck` for an order you sent (R-4.7.12) |
| T2 | The web and b2b fixtures complete. The UI shows one workflow per order, its id = the `businessKey`. `GET /trace/:cid` has the step hops, with `service: "worker"`. The mocks' effects are the same as in hand-rolled mode |
| T3 | `{"reserve":{"failMode":"always"}}` on 4802 → `compensated`. `{"create":{"delayMs":3000}}` on 4803, longer than `REQUEST_TIMEOUT_MS` → three shipping calls, then `compensated` with `timeout`. Inventory failing and `{"refund":{"failMode":"always"}}` on 4801 → `compensation_failed` |
| T4 | `{"create":{"delayMs":2000}}` on 4803, shorter than `REQUEST_TIMEOUT_MS`. An order, `docker kill cap-worker` a second later, while shipping is in flight, then `docker start cap-worker` → `completed`, with one charge and one reservation |
| T5 | `{"authorize":{"failMode":"times","failTimes":2,"failStatus":503}}` on 4801 → `completed`, one charge, and `GET /dlq` empty |
| T6 | Publish an `order.accepted` again from the management UI, as in step 6: still one workflow, and one charge. Submit the same fixture again with a new `Idempotency-Key` → `duplicate` (R-4.11.3) |
| T7 | `docs/adr/adr-011.md` has its five headings, your text under each, and at least 3 list items under `## What the engine took over` |

Everything else in temporal mode is as in the core (R-4.11.8). The core's 90 test points are always graded in hand-rolled mode, and the public tests expect it. To go back: `docker compose --profile temporal down`, unset `SAGA_ENGINE` (in PowerShell, `Remove-Item Env:SAGA_ENGINE`), then `docker compose up -d --build --wait`.

---

## 8) Grading

See [GRADING.md](GRADING.md): the scale, the pass line, the point areas, the manual criteria, the advanced component and the defence.

---

## 9) The configuration policy

Before anything runs at grading, I resolve your Compose configuration exactly like this:

```bash
docker compose -f docker-compose.yml --env-file <the grader's env file> config
```

So a `docker-compose.override.yml`, and your own `.env`, are never loaded at grading. The resolved configuration must meet every rule below.

- **R-9.1** Every kit service is exactly as the official `docker-compose.kit.yml` defines it: its image or build, command, entrypoint, environment, ports and volumes. Keep the `include:` line, and do not redefine or override a kit service.
- **R-9.2** No service uses `privileged`, `cap_add`, `devices`, `network_mode: host`, `pid: host` or `ipc: host`.
- **R-9.3** No service bind-mounts the Docker socket, or any host path outside `capstone/`. The one exception: `../canonical`, mounted read-only.
- **R-9.4** No volume or network has a fixed `name:`, and no network is `external`.
- **R-9.5** Each of your services declares its `mem_limit` (R-3.6.2).

A configuration that breaks a rule is **POLICY REJECTED**: nothing runs, and I review the case myself ([GRADING.md](GRADING.md)).

`include:` needs Docker Compose 2.20 or later (R-3.1.8): [check yours](#check-docker-compose-first).

---

## 10) Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A container exits with code 137 | it went over its `mem_limit` (R-3.6.2) | find the leak, or stream instead of buffering. The limit is part of the contract |
| A service stays `unhealthy`, and `up --wait` fails | the healthcheck calls `curl` or `wget`, which `node:20-bookworm-slim` does not have; or the service does not listen on `$PORT` | keep the given healthcheck (`node -e "fetch(…)"`), and listen on `process.env.PORT`. On a Python image, write the same check in Python. `docker inspect --format "{{json .State.Health}}" cap-intake` shows the last checks |
| `PRECONDITION_FAILED - inequivalent arg …` at start, and the channel closes | your code asserts a queue of §3.2 with other arguments than `definitions.json` gives it | assert it with exactly the arguments in §3.2, or not at all: it already exists |
| `docker compose` rejects `include` | Docker Compose older than 2.20 (R-3.1.8) | update Docker Desktop, then [check the version again](#check-docker-compose-first) |
| A fixture you send by hand ends `duplicate` | business-key dedupe (R-4.2.3): that `orderId` was sent before | change the `orderId` in a copy of the fixture, or `docker compose down -v` |
| `port is already allocated` | something else holds a port of §3.1 | `docker ps` finds a container that holds it; stop it, or close the program that does |
| Every test fails with `ECONNREFUSED` | the stack is not running, or a service is not healthy | `docker compose ps`, then `docker compose logs <service>` |
| A test fails before it starts: "… to hold no ready and no unacked message before the next test" | a message goes round the retry path for ever: a handler of yours fails on it every time | `docker compose logs orchestrator notifier` names the error. Purge the queue in the management UI, fix the handler, and run again |
| The b2b order's diacritics are wrong (`�` for `š`) | the bytes were decoded as UTF-8 | decode by the XML declaration's `encoding` (R-4.1.1). By hand, send the fixture with `--data-binary` |
| Your change does not show | the container still runs the old image | `docker compose up -d --build --wait`: `--build`, every time |
| `cap-worker` exits at start in temporal mode | Temporal was not ready yet, or the image is Alpine | connect with retries, as PA7 does, and base the image on `node:20-bookworm-slim` (R-3.6.3) |
| A stage 0 test says your compose file does not resolve | `docker compose config` fails on it | run `docker compose config` yourself: it names the problem |

---

## Submitting

Your work goes in **your** repository, in `capstone/` (§5.3). Before you submit:

1. **Replace this brief with your own `README.md`** (R-5.3.2): how to run your system, `SAGA_ENGINE`, your known limitations, and the section `## Advanced component`, whose first line is `Implemented.` or `Not implemented.`
2. **Commit and push everything, then run it once from a clean clone.** That catches the file you never committed, and the build that works only because of something left on your machine. If you built step 8, check it there in temporal mode too (§7). Stop your working stack first (`docker compose down` in your working copy): both stacks are the Compose project `capstone`, so they share names and ports.

   ```bash
   git clone <your repository URL> capstone-check
   cd capstone-check/capstone
   docker compose up -d --build --wait
   npm --prefix tests ci
   npm --prefix tests run test:stage
   docker compose down -v
   ```

3. **Submit your repository URL through the portal, <https://evaluentis.leitass.eu>.** Never by email. The graded commit is the SHA at `HEAD` of the branch you name in the portal, **when you submit**: later pushes are not seen. Before the deadline you may resubmit as often as you like, and the last submission counts.

**Late:** capstone points × max(0, 1 − 0.02 × started hours after the deadline). More than 32 hours late, even 115 points fall below the 41.0 pass line. The hard cut-off is **2026-11-23, 20:00**: after it, no submission is accepted. A resubmission after the deadline restarts the penalty clock from its own time ([SYLLABUS](../SYLLABUS.md) §7, [GRADING.md](GRADING.md) §8).

---

## Changes

- **2026-11-04** — §1: a Mermaid diagram of the system, above the text diagram. It explains the system; it adds no requirement and changes none. Nothing to copy again.
