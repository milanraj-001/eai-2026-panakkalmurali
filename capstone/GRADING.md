# Capstone grading

- **The capstone is scored out of 115 points:** 30 from the public tests, 60 from the hidden tests, 10 manual, and 15 for the advanced component.
- **It passes at 41.0 points**, after the late penalty and the defence, unrounded.
- **A 10 needs the advanced component** (README §4.11). Without it, the ceiling is 100 points: a 9.
- **The defence is a pass/fail gate.** A failed defence sets the capstone to 0 points (§8).

---

## 1. The scale

**Final % = 0.5 × your homework average % + 0.5 × (capstone points ÷ 115 × 100)**

Capstone points are used unrounded, after the late penalty and the defence. The final percentage is rounded once, at the very end ([SYLLABUS](../SYLLABUS.md) §4).

| Capstone grade | Points | About | |
|---|---|---|---|
| 10 | 101 ≤ p ≤ 115 | 88–100% | outstanding. **Needs the advanced component** |
| 9 | 91 ≤ p < 101 | 79–87% | excellent: the ceiling without Temporal |
| 8 | 81 ≤ p < 91 | 70–78% | very good |
| 7 | 71 ≤ p < 81 | 62–69% | good |
| 6 | 61 ≤ p < 71 | 53–61% | almost good |
| 5 | 51 ≤ p < 61 | 44–52% | satisfactory |
| **4** | **41 ≤ p < 51** | **36–43%** | **almost satisfactory. The pass line is 41.0 points** |
| 3 | 31 ≤ p < 41 | 27–35% | fail |
| 2 | 21 ≤ p < 31 | 18–26% | fail |
| 1 | 0 ≤ p < 21 | 0–17% | fail |

Both halves must pass on their own: the homework average at 50% or more, and the capstone at 41.0 points or more. The capstone is graded only if the progression gate is clear ([SYLLABUS](../SYLLABUS.md) §1).

---

## 2. Where the points come from

| Block | Points | What |
|---|---|---|
| Public tests | 30 | §3. The tests in `tests/public/`, one point each |
| Hidden tests | 60 | §4. The same requirements, other cases. Published as area totals only |
| Manual | 10 | §5. Your reasoning in the documents |
| The advanced component | 15 | §6. Temporal mode. All or nothing |

---

## 3. Public tests — 30

Run them yourself: `npm --prefix tests run test:stage -- 6` runs all of them.

| ID | Stage | Checks | Pts |
|---|---|---|---|
| P0.1 | 0 | Every one of your services' `/health` answers 200 with the deep-check structure (README §4.9) | 1 |
| P0.2 | 0 | Your compose conforms: it includes `docker-compose.kit.yml`, keeps the project name `capstone`, and declares the fixed service and container names, host ports, `mem_limit`s, named volumes and healthchecks | 1 |
| P0.3 | 0 | The topology in README §3.2 exists, with its types and arguments | 1 |
| P1.1 | 1 | Web JSON → 202 with a UUID v4 `correlationId`. `GET /orders/:cid` answers 200 | 1 |
| P1.2 | 1 | Mobile JSON → 202 | 1 |
| P1.3 | 1 | b2b windows-1257 XML → 202. The event validates against the canonical schema, and its diacritics are correct | 1 |
| P1.4 | 1 | The event has the headers `correlationId` (the one returned), `causationId` and `businessKey`, a `messageId`, and is persistent | 1 |
| P1.5 | 1 | A missing key → 400 `validation_error`. The same key and body → the same `correlationId`, and exactly one event | 1 |
| P1.6 | 1 | An unknown product → 422 `unknown_product`, and no event | 1 |
| P1.7 | 1 | A pricing outage → 503 `pricing_unavailable` with `Retry-After`, and no event. After recovery, the same key → 202 | 1 |
| P2.1 | 2 | A web order → `completed`. Each mock is called once, in the order payment → inventory → shipping → notification | 1 |
| P2.2 | 2 | Payment receives the exact decimal-string amount and `Idempotency-Key: authorize:<businessKey>` | 1 |
| P2.3 | 2 | Every mock call carries `X-Correlation-Id` = the returned `correlationId` | 1 |
| P2.4 | 2 | A b2b order → `completed`. Payment is never called. Inventory receives `Idempotency-Key: reserve:<businessKey>` | 1 |
| P2.5 | 2 | `GET /orders/:cid` validates against its schema, with `state: completed` and the right `businessKey` | 1 |
| P3.1 | 3 | Payment declined → `failed` with `payment_declined`, and nothing downstream is called | 1 |
| P3.2 | 3 | Inventory unavailable → `compensated`, with exactly one refund | 1 |
| P3.3 | 3 | A shipping timeout → `compensated` with `timeout`. The release comes before the refund | 1 |
| P3.4 | 3 | b2b with a shipping failure → `compensated`: a release, and no refund | 1 |
| P4.1 | 4 | `{ not json` on `orders.exchange` → `orders.invalid`, with its original bytes. Not in `orders.dlq`, and not retried | 1 |
| P4.2 | 4 | A failed order → an `order_not_completed` notice | 1 |
| P4.3 | 4 | The same outcome event, published again by the test → still one notice | 1 |
| P4.4 | 4 | The notification mock fails (with no effect) for `order_not_completed` → a `GET /dlq` entry with `originQueue: notifications.queue`, `attempts: 3` and `lastError` | 1 |
| P4.5 | 4 | Fix it, then `POST /dlq/replay` → exactly one notice. The DLQ is empty | 1 |
| P5.1 | 5 | `GET /trace/:cid` validates against `trace.schema.json` | 1 |
| P5.2 | 5 | A completed order's trace contains `intake.receive` … `intake.publish`, `saga.consume`, `payment`, `inventory`, `shipping`, `notification`, `saga.outcome`, in `startedAt` order, all with the same `correlationId` | 1 |
| P5.3 | 5 | `/ops/metrics` validates. All seven alert keys are present. `dlqDepth` counts a dead-lettered message, and `dlq_not_empty` fires | 1 |
| P5.4 | 5 | `docker stop cap-notifier`, then your declared `notifier_consumer_lag` threshold + 1 `order.failed` events → `notifier_consumer_missing` and `notifier_consumer_lag` fire. After `docker start` and the drain, both clear | 1 |
| P6.1 | 6 | The document files exist. ADR-007 to ADR-010 have their four headings. The ADR index links resolve. `ai-usage.md` and `agent-readiness.md` have their headings. Every required heading has text of yours under it: a template's prompt does not count | 1 |
| P6.2 | 6 | The BPMN checks, the mermaid checks, the `patterns.md` rows and links, and a runbook section, with text, for each of the seven alert keys (README §6) | 1 |

---

## 4. Hidden tests — 60

Hidden tests check the same requirements as the public ones, with other cases, and the requirements of step 6 in README §2, which have no public test. They are never published. Only the area totals are.

| Area | Points | README |
|---|---|---|
| **A. Saga and compensation matrix** | **15** | §4.2–4.4, §4.10 |
| **B. Idempotency and dedup layers** | **12** | §4.1, §4.2, §4.5 |
| **C. DLQ operations and the invalid channel** | **10** | §4.6, §4.9 |
| **D. Trace causality** | **10** | §4.8 |
| **E. Resilience** | **8** | §4.7, §4.9, §3.5 |
| **F. Intake robustness** | **5** | §4.1 |

---

## 5. Manual criteria — 10

These judge your reasoning, not your formatting: the machine checks are in P6.1 and P6.2.

| ID | Criterion | Counting rule |
|---|---|---|
| M1 (3) | **Failure analysis** | Each of the ten scenarios is **correct** when (a) its trigger, reaction and final state match the grader's evidence run for that scenario, **or describe an observed defect honestly, as it behaves**; (b) the operator action names a real endpoint or command; (c) the alert matches the predicates in README §4.9, or says `none, by design` with a reason. **3** = 9–10 correct · **2** = 7–8 · **1** = 4–6 · **0** = 3 or fewer. A runtime defect loses automated points only. An accurate description of it loses nothing here |
| M2 (4) | **ADR-007 to ADR-010**, 1 each | **1** = it answers the template's core question, and names a real alternative and a real cost **specific to this system**: a component, a file, or an observed behaviour. **0.5** = it answers the question generically. **0** = it restates the brief, or is missing |
| M3 (2) | **Agent-readiness** | Four elements: (a) the tools separate read from write, with input schemas; (b) it names **this system's** free-text canonical fields (`customer.name`, `customer.address.street`, …) as injection paths; (c) replay and compensate require human confirmation; (d) audit logging is named. **2** = all four · **1** = two or three · **0** = one or none, or generic agent-security text |
| M4 (1) | **Pattern-table accuracy** | **1** = every row is correct at its link. **0** = one or more false rows. **Deduction:** with *n* false rows, the manual block loses min(3, n − 1) more points, with a floor of 0 for the block |

**The evidence.** For each of the ten failure-analysis scenarios, the grader runs the scenario against your system and records the final state, the trace, the alerts and the mock effects. M1 compares your document with that record.

---

## 6. The advanced component — 15, all or nothing

Declare it in your README (README R-5.3.2). It is run with `SAGA_ENGINE=temporal` and `--profile temporal`. **Every one of these must pass**, with the rerun described in §7:

| ID | Condition |
|---|---|
| T1 | The stack is healthy in temporal mode within its limit (README R-3.6.1), and `cap-worker` is polling the task queue. The orchestrator lists no stuck sagas, and answers compensate with `409 saga_not_stuck` (README R-4.7.12) |
| T2 | Web and b2b happy paths → the same states, the same trace operations (with `service: worker` for the steps) and the same effects as the core |
| T3 | An inventory failure → `compensated`. A shipping timeout → 3 attempts, then `compensated` with `timeout`. A refund failure → `compensation_failed` |
| T4 | `docker kill cap-worker` during slow shipping, then start it → `completed`, one charge, one reservation |
| T5 | Payment answers 503 twice → the activity retries absorb it → `completed`, one charge, nothing in `orders.dlq` |
| T6 | The same `order.accepted` event delivered twice → one workflow (`workflowId = businessKey`), one charge. The same order submitted again with a new `Idempotency-Key` → `duplicate` (README R-4.11.3) |
| T7 | `adr-011.md` has its five headings, each with text of yours under it, and at least 3 list items under `## What the engine took over` |

The core (§3, §4) is always graded in hand-rolled mode.

---

## 7. How a submission is graded

1. A fresh clone of your repository, at the graded commit.
2. `../canonical/`, `docker-compose.kit.yml`, `mocks/` and `grading/schema/` are replaced with the official copies (README R-5.3.3).
3. The configuration policy check (README §9). A failure is **POLICY REJECTED**: nothing runs, and I review the case myself.
4. `docker compose up -d --build --wait`, timed against README R-3.6.1.
5. The public tests, then the hidden tests, run from outside your repository. **Failed tests are run once more, on a fresh stack** (`down -v`, a fresh clone).
6. The ten failure-analysis evidence runs (§5).
7. The advanced suite, if your README declares it (§6).
8. The manual review (§5).

**FAILED TO START.** A stack that is not healthy within its limit gets only the checks that need no running stack: P0.2, P6.1, the static parts of P6.2, and the manual block. That is at most 13 points: a fail. I never fix a submission ([SYLLABUS](../SYLLABUS.md) §6: the graded commit is final).

---

## 8. Lateness, the progression gate, the defence

**Late:** capstone points × max(0, 1 − 0.02 × started hours after the deadline). More than 32 hours late, even 115 points fall below the 41.0 pass line. The hard cut-off is **2026-11-23, 20:00**: after it, no submission is accepted ([SYLLABUS](../SYLLABUS.md) §1). The rules on resubmission in [SYLLABUS](../SYLLABUS.md) §7 apply.

**The progression gate:** Session 0 and PA1–PA7 must all have been submitted before their cut-offs, or the capstone is not graded ([SYLLABUS](../SYLLABUS.md) §1).

**The defence** is oral, about 20 minutes:

| | About |
|---|---|
| **Explain:** your architecture from your own diagrams, one ADR of my choice, and the code behind a row of your pattern table that I pick | 8 min |
| **Drill:** a copy of your own capstone with one fault planted in it. You reproduce the symptom with me, then diagnose it with your own logs, trace, `/ops/metrics` and runbook | 10 min |
| **Wrap:** what would break first under ten times the load | 2 min |

**It is pass or fail.** You fail if you cannot explain your own system, **or** if you cannot localise the planted fault to the right component and mechanism within the drill time. A failed defence sets the capstone to 0 points, and so fails the course. **Retake according to the university policies.**

- If the planted fault does not show its symptom in front of you, that is my setup failure, never yours: I switch to a second fault, prepared in advance.
- **One hint** exists for each fault, written in advance. It is available once, not before minute 5 of the drill; you may ask for it, or I may offer it. I read it word for word, and give no other help. It says where to look, never what is wrong. Using it does not change the pass criterion. It is recorded.

The full rule is in [SYLLABUS](../SYLLABUS.md) §10.

---

## 9. Feedback and appeals

Before the exam you get **area scores only**: public tests by stage, hidden areas A–F, M1–M4, and the advanced component (yes or no), with my note on each manual criterion. Hidden test names and failure messages are shown only in an appeal meeting: raise it within 7 days of the mark ([SYLLABUS](../SYLLABUS.md) §13).
