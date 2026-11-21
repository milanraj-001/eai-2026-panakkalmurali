# AI usage

## Tools used
Claude, an AI assistant from Anthropic, used through the claude.ai chat interface. I did not use any other AI tool for this capstone.

## What for
Debugging the running system (reading test output, queue states and logs), suggesting the commands I ran for the hand checks of step 6, and drafting the documents: the four ADRs, this file, agent-readiness.md and the runbook. The code of the four services is my own PA4 to PA7 work, changed inside capstone/; the assistant helped find and fix specific faults in it.

## What I changed or rejected
- The first full test run had 15 failures: every order stayed `accepted`. The cause, found by reading the queue state, was in intake's outcome consumer: it requeued an outcome for an unknown order forever, so those messages filled the prefetch window and starved the real ones. I applied a bounded retry that acks after five tries.
- The assistant's first concurrency check reported 0 of 5 completed. The fault was in its polling script, not in my code: I reran it with every response shown and all five orders completed. I did not change the orchestrator for it.
- Its first republish script wrote to `/tmp`, which Node on Windows resolved to another folder, so it failed. I reran it with files in the current folder.
- The drafts of the documents are checked against my code and my test results before I keep a claim in them; a claim I could not confirm I removed or rewrote.

## What I verified, and how
- The public tests, stages 0 to 5: 28 of 28 pass against the running stack, after the intake fix.
- Step 6 by hand, each against the mocks' admin API: the first-step retry path (two 503s, one charge, two `saga.retry` hops); park after `MAX_RETRIES` and replay (one charge, empty DLQ); outcome republish on redelivery (a second `order.completed`, one charge); restart-proof stores after `docker compose restart` and after `docker kill` (state, idempotent POST and all ten hops survived); a stuck saga and operator compensation (`needs_attention`, one refund, one release, the same answer on a second call); runtime reconnect (503 while the broker was down, 200 within 35 seconds, no container restart); concurrency (five orders with a 2 s shipping delay completed together and the shipping calls overlapped).
- The document tests of stage 6 for the files I changed.

## Dependencies beyond the allow-list
None. The services use amqplib, ajv, ajv-formats and fast-xml-parser, all on the allow-list.
