# PA6 — Contract-first API and a hand-rolled saga

| | |
|---|---|
| **Session** | S6 — APIs and contracts · 2026-10-21, C211 |
| **Scaffold language** | TypeScript |
| **Published** | with S6 on 2026-10-21 |
| **Deadline** | **2026-11-02, 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-11-09, 20:00** — miss it and the capstone is not graded |
| **Weight** | one seventh of the homework half — about 7.1% of the final grade |
| **Mark** | 70% automated tests, 30% manual (ADR quality, self-assessment honesty) |
| **ADR** | `docs/adr-005.md` |

---

## 1) Objective

Two things, in this order, and the order is the point:

1. **Write the contract before you write the code.** `openapi.yaml` describes
   `POST /checkout` — what it accepts, what it returns, and what its errors
   look like — before a single line of the orchestrator is filled in. A
   containerised linter (Spectral) checks that the contract is real: named
   consistently, documented, and honest about its error shapes and its
   bounds. You cannot skip this by writing vague YAML — the ruleset checks
   for exactly the kind of contract that is easy to fake.
2. **Then implement the saga.** The orchestrator composes four downstream
   services — payment, inventory, shipping, notification — into one business
   transaction: strict sequencing, timeout control, idempotency, and
   compensation (rollback) when something downstream fails partway through.

`POST /checkout` accepts the **canonical order** — the shape your PA4
translators produce and your PA5 services publish, defined once in
`canonical/order.schema.json` at the root of your repository. PA6 adds no
new order format.

This is the same orchestration exercise that has run in this course before,
ported from plain JavaScript to TypeScript, with the contract-first stage
added in front of it. If you have seen a "saga pattern" diagram in a lecture,
this is the assignment where you find out what the diagram leaves out.

---

## 2) What is provided

```
pa6/
  openapi.yaml            worked example contract for POST /checkout — READ FIRST, see §3
  .spectral.yaml          the lint ruleset that grades your contract
  examples/
    openapi.bad.yaml      deliberately broken spec — proves the ruleset rejects one
  mock-services/          payment, inventory, shipping, notification (TypeScript) — do not modify
  orchestrator/           the scaffold you complete — TODOs are in src/server.ts
  tests/public/           tests you can run yourself, as often as you like
    fixtures/order.json   the canonical order the tests send
  grading/schema/         JSON Schemas the tests validate your responses and stores against
  docker-compose.yml      the five services, plus the spectral linter
  docs/adr-005.md         your architecture decision record (fill it in)
```

The orchestrator also reads `../canonical/order.schema.json`, which
`docker-compose.yml` mounts from the root of your repository. You copied
`canonical/` there at PA4. If it is not there, copy it now — see
[starting an assignment](../README.md#starting-an-assignment) in the root
README.

Hidden tests are also run at grading time. They are never published, they
test the same requirements as the public ones, and they exist so that code
written to pass the visible tests specifically does not score well.

---

## 3) Stage 1 — the contract (`openapi.yaml`)

`openapi.yaml` in this folder is a **worked example**, not the answer key.
It documents one reasonable version of the `POST /checkout` contract —
request shape, all five response codes, error schemas, bounded arrays — so
you have something concrete to read before writing your own. Read it, then
**replace it with your own contract** for the orchestrator you are about to
build. Copying it verbatim and changing nothing will not teach you anything
the lint step is checking for, and a manual reviewer will notice.

**The request body is the canonical order**, so your contract has to
describe it. You cannot `$ref` `../canonical/order.schema.json` directly:
that schema does not bound its `items` array, and lint rule 4 below rejects
an unbounded array wherever it finds one. Restate the canonical order in
your contract, as the worked example does, and choose the bound yourself.
Then **enforce it in your code**: the given validation checks the body
against the canonical schema, which knows nothing about your bound. A
contract that promises at most 50 items while the code accepts 500 is the
mismatch the manual review looks for.

Lint your contract exactly as it is graded, from the `pa6/` folder. The
command is the same in Bash, Git Bash and PowerShell:

```bash
docker compose run --rm spectral
```

`docker-compose.yml` defines `spectral` as a tool, not a service:
`docker compose up` never starts it, and this command runs Spectral 6.16.3
once over `openapi.yaml` with `.spectral.yaml`. It must exit `0`. Warnings
are allowed. The worked example has three: no `contact`, and no `tags` on
its two operations. Errors are not allowed.

`.spectral.yaml` extends the standard OpenAPI ruleset and adds four things
this assignment specifically cares about:

1. **Naming conventions** — `operationId` and JSON property names are
   camelCase, path segments are kebab-case.
2. **Required descriptions** — `info`, every operation, every parameter,
   every request body and every response must say what it does. A contract
   nobody can read from is not a contract.
3. **Error-response schemas present** — every 4xx/5xx response must
   reference a JSON schema, not just a prose description. If you cannot say
   what shape an error takes, callers cannot handle it.
4. **No unbounded arrays** — every array schema declares `maxItems`. An
   array with no upper bound is a pagination or DoS problem waiting to
   happen; deciding the bound is part of designing the contract.

`examples/openapi.bad.yaml` is not something to fix or learn from stylistically
— it exists so you (and I) can prove the ruleset actually rejects a spec that
breaks all four rules. Lint it and see it fail:

```bash
docker compose run --rm spectral lint examples/openapi.bad.yaml --ruleset .spectral.yaml
```

If that command exits `0`, something is wrong with your ruleset changes, not
with the example.

### Commit the contract first — the order is graded

Commit your `openapi.yaml`, linting clean, **in an earlier commit than your
first change to `orchestrator/src/`.** I check the history. A contract that
first appears in the same commit as the implementation, or after it, counts
as written after the code, because a history cannot show otherwise. You
may revise the contract later — contracts evolve, and a later commit that
changes both is fine — but the first version comes first.

The manual review also checks whether the implementation actually matches
what you wrote in `openapi.yaml`. A contract that describes one thing while
the code does another is worse than no contract.

---

## 4) Stage 2 — the saga (`orchestrator/src/server.ts`)

### Prerequisites

- Docker Desktop (or Rancher Desktop) with Compose support
- Node.js 20+ — to run the tests
- Available ports: `3000`, `4001`, `4002`, `4003`, `4004`

### Run it

From the `pa6/` folder:

```bash
docker compose up -d --build --wait
npm --prefix tests/public ci    # once, before your first test run
npm test
```

**Rebuild after every edit.** Your code is copied into the image when it is
built, so a running container keeps the old version until you run
`docker compose up -d --build --wait` again. The `--build` is not optional.

Type-check your orchestrator inside its container, after a rebuild:

```bash
docker compose exec orchestrator npx tsc --noEmit
```

If `up` reports `container pa6-orchestrator exited (1)`, read why:
`docker compose logs orchestrator`. The usual cause is `canonical/` missing
from your repository root.

Health checks, if you want to see the stack up by hand (in PowerShell, type
`curl.exe`, not `curl`):

```bash
curl http://localhost:3000/health
curl http://localhost:4001/health
curl http://localhost:4002/health
curl http://localhost:4003/health
curl http://localhost:4004/health
```

One checkout by hand, sending the tests' own canonical order:

```bash
curl -X POST http://localhost:3000/checkout -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" --data @tests/public/fixtures/order.json
```

In PowerShell, use `curl.exe` and quote the file argument:
`--data "@tests/public/fixtures/order.json"`. Send the same command again
and you should get the same response back without the saga running twice.
Change the key for a new saga. What each mock was called with is at
`http://localhost:4001/admin/logs` (and `4002`–`4004`).

Stop it, and start clean:

```bash
docker compose down                      # stops; the stores in orchestrator/data/ stay
rm orchestrator/data/*.json              # Bash: delete the stores
Remove-Item orchestrator/data/*.json     # PowerShell: delete the stores
```

The orchestrator creates empty stores again the next time it starts. The
tests do not need a clean start: every test run uses fresh order ids and
fresh idempotency keys.

### Required orchestrator endpoints

1. `GET /health` → `200 { "status": "ok" }`
2. `POST /checkout` (graded)
3. Optional `GET /debug/trace/:orderId` — see §6

### What `POST /checkout` accepts

- The header `Idempotency-Key` — mandatory.
- A body that is a canonical order, valid against
  `canonical/order.schema.json`.

Both checks are already in the scaffold, and a request that fails either
gets `400` with `code: "validation_error"`. The scaffold checks the
canonical schema only. Any stricter bound your contract adds is yours to
enforce (§3).

### The saga, in order

| Step | Call | Body | Compensation |
|---|---|---|---|
| 1. payment | `POST {PAYMENT_URL}/payment/authorize` | `{ orderId, amount }` | `POST {PAYMENT_URL}/payment/refund` with `{ orderId }` |
| 2. inventory | `POST {INVENTORY_URL}/inventory/reserve` | `{ orderId, items }` | `POST {INVENTORY_URL}/inventory/release` with `{ orderId }` |
| 3. shipping | `POST {SHIPPING_URL}/shipping/create` | `{ orderId }` | none |
| 4. notification | `POST {NOTIFICATION_URL}/notification/send` | `{ orderId, recipient }` | none |

Each step must run only after the previous one has succeeded — no
parallelism, and the tests check for it by timestamp, not just by response
content. If a step fails or times out, compensate the steps that already
completed, **in reverse order**. Only payment and inventory have a
compensating action on the mock services — shipping and notification do not
expose one, so a shipping or notification failure still rolls back
inventory and payment, in that order.

### Two values the canonical order does not carry

The canonical order has no amount and no recipient. The orchestrator
derives both:

- **`amount`** is the sum of `unitPrice × quantity` over `items`, sent to
  payment as a **decimal string with two fraction digits**. For the tests'
  order, 2 × `"22.50"` + 1 × `"18.90"` = `"63.90"`. This is the canonical
  model's money rule, carried one step further. Add up whole cents as
  integers and format once at the end. Floats are a trap here:
  `parseFloat("18.90") * 100` is `1889.9999999999998`, and the number
  `63.9` is not the string `"63.90"`. The payment mock answers `400` to
  anything that is not a two-digit decimal string.
- **`recipient`** is `customer.email`.

### The trace

The response carries a `trace`: one entry for every call the saga made, in
the order it made them, compensations included.

```json
{
  "orderId": "WEB-2026-061",
  "status": "completed",
  "trace": [
    {
      "step": "payment",
      "status": "success",
      "startedAt": "2026-10-21T10:00:00.000Z",
      "finishedAt": "2026-10-21T10:00:00.120Z",
      "durationMs": 120
    }
  ]
}
```

| Field | Values |
|---|---|
| `step` | `payment`, `inventory`, `shipping`, `notification`, and for compensations `inventory_release`, `payment_refund` |
| `status` | `success`, `failed`, or `timeout` |
| `startedAt`, `finishedAt` | ISO-8601 timestamps |
| `durationMs` | a whole number of milliseconds |

### Outcomes

Each outcome has one HTTP status, one saga `status` and, when it is not a
success, one `code`:

| What happened | HTTP | `status` | `code` |
|---|---|---|---|
| All four steps succeeded | `200` | `completed` | — |
| Payment failed | `422` | `failed` | the mock's code, e.g. `payment_declined` |
| Payment timed out | `504` | `failed` | `timeout` |
| A later step failed, and compensation succeeded | `422` | `compensated` | the failing mock's code |
| A later step timed out, and compensation succeeded | `504` | `compensated` | `timeout` |
| A compensation call failed | `422` | `failed` | `compensation_failed` |

A call counts as timed out when it has not answered within
`REQUEST_TIMEOUT_MS` (2500 ms in `docker-compose.yml`).

### Idempotency rules

1. Same key + same payload: replay the prior result exactly (same HTTP
   status, same body). The saga does not run again, so payment is not
   called a second time.
2. Same key + different payload: `409` + `idempotency_payload_mismatch`.
3. Same key while the first request is still mid-flight: `409` +
   `idempotency_conflict`.
4. Records must survive an orchestrator container restart.

The scaffold already records every key and detects rule 2. Rules 1 and 3
are yours.

Persistence files (inside the container, and bind-mounted to
`orchestrator/data/` on your host so you can inspect them):

- `/data/idempotency-store.json`
- `/data/saga-store.json`

### Downstream URLs and environment

The orchestrator must use environment variables, never hardcoded URLs:

- `ORCHESTRATOR_PORT`
- `PAYMENT_URL`, `INVENTORY_URL`, `SHIPPING_URL`, `NOTIFICATION_URL`
- `REQUEST_TIMEOUT_MS`

`docker-compose.yml` already wires these up. Hardcoding downstream URLs is
penalized even if the tests happen to pass anyway.

---

## 5) What is tested

Public tests (`tests/public/`, run them yourself with `npm test`). Each one
sets the mock services' behaviour it needs, and reads back what they were
called with:

1. Services start and health checks pass
2. Happy path: `200` + `completed`, the four steps in order, payment
   received the derived amount (`"63.90"`) and notification the customer's
   email
3. Payment failure: `422` + `failed`, and nothing downstream is called
4. Inventory failure: `422` + `compensated`, payment refunded
5. Shipping timeout: `504` + `timeout`, inventory released and then payment
   refunded
6. A failed refund: `422` + `compensation_failed`
7. Idempotent replay: identical response, payment called once
8. Idempotency mismatch: `409` + `idempotency_payload_mismatch`
9. In-flight conflict: `409` + `idempotency_conflict` while the first
   request is still running
10. Both stores record the finished saga and validate against
    `grading/schema/`
11. A replay after `docker restart pa6-orchestrator` returns the same result
12. `docs/adr-005.md` has the four required headings

The suite takes about 15 seconds, and test 11 restarts your orchestrator
container. On the untouched scaffold, tests 1 and 12 pass and the other ten
fail, each printing the response the orchestrator gave.

**Hidden tests** also run at grading time — the same requirements, different
cases, plus explicit anti-gaming checks: strict step ordering verified by
timestamp (not just by array position), metamorphic payload variations that
must not change the outcome, and randomised prices and quantities, checked
against the exact amount payment received — which a fingerprinted
(hardcoded per-test) implementation would fail. If your implementation is
correct rather than tuned to the public fixture, you will not notice these
exist.

---

## 6) Optional debug UI

An ungraded debug shell is available at `http://localhost:3000/debug.html`
once the stack is up. It reads `GET /debug/trace/:orderId`. You may extend it
for your own diagnostics; nothing about it is graded.

---

## 7) Your ADR

`docs/adr-005.md` is the template. Keep its four `##` headings exactly as
they are. A public test checks that they are there, and the manual 30% of
this assignment is the quality of what you write under them. The comments
inside the template ask the question it is really about. Write it after the
code, while the annoyance is fresh.

---

## 8) Submission checklist

- [ ] `openapi.yaml` replaced with your own contract for `POST /checkout`
- [ ] `docker compose run --rm spectral` exits `0` on your contract
- [ ] The contract is committed before your first change to `orchestrator/src/`
- [ ] `POST /checkout` fully implemented with strict sequencing
- [ ] Amount derived as a decimal string, recipient from `customer.email`
- [ ] Compensation implemented, in reverse order, for every failure path that has one
- [ ] Timeout handling implemented (`REQUEST_TIMEOUT_MS`, mapped to `504` + `timeout`)
- [ ] Idempotency contract fully implemented (replay, mismatch, in-flight conflict)
- [ ] File persistence survives a container restart
- [ ] Trace order and schema are correct
- [ ] `docker compose exec orchestrator npx tsc --noEmit` is clean
- [ ] `npm test` passes in full
- [ ] `docs/adr-005.md` completed
- [ ] AI-usage note added (if applicable) with what you changed/understood

---

## Submitting

Your work goes in **your** repository, not this one:

```text
eai-2026-<surname>/
  canonical/                 from PA4, unchanged
  pa6/
    openapi.yaml             your contract
    orchestrator/            your implementation
    mock-services/           as given — PA7 builds its stack from this folder
    tests/public/            unchanged, as given
    grading/schema/          unchanged, as given
    examples/  .spectral.yaml  docker-compose.yml  package.json  .gitignore
    docs/adr-005.md
```

Commit the whole `pa6/` folder, `mock-services/` included: PA7 starts its
stack from your `pa6/mock-services/`. Then submit your repository URL
through the portal at **<https://evaluentis.leitass.eu>**. Never by email.

At grading, `canonical/`, `mock-services/`, `tests/public/`,
`grading/schema/` and `.spectral.yaml` are replaced with the official
copies, so a change to any of them does not change your mark.

See [how an assignment works](../README.md#how-an-assignment-works) in the
root README for the late penalty and the progression gate. The graded
commit is the SHA at `HEAD` **when you submit** — later pushes are not
seen. Run `docker compose up -d --build --wait && npm test` one more time
before you do. Read [`../CONTRIBUTING.md`](../CONTRIBUTING.md) before
asking a question — it will usually be faster.

---

## Common ways to lose marks

| | |
|---|---|
| Copying `openapi.yaml` verbatim | It is a worked example, not the answer key — the manual review checks it against your actual implementation |
| Committing the contract together with, or after, the implementation | The order is graded from the history, and a history cannot show a contract that came first unless it did |
| `$ref`-ing `canonical/order.schema.json` from your contract | Its `items` has no `maxItems`, so the lint fails. Restate the order and bound it |
| A bound in the contract that the code does not enforce | The given validation checks the canonical schema only. Your contract's bound is yours to enforce |
| An unbounded array "because the mock never returns many items" | The rule is about the contract, not today's test data. Pick a real bound and justify it if asked |
| Sending `amount` as a number, or as `"63.9"` | The payment mock answers `400` and every saga fails at step one |
| `Math.floor(parseFloat(unitPrice) * 100)` | `18.90` becomes `1889` cents, and payment is charged `"63.89"` |
| Calling downstream services in parallel to "save time" | The hidden tests detect this by timestamp, not by trace order alone |
| Compensating shipping or notification | Neither mock exposes a compensating endpoint. Compensate inventory and payment only, in reverse order |
| Keeping idempotency records only in memory | Test 11 restarts the orchestrator and replays; the record must come back from `/data` |
| Hardcoding `http://payment:4001` etc. | Breaks outside Docker Compose, and is penalized even when it happens to pass |
| Treating `422` and `504` as interchangeable | `504` is reserved for the timeout-triggered path specifically |
| An ADR that restates this README | 30% of the mark, and I have read this README |
