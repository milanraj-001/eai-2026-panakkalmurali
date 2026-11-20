# Runbook

<!--
What an operator does when an alert fires (README §6, R-6.5). One section per
alert key of README §4.9: keep the seven ## headings as they are. The stage 6
tests check that each has text of yours under it.

In each section:

  Meaning               what the alert says is true, in one or two sentences
  Likely causes         at least 2, specific to this system
  Diagnose              the commands and endpoints you would run, in order:
                        GET /ops/metrics, GET /dlq, GET /trace/:cid,
                        GET /sagas/stuck, docker compose logs <service>, the
                        management UI, the mocks' /admin/logs …
  Fix                   what to do, for each cause
  Verify                how you know it worked: which figure goes back to what

This is the document you will have open at the defence drill, on a fault
planted in your own system. Write it so that it helps you then.
-->

## dlq_not_empty

<!-- A message failed MAX_RETRIES times. Which queue did it come from, and how do you find out why? When is a replay safe, and when does it just send the message back to the DLQ? -->

## invalid_not_empty

<!-- A message could not be processed at all. Why is it never replayed (R-4.6.7)? What do you do with it instead? -->

## saga_consumer_missing

<!-- Nobody consumes saga.queue. -->

## notifier_consumer_missing

<!-- Nobody consumes notifications.queue. -->

## saga_consumer_lag

<!--
More than your threshold of messages ready in saga.queue.

Justify your threshold here (R-4.9.11): why this number, 1–20, for this
queue? Think about SAGA_CONCURRENCY, how long one saga takes, and what a
normal burst of orders looks like.
-->

## notifier_consumer_lag

<!-- More than your threshold of messages ready in notifications.queue. Justify this threshold too (R-4.9.11). -->

## stuck_sagas

<!-- One or more sagas in needs_attention or compensation_failed. What must an operator know before pressing compensate? -->
