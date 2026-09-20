# PA2 — RabbitMQ publish and consume

| | |
|---|---|
| **Session** | S2 — Messaging fundamentals · 2026-09-16, A410 |
| **Scaffold language** | TypeScript |
| **Published** | with S2 on 2026-09-16 |
| **Deadline** | **2026-09-28, 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-10-05, 20:00** — miss it and the capstone is not graded |
| **Weight** | one seventh of the homework half — about 7.1% of the final grade |
| **Mark** | 70% automated tests, 30% manual (ADR quality, self-assessment honesty) |
| **ADR** | `docs/adr-001.md` |

---

## The situation

Every order your system takes now has to reach a warehouse service that is
sometimes slow, sometimes offline for maintenance, and never something you
control the uptime of. You cannot make an HTTP call and block on it — if the
warehouse service is down for ten minutes, that is not your outage too. You
put a broker in between.

This is also, for most of you, the first container you have ever run that
holds state instead of just serving a script. A file on disk is either there
or it isn't. A message broker has a queue that can be durable or not,
messages that can be persistent or not, and a producer that can find out the
broker actually has your message or just hope so. Session 3 needs this
broker running smoothly, so getting comfortable with `docker restart` and
`docker compose logs` this week is not optional practice, it is the
prerequisite.

Your job is to build the two ends of that pipe, then break them on purpose.

---

## What you are given

`starter/src/producer.ts` — an HTTP server. `POST /publish` takes a JSON
body, hands it to RabbitMQ, and returns before you have any real reason to
trust the message went anywhere — unless you make it wait for proof.

`starter/src/consumer.ts` — consumes from the same queue and appends one
JSON line per message to `data/received.jsonl`.

`docker-compose.yml` — RabbitMQ (`rabbitmq:3.13-management`), the producer,
and the consumer, wired together. `docker compose up -d --wait` brings up
all three; the producer and consumer stay up and reconnect on their own even
before you have implemented anything — the assignment is designed to fail at
`npm test`, with a readable message, not at `docker compose up --wait`, with
a timeout and no explanation.

Both files have the HTTP server, the reconnect logic and the consume-loop
wiring already written. What is missing is four small functions:

| File | Function | What it is missing |
|---|---|---|
| `producer.ts` | `connectProducerChannel` | the durable queue |
| `producer.ts` | `publishMessage` | publisher confirms, and the persistent-delivery flag that makes them mean something |
| `consumer.ts` | `connectConsumerChannel` | the same durable queue, declared on the consuming side |
| `consumer.ts` | `handleMessage` | manual ack, and the correlationId reaching the log line |

Read the comment above each one before you write it — it says exactly which
amqplib call is missing and why the obvious shortcut is the wrong one.

---

## Ports — this assignment's own range

RabbitMQ AMQP is on host port **5673** (not 5672), the management UI is on
**15673** (not 15672), and the producer's HTTP API is on **3001** (not
3000). Every container is named `pa2-*` (`pa2-rabbitmq`, `pa2-producer`,
`pa2-consumer`).

This is not a one-off for this assignment: **every PA in this repository
gets its own port range and its own container name prefix**, specifically so
you can have several assignments' stacks running side by side without
tearing one down to test another. If a `docker compose up` ever fails to
bind a port, the fix is never "stop the other stack" — it means two
containers from the *same* assignment collided, which is worth investigating
on its own.

---

## The four things you are implementing

**A durable queue.** `channel.assertQueue(name, { durable: true })`. Without
it, the queue itself — not just its contents — does not survive
`docker restart pa2-rabbitmq`. This is the cheapest of the four to get right
and the easiest to forget, because a non-durable queue works identically to
a durable one right up until the moment you restart the broker.

**Publisher confirms.** A `ConfirmChannel`, and a `POST /publish` that does
not return `202` until the broker has actually confirmed the message. The
naive version — call `channel.publish()`, respond `202` — looks correct.
Every one of your other three tests will pass with it. Demonstration (c)
below is the one that catches it.

**Manual ack.** The consumer acks a message only after it has been durably
appended to `received.jsonl`, never before. Ack first and you can lose a
message to a consumer crash between the ack and the write. Never ack and a
transient error retries forever. The difference is one line moved above or
below a function call — know which side of `handleMessage` yours is on.

**correlationId propagation.** The HTTP request may carry `X-Correlation-Id`;
if it does not, the producer generates one. Either way it has to reach the
consumer's log line and its line in `received.jsonl` — through the AMQP
message's `correlationId` property, not the message body. Read the comment
in `publishMessage` and `handleMessage`: propagation is not "the string
shows up somewhere," it is a specific value at a specific hop.

---

## The three demonstrations

Each one is a public test in `tests/public/`, and each one is worth actually
watching happen in `docker compose logs -f`, not just making green.

**(a) A published message survives `docker restart pa2-rabbitmq`.**
`02-broker-restart-survives.test.ts` stops the consumer, publishes a
confirmed message so it sits in the queue untouched, restarts the broker,
and checks the message is still there before the consumer is even started
back up.

**(b) With the consumer stopped, messages accumulate and are not lost.**
`03-consumer-stopped-accumulates.test.ts` stops the consumer, publishes a
batch, watches the queue depth rise by exactly that many (via the
management API on port 15673), then restarts the consumer and checks the
queue drains to zero loss.

**(c) A message published without publisher confirms can be lost.**
`04-publisher-confirms-prevents-loss.test.ts` publishes a batch with the
header `X-Publish-Mode: fire-and-forget` — no confirms, no persistent
delivery — and restarts the broker. Some or all of that batch is gone. Then
it publishes the same batch the default way — confirmed — and restarts the
broker again. Nothing is gone. Read the comment at the top of that test file
for exactly how "gone" is made deterministic rather than a coin flip: it
does not depend on winning a timing race against the broker, it depends on
RabbitMQ's own unconditional rule about non-persistent messages and a
restart.

`X-Publish-Mode: fire-and-forget` exists only for this demonstration. A real
producer would not expose a way to turn confirms off — say so, and say why,
in your ADR.

---

## Running it

```bash
cd pa2
docker compose up -d --wait
cd starter
npm ci
npm test              # the public tests, against the containers you just started
npm run typecheck     # tsc --noEmit over your code
cd ..
docker compose down -v
```

Windows: everything above is `docker compose` and `npm`, no `make` needed.

The tests talk to real containers — they restart the broker, stop and start
the consumer, and read `data/received.jsonl` off the bind mount. Run them
with the stack up, and expect the restart-related tests to take real wall
-clock time (tens of seconds each): RabbitMQ genuinely takes a while to
become healthy again, and the tests wait for that for real rather than
mocking it away.

`docker compose down -v` removes the RabbitMQ data volume along with the
containers. Do this between full runs if you want a truly clean broker; a
plain `docker compose down` (no `-v`) keeps the queue's contents around,
which is a different, also-useful thing to test with.

---

## Where to start

1. **`connectProducerChannel` and `connectConsumerChannel` first.** Until
   both sides declare the same durable queue, nothing else has anywhere to
   go. `docker compose logs -f producer consumer` will show the TODO errors
   as they retry every two seconds — that retry loop is provided, you are
   not meant to touch it.
2. **`publishMessage`, confirmed mode only.** Get `00-publish-contract.test.ts`
   and `01-consumer-delivery.test.ts` green before touching the
   `fire-and-forget` branch.
3. **`handleMessage`.** Append then ack, in that order. Watch
   `data/received.jsonl` grow with `Get-Content -Wait` (PowerShell) or
   `tail -f` as you publish.
4. **`publishMessage`, fire-and-forget branch.** This only needs to exist for
   demonstration (c) — a couple of lines, no confirm callback, no
   `persistent: true`.
5. **The demonstrations.** Run `02`, `03`, `04` one at a time the first time,
   watching the logs. They are slow on purpose.

If you are stuck for more than thirty minutes, ask — see
[CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Rules

`amqplib` is the one runtime dependency this assignment needs, and it is
already in `starter/package.json`. You do not need another message-queue
client, a promise-retry library, or a framework to serve one HTTP route.

You may of course read documentation, and you may use AI tools — but see
[SYLLABUS.md](../SYLLABUS.md) §12: you have to be able to defend every line
in November, on your own code, with a fault planted in it. "Why does
`fire-and-forget` also skip `persistent: true`, and not just the confirm
callback?" is exactly the kind of question that gets asked.

---

## What is tested

Public tests (`tests/public/`, run them yourself) check that:

- `POST /publish` returns `202` with a `correlationId` — generated if you
  did not supply one, echoed back if you did
- a malformed `X-Correlation-Id` or an unparseable body is rejected with
  `400`, not silently accepted
- a published message reaches `received.jsonl` with the same `correlationId`
- `received.jsonl` is valid JSON Lines — one parseable object per line
- demonstration (a): a message survives `docker restart pa2-rabbitmq`
- demonstration (b): with the consumer stopped, the management API shows
  queue depth rising by the batch size, then draining to zero loss
- demonstration (c): `fire-and-forget` loses messages across a broker
  restart; the default confirmed mode does not
- `docs/adr-001.md` exists with its four sections

**Hidden tests** also run at grading time. They are never published, they
test the same requirements as the public ones, and they exist so that code
written to satisfy the visible tests specifically does not score well.

---

## Your ADR

`docs/adr-001.md`, four sections, one page. **It is 30% of this
assignment's mark.** The template is already in that file, with prompts
under each heading specific to the four decisions above — fill it in after
the demonstrations pass, while watching a message actually disappear (or
not) is still fresh.

---

## Submitting

Your work goes in **your** repository, not this one:

```text
eai-2026-<surname>/
  pa2/
    starter/         your implementation
    tests/public/    unchanged, as given
    docker-compose.yml
    docs/adr-001.md
```

Then submit your repository URL through the portal at
**<https://evaluentis.leitass.eu>**. Never by email.

See [how an assignment works](../README.md#how-an-assignment-works) in the
root README for the late penalty and the progression gate. The graded commit
is the SHA at `HEAD` **when you submit** — later pushes are not seen. Run
`npm test` against a fresh `docker compose up -d --wait` one more time before
you do.

---

## Out of scope

Exchanges beyond the single direct, durable queue used here; dead-letter
queues; routing. Those belong to PA3 and PA5 — this week is deliberately
narrow so the four decisions above are the whole story.

---

## Common ways to lose marks

| | |
|---|---|
| `channel.publish()` then `202` immediately | This is the bug demonstration (c) exists to catch. It passes every other test |
| A queue declared without `durable: true` | Works fine until the first `docker restart` — which is the only time anyone checks |
| Acking before the write to `received.jsonl` | A crash between the two loses the message with the broker convinced it was delivered |
| Trusting `X-Correlation-Id` without validating it | Whatever a client sends ends up verbatim in a log line and a JSONL file |
| Leaving RabbitMQ on `guest`/`guest` | Works over AMQP, then quietly fails management-API calls from outside the container — guest logins are loopback-only by default, and a host-to-container port mapping does not look like loopback from the inside |
| Using 5672/15672/3000 | Collides with whichever other PA's stack is running. Use exactly 5673/15673/3001 |
| An ADR that restates this README | 30% of the mark, and I have read this README |
