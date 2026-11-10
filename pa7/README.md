# PA7 — Port the saga to Temporal

| | |
|---|---|
| **Session** | S7 — The complete business process · 2026-10-28, C113 |
| **Scaffold language** | TypeScript |
| **Published** | with S7 on 2026-10-28 |
| **Deadline** | **2026-11-09, 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-11-16, 20:00** — miss it and the capstone is not graded |
| **Weight** | one seventh of the homework half — about 7.1% of the final grade |
| **Mark** | 70% automated tests, 30% manual (ADR quality, self-assessment honesty) |
| **ADR** | `docs/adr-006.md` |

---

## 1) Objective

You built the checkout saga by hand in PA6. Now you port it to
[Temporal](https://temporal.io), a durable execution engine, and keep its
behaviour exactly as it was: the same `POST /checkout`, the same four
steps, the same compensation in reverse order, the same responses.

What changes is who carries the saga's state. In PA6 your orchestrator did:
the in-progress record, the timeout around every call, and the knowledge of
which steps had completed. Kill it mid-saga and that knowledge is gone. In
PA7 Temporal records every step's result in the workflow's history. Kill
the worker mid-saga, start it again, and the workflow carries on from the
step it was on — without charging the customer twice. That is the graded
demonstration, and a public test does it.

The lesson is what disappears from your code. The ADR asks you to name it.

---

## 2) What is provided

```
pa7/
  docker-compose.yml         seven containers, see below
  api/                       GIVEN, complete — PA6's POST /checkout in front of Temporal
  worker/
    src/worker.ts            GIVEN — connects to Temporal and runs your code
    src/types.ts             GIVEN — CheckoutResult, TraceItem, the task queue name
    src/canonical-order.ts   GIVEN — the canonical order as a TypeScript type
    src/activities/index.ts  YOURS — the six HTTP calls
    src/workflows/checkout.ts  YOURS — the saga
  tests/                     the public tests (vitest), run them as often as you like
    public/fixtures/order.json  the canonical order the tests send
  grading/schema/            PA6's JSON Schemas, unchanged
  docs/adr-006.md            your architecture decision record (fill it in)
```

You write two files. Everything else is given.

The seven containers:

| Container | Port | What it is |
|---|---|---|
| `pa7-temporal` | 7233, **8233** | The Temporal dev server. **Its Web UI is at <http://localhost:8233>** |
| `pa7-api` | 3000 | Given. Validates the request, starts your workflow, waits for its result |
| `pa7-worker` | — | Yours. Runs your workflow and activities |
| `pa7-payment`, `pa7-inventory`, `pa7-shipping`, `pa7-notification` | 4001–4004 | The PA6 mocks, built from **your** `../pa6/mock-services` |

Hidden tests are also run at grading time. They are never published, they
test the same requirements as the public ones, and they exist so that code
written to pass the visible tests specifically does not score well.

---

## 3) Before you start

PA7 builds on two folders that must already be in your repository, next to
`pa7/`:

- **`pa6/`, the whole folder, `mock-services/` included.** PA7 has no mocks
  of its own. It builds them from yours. Public test 1 checks for them and
  names the missing path.
- **`canonical/`**, copied at PA4. The api validates every request against
  `canonical/order.schema.json`, exactly as PA6 did.

Copy `pa7/` into your repository the usual way (see
[starting an assignment](../README.md#starting-an-assignment)).

The mocks keep PA6's ports, so **stop your PA6 stack first**: run
`docker compose down` in `pa6/`.

---

## 4) What you write

### The activities (`worker/src/activities/index.ts`)

An activity is ordinary Node code: it may do I/O, and it may fail. Each of
the six makes one HTTP call, the same calls your PA6 orchestrator made:

| Activity | Call | Body |
|---|---|---|
| `authorizePayment(orderId, amount)` | `POST {PAYMENT_URL}/payment/authorize` | `{ orderId, amount }` |
| `reserveInventory(orderId, items)` | `POST {INVENTORY_URL}/inventory/reserve` | `{ orderId, items }` |
| `createShipment(orderId)` | `POST {SHIPPING_URL}/shipping/create` | `{ orderId }` |
| `sendNotification(orderId, recipient)` | `POST {NOTIFICATION_URL}/notification/send` | `{ orderId, recipient }` |
| `refundPayment(orderId)` | `POST {PAYMENT_URL}/payment/refund` | `{ orderId }` |
| `releaseInventory(orderId)` | `POST {INVENTORY_URL}/inventory/release` | `{ orderId }` |

The URLs come from the environment; the scaffold already reads them. The
signatures are fixed, so keep them.

What an activity adds is a decision your PA6 orchestrator never had to make:
**when a call fails, may Temporal try it again?** That is S5's permanent or
temporary question, and the answer goes in the error you throw:

| The mock… | It means | Throw |
|---|---|---|
| answers `2xx` | success | nothing — return |
| answers `4xx` (`payment_declined`, `inventory_unavailable`, …) | a business refusal. It will refuse again | `ApplicationFailure.nonRetryable(message, code)`, with the mock's `code` from the response body |
| answers `5xx`, or does not answer at all | temporary | `ApplicationFailure.retryable(message, code)`, or any ordinary `Error` |
| takes too long | temporary | nothing — Temporal fails the attempt itself when `startToCloseTimeout` runs out |

`ApplicationFailure` comes from `@temporalio/activity`.

### The workflow (`worker/src/workflows/checkout.ts`)

The workflow is your PA6 saga, ported:

1. `authorizePayment(orderId, amount)` — the amount summed from the items
   exactly as in PA6: whole cents, a two-digit decimal string (`"63.90"`)
2. `reserveInventory(orderId, items)`
3. `createShipment(orderId)`
4. `sendNotification(orderId, customer.email)`

Strictly in sequence. If a step fails for good, compensate the completed
steps in reverse order — `releaseInventory`, then `refundPayment`. Shipping
and notification still have nothing to undo.

**The retry policy** goes on `proxyActivities`. The scaffold sets the
timeout; the rest is yours, with exactly these values:

| Setting | Value |
|---|---|
| `startToCloseTimeout` | `"2500 ms"` — PA6's per-call budget (given) |
| `retry.maximumAttempts` | `3` |
| `retry.initialInterval` | `"200 ms"` |
| `retry.backoffCoefficient` | `2` |

Without a retry policy Temporal retries a failing activity forever. With
this one, a call that keeps timing out is tried three times before the
workflow sees it fail: 2.5 s, a 0.2 s pause, 2.5 s, a 0.4 s pause and
2.5 s, about 8 seconds in all.

**How a failure reaches you.** An activity that has failed for good — a
non-retryable error, or its last attempt — throws an `ActivityFailure` in
the workflow. Its `cause` says why: a `TimeoutFailure` if the attempts
timed out, an `ApplicationFailure` whose `type` is the code your activity
threw otherwise. All three come from `@temporalio/workflow`.

**Return a result for every outcome. Do not throw.** The workflow returns a
`CheckoutResult` (in `types.ts`) — success and failure alike — and the api
turns it into PA6's response:

| What happened | `status` | `code` | HTTP |
|---|---|---|---|
| All four steps succeeded | `completed` | — | `200` |
| Payment failed | `failed` | the mock's code, e.g. `payment_declined` | `422` |
| Payment timed out | `failed` | `timeout` | `504` |
| A later step failed, and compensation succeeded | `compensated` | the failing mock's code | `422` |
| A later step timed out, and compensation succeeded | `compensated` | `timeout` | `504` |
| A compensation failed | `failed` | `compensation_failed` | `422` |

**The trace** is PA6's: one entry per step, compensations included, with
`step` (`payment`, `inventory`, `shipping`, `notification`,
`inventory_release`, `payment_refund`), `status` (`success`, `failed`,
`timeout`), `startedAt`, `finishedAt` and `durationMs`. One entry per step,
not per attempt.

### The rules of workflow code

Workflow code runs in Temporal's deterministic sandbox. When a worker has
to rebuild a workflow — after a crash, or simply to continue it — it runs
your workflow function again from the top and feeds it the recorded results
instead of calling anything. That only works if the code does the same
thing every time. So:

- **No I/O in the workflow.** No `fetch`, no `axios`, no `fs`, no
  `process.env`. Every call to the outside world is an activity.
- **Import only types from `../activities`**, never the functions. The
  scaffold's `proxyActivities` gives you callable stand-ins.
- **`new Date()` is safe.** Inside a workflow it returns the workflow's
  own time, the same on every replay. Use it for the trace.

Break the first rule and the worker still starts: the workflow fails each
time it runs, Temporal retries it, and it never finishes (see §8).

---

## 5) The api, which you do not write

Read `api/src/server.ts` anyway. It keeps PA6's contract, and it is where
idempotency now lives:

- It starts your workflow with **`workflowId` = the `Idempotency-Key`**,
  and stores a hash of the request body in the workflow's memo.
- Temporal refuses a second workflow with the same id. On that refusal the
  api looks at the existing one: different hash →
  `409 idempotency_payload_mismatch`; still running →
  `409 idempotency_conflict`; finished → its stored result, again.
- It writes PA6's two store files to `api/data/` as an **audit mirror**.
  Temporal is the source of truth now; the files are a read model.

Your PA6 idempotency code has no counterpart in your PA7 code. That is one
of the things the engine took over.

---

## 6) Running it

From the `pa7/` folder:

```bash
docker compose up -d --build --wait
npm --prefix tests ci    # once, before your first test run
npm --prefix tests test
```

The first `up` downloads Temporal and builds seven images; allow a couple
of minutes.

**Rebuild after every edit.** Your code is copied into the worker image
when it is built. `docker compose up -d --build --wait` again, every time.

Type-check your worker inside its container, after a rebuild:

```bash
docker compose exec worker npx tsc --noEmit
```

**Open the Temporal UI: <http://localhost:8233>.** Every checkout is a
workflow there, named by its Idempotency-Key. Its history shows every
activity, every attempt, every failure and every result. It is the first
place to look when something is wrong, and it is the part of PA6 you never
had.

One checkout by hand, sending the tests' own canonical order:

```bash
curl -X POST http://localhost:3000/checkout -H "Content-Type: application/json" -H "Idempotency-Key: demo-1" --data @tests/public/fixtures/order.json
```

In PowerShell, use `curl.exe` and quote the file argument:
`--data "@tests/public/fixtures/order.json"`. Then find `demo-1` in the UI.

Stop it, and start clean:

```bash
docker compose down        # stops; Temporal's history and api/data/ stay
docker compose down -v     # also deletes Temporal's history
rm api/data/*.json               # Bash: delete the audit mirror
Remove-Item api/data/*.json      # PowerShell: delete the audit mirror
```

The tests need no clean start: every run uses fresh order ids and keys.

---

## 7) Kill the worker yourself

Do this once by hand before you run test 8, and watch it in the UI. Make
shipping slow, start a checkout, and kill the worker while shipping is in
flight:

```bash
curl -X POST http://localhost:4003/admin/config -H "Content-Type: application/json" -d '{"shippingDelayMs":2000}'
curl -X POST http://localhost:3000/checkout -H "Content-Type: application/json" -H "Idempotency-Key: crash-1" --data @tests/public/fixtures/order.json
```

In PowerShell, the first line is
`Invoke-RestMethod -Method Post -Uri http://localhost:4003/admin/config -ContentType application/json -Body '{"shippingDelayMs":2000}'`
(PowerShell 5.1 strips the quotes inside JSON it hands to `curl.exe`), and
the second is the `curl.exe` form from §6.

In a second terminal, within a second of starting the checkout:

```bash
docker kill pa7-worker
docker start pa7-worker
```

The first terminal gets `200` and `completed` after about 20 seconds. Now
look at `http://localhost:4001/admin/logs` and `4003`: payment was
authorized once, and shipping was called **twice**. The call that was in
flight when the worker died reached the mock. Temporal cannot know that, so
when the attempt timed out it ran the activity again. **Activities run at
least once, not exactly once.** Your ADR says what that would mean if the
step that ran twice were `authorizePayment`.

Then do the same to PA6. Stop this stack (`docker compose down` here,
because the ports clash), start your PA6 stack, make its shipping slow the
same way, and `docker kill pa6-orchestrator` mid-saga. Look at what it
leaves behind in `pa6/orchestrator/data/`, and send the same request with
the same key again. Your ADR's Context starts there.

Set shipping back to normal afterwards: `{"shippingDelayMs":0}`.

---

## 8) When it does not work

| You see | Look at |
|---|---|
| `up` fails, or a test says `../pa6/mock-services/...` is missing | §3: your `pa6/` folder, mocks included, next to `pa7/` |
| `up` says a port is already allocated | Your PA6 stack is still running. `docker compose down` in `pa6/` |
| `pa7-api exited (1)` | `docker compose logs api` — usually `canonical/` missing from the repository root |
| `500 workflow_not_finished` after 45 s | Your workflow is failing and Temporal keeps retrying it. Open the link in the message: the UI shows the error. Usually I/O in the workflow, or a thrown exception. `docker compose logs worker` shows it too |
| `500 workflow_failed` | Your workflow threw an `ApplicationFailure`. Return a `CheckoutResult` instead (§4) |
| A step that should fail once is tried three times | Your activity threw a retryable error for a `4xx` |
| A timeout never ends | No retry policy: Temporal retries forever |

A workflow left running by a bug stays running until you end it: use
**Terminate** in the UI, or
`docker exec pa7-temporal temporal workflow terminate --workflow-id <key>`.

---

## 9) What is tested

Public tests (`tests/public/`, run them with `npm --prefix tests test`).
Each sets the mock behaviour it needs, then reads back from `/admin/logs`
what each mock was called with, and how many times:

1. `../pa6/mock-services` and `../canonical/order.schema.json` are present
2. The api, Temporal and the four mocks are up
3. Happy path: `200` + `completed`, the four steps, payment received
   `"63.90"` and notification the customer's email
4. The four calls reached the mocks strictly one after another
5. A refused payment: `422` + `failed`, **one** attempt, nothing downstream
6. A refused reservation: `422` + `compensated`, **one** attempt, payment refunded
7. A slow shipping call: **exactly three** attempts, then `504` + `timeout`,
   inventory released and payment refunded
8. **The worker is killed mid-saga and started again:** `200` +
   `completed`, payment and inventory called once each, shipping once or
   twice
9. Replay: same key and payload, identical response, payment called once
10. Mismatch: `409` + `idempotency_payload_mismatch`
11. In-flight conflict: `409` + `idempotency_conflict`
12. The audit mirror records the finished saga and matches `grading/schema/`
13. `docs/adr-006.md` has its five headings, and at least three items under
    the last

The suite takes about a minute. Test 8 kills and restarts your
`pa7-worker` container, so it needs the `docker` command on the machine
that runs the tests. On the untouched scaffold, tests 1 and 2 pass and the
rest fail, each saying why.

**Hidden tests** also run at grading time — the same requirements,
different cases: a compensation that fails, a refused notification (shipping
cannot be undone), the replay of a failed saga, payload variations that must
not change the outcome, and randomised prices checked against the exact
amount payment received.

---

## 10) Your ADR

`docs/adr-006.md` has **five** headings: PA6's four, and
`## What the engine took over`. Keep them exactly as they are. A public test
checks them, and checks that the last one lists at least three items. The
manual 30% of this assignment is the quality of what you write under them.
Write it with your PA6 orchestrator open next to your workflow.

---

## 11) Submission checklist

- [ ] `pa6/` (with `mock-services/`) and `canonical/` are in my repository next to `pa7/`
- [ ] The six activities make the calls in §4 and throw non-retryable errors for a `4xx`
- [ ] The workflow runs the four steps in sequence and compensates in reverse order
- [ ] The retry policy is the one in §4
- [ ] No I/O in the workflow; only types imported from `../activities`
- [ ] Every outcome returns a `CheckoutResult`; the workflow never throws
- [ ] I killed the worker mid-saga myself, and watched the workflow finish in the UI
- [ ] `docker compose exec worker npx tsc --noEmit` is clean
- [ ] `npm --prefix tests test` passes in full
- [ ] `docs/adr-006.md` completed, all five sections
- [ ] AI-usage note added (if applicable) with what you changed/understood

---

## Submitting

Your work goes in **your** repository, not this one:

```text
eai-2026-<surname>/
  canonical/                   from PA4, unchanged
  pa6/                         the whole folder — PA7 builds its mocks from pa6/mock-services
  pa7/
    worker/src/activities/     your activities
    worker/src/workflows/      your workflow
    worker/  api/  tests/  grading/  docker-compose.yml  .gitignore
    docs/adr-006.md
```

Then submit your repository URL through the portal at
**<https://evaluentis.leitass.eu>**. Never by email.

At grading, `canonical/`, `pa6/mock-services/`, `pa7/api/`,
`pa7/worker/src/worker.ts`, `pa7/worker/src/types.ts`, `pa7/tests/public/`
and `pa7/grading/schema/` are replaced with the official copies, so a change
to any of them does not change your mark.

See [how an assignment works](../README.md#how-an-assignment-works) in the
root README for the late penalty and the progression gate. The graded
commit is the SHA at `HEAD` **when you submit** — later pushes are not
seen. Run `docker compose up -d --build --wait && npm --prefix tests test`
one more time before you do. Read [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
before asking a question — it will usually be faster.

---

## Common ways to lose marks

| | |
|---|---|
| Calling `axios` or `fetch` in the workflow | The workflow fails every time it runs and never finishes. Every HTTP call is an activity |
| Importing the activity functions into the workflow | Import `type * as activities` only, and call them through `proxyActivities` |
| No retry policy | Temporal retries forever, and the timeout test never ends |
| Retrying a `4xx` | A declined payment is tried three times. Test 5 counts the attempts |
| Throwing from the workflow on a business failure | The api gets no `CheckoutResult`. Return one for every outcome |
| Compensating in the wrong order, or compensating shipping | Inventory first, then payment. Shipping and notification have no undo |
| Summing prices as floats | Payment receives `"63.89"` or `63.9`. Port your PA6 cents arithmetic |
| Not committing `pa6/mock-services` | The stack does not build, and every test after test 1 fails |
| Forgetting to rebuild | The worker runs your previous code. `--build`, every time |
| An ADR that restates this README | 30% of the mark, and I have read this README |
