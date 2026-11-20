# Failure analysis

<!--
Ten things that go wrong, and what your system does about each (README §6,
R-6.4). This document is M1, 3 of the manual points (GRADING.md §5).

For each scenario, write five things:

  Trigger          what goes wrong, and how you made it happen
  What the system does
                   step by step, with a real trace excerpt in a fenced block:
                   the hops from GET /trace/:cid of a run you did yourself
  Final state      GET /orders/:cid, and the effects in the mocks' /admin/effects
  Alert            the alert of README §4.9 that fires, or "none, by design",
                   with the reason
  Operator action  what an operator does next: a real endpoint or command

How it is judged. The grader runs each scenario against your system and
records the final state, the trace, the alerts and the mock effects. A
scenario is correct when your description matches that record, the operator
action is real, and the alert matches the predicates in README §4.9.

Describe your system as it behaves, not as the brief says it should. If a
scenario shows a defect (a second charge, an order stuck in processing),
describe the defect honestly: it costs automated points only, and an
accurate description loses nothing here. A description of behaviour your
system does not have is wrong, however good it sounds.

The triggers below use the mocks' admin API (README §5.2). Reset the mocks
between scenarios.
-->

## 1. Payment declined

<!-- {"authorize":{"failMode":"always","failStatus":402}} on port 4801, then a web order. -->

## 2. Inventory unavailable

<!-- {"reserve":{"failMode":"always"}} on port 4802, then a web order. -->

## 3. Shipping timeout

<!-- {"create":{"delayMs":3500}} on port 4803: longer than REQUEST_TIMEOUT_MS. -->

## 4. A refund fails, then operator compensation

<!--
{"create":{"failMode":"always"}} on 4803 and {"refund":{"failMode":"always"}}
on 4801, then a web order. When it is compensation_failed, fix the refund
({"refund":{"failMode":"never"}}) and call POST /sagas/:cid/compensate.
Say which compensations ran the second time, and which did not.
-->

## 5. A payment outage before step 1: retry, parked, replay

<!--
{"authorize":{"failMode":"always","failStatus":503}} on 4801, then a web
order. Wait until it is parked, fix payment, then POST /dlq/replay.
-->

## 6. A failure-notice delivery outage

<!--
A failed order (payment declined), while the notification mock fails the
notice: {"send":{"failMode":"always","failStatus":503,"failForKinds":["order_not_completed"]}}
on 4804. Wait for the notifier's DLQ entry, fix the mock, then replay.
-->

## 7. The orchestrator crashes mid-saga

<!--
{"create":{"delayMs":5000}} on 4803, a web order, then docker kill
cap-orchestrator about a second later, while shipping is in flight and
before REQUEST_TIMEOUT_MS runs out, and docker start cap-orchestrator.
README §2, "Checking step 6 by hand", has the commands.
-->

## 8. A broker restart

<!-- docker restart cap-rabbitmq. Then send an order. What did each of your services do meanwhile? -->

## 9. A duplicate submission with a new Idempotency-Key

<!-- The same order, sent twice with two different Idempotency-Keys. -->

## 10. A malformed message

<!-- { not json published to orders.exchange from the management UI. With a correlationId header, and without one. -->
