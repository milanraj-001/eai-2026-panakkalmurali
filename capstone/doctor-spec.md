# A conformance doctor — optional

**Optional, and not graded.** This is a specification, with no code, for a tool you can build for yourself: a doctor that checks your capstone against the fixed parts of the contract in a few seconds, and names what is wrong.

Why build one: a slip in the fixed contract costs more than any bug. A wrong host port fails every test that uses it. A `mem_limit` of `512m` fails P0.2. A queue with one argument different fails P0.3, and makes RabbitMQ close your channel. The public tests find these too, but a doctor names them all at once, and in words you chose.

I run a doctor of my own on every submission before the tests. It checks what this page describes, and it is informational only: it changes no points. Your doctor is never run at grading.

---

## What it prints

One line per check, then a verdict:

```
DOCTOR capstone at /home/anna/eai-2026-berzina/capstone
  PASS  D1   the compose file resolves: project capstone, includes docker-compose.kit.yml
  PASS  D2   intake, observer, orchestrator, notifier, worker: container names
  FAIL  D5   orchestrator: mem_limit is 512m; expected 256m (R-3.6.2)
  WARN  D9   intake: FROM node:20-alpine; node:20-bookworm-slim is recommended (R-3.6.3)
  SKIP  D12  no stack is running: start it, or run with --static
  …
DOCTOR: FAIL (1)
```

- **PASS**: the check holds. **FAIL**: it does not; the line says what was found, what was expected, and the requirement ID. **WARN**: allowed, but worth a look. **SKIP**: the check could not run.
- The last line is `DOCTOR: PASS` when no check failed, and `DOCTOR: FAIL (n)` with the number of failed checks otherwise. WARN and SKIP do not count.
- It exits with 0 on PASS, and with 1 on FAIL.
- A check that fails for more than one service prints one FAIL line per service; *n* counts the lines.

## How it runs

- It takes the path of your `capstone/` folder, and runs from anywhere.
- **Static checks** (D1–D10) read files only: your compose file, Dockerfiles, `rabbitmq/definitions.json`, `docs/` and your README. They need no running stack.
- **Live checks** (D11–D13) talk to a running stack on `localhost`, at the host ports of README §3.1. With `--static`, or when nothing answers on 15680, they print SKIP.
- It resolves the compose file the way the grader does (README §9): `docker compose -f docker-compose.yml config`, with `SAGA_ENGINE` unset and without your `.env`. `--format json` gives you something to parse.

---

## The checks

### Static

| Check | What it checks | Requirements |
|---|---|---|
| **D1** | `docker compose -f docker-compose.yml config` succeeds. The project name is `capstone`. `docker-compose.yml` has the `include:` of `docker-compose.kit.yml` | R-3.1.1, R-3.1.3, R-9.1 |
| **D2** | The services `intake`, `observer`, `orchestrator` and `notifier` exist, with the container names `cap-intake`, `cap-observer`, `cap-orchestrator` and `cap-notifier`. If `worker` exists, its container is `cap-worker`, and it is in the profile `temporal` | R-3.1.2, R-3.1.6 |
| **D3** | The host ports: intake 8800, observer 8801, orchestrator 8802, notifier 8803. The worker publishes none | R-3.1.2 |
| **D4** | Every variable in the table below is set on its service, with exactly this value | R-3.4.2 |
| **D5** | `mem_limit` is `256m` on intake, observer, orchestrator and notifier, and `768m` on the worker | R-3.6.2, R-9.5 |
| **D6** | Each of intake, observer, orchestrator and notifier mounts its named volume at `/data`: `intake-data`, `observer-data`, `orchestrator-data`, `notifier-data`. No service bind-mounts the Docker socket, or a host path outside `capstone/` other than `../canonical`, read-only. A bind mount inside `capstone/` is a WARN: README §9 allows it, but state belongs in the named volume | R-3.1.4, R-9.3 |
| **D7** | Each of intake, observer, orchestrator and notifier declares a healthcheck | R-3.1.5 |
| **D8** | `rabbitmq/definitions.json` declares every exchange and queue of README §3.2, with its type, `durable: true`, the queue arguments and the bindings. It may declare more | R-3.2.1 |
| **D9** | Each of your four services has the Dockerfile its `build:` names (FAIL otherwise). The final stage of `worker/Dockerfile` is based on `node:20-bookworm-slim`, or a more precise tag of it such as `node:20.18-bookworm-slim` (FAIL otherwise; without the advanced component, a missing `worker/Dockerfile` is a SKIP). For your other services, a base other than `node:20-bookworm-slim` or `python:3.12-slim` is a WARN | R-3.6.3, R-5.3.1 |
| **D10** | The files of README §6 exist in `docs/`: `architecture.md`, `orchestration.bpmn` with an `orchestration.svg` or `.png`, `patterns.md`, `failure-analysis.md`, `runbook.md`, `agent-readiness.md`, `ai-usage.md`, `adr/README.md`, `adr/adr-007.md` to `adr-010.md`. Your `README.md` has `## Advanced component`, and its first line starts with `Implemented.` or `Not implemented.`; with `Implemented.`, `adr/adr-011.md` exists too | R-5.3.2, R-6.1–R-6.10 |

**D4, the variables.** The given `docker-compose.yml` sets all of these. You may add your own.

| Service | Variable = value |
|---|---|
| all four, and worker | `RABBITMQ_URL` = `amqp://eai:eai-capstone@rabbitmq:5672`, `DATA_DIR` = `/data` |
| intake | `PRICING_URL` = `http://pricing:4100`, `PRICING_API_KEY` = `pa4-pricing-key-2026`, `REQUEST_TIMEOUT_MS` = `2500`, `ORDER_ITEMS_MAX` = `50` |
| orchestrator | `PAYMENT_URL` = `http://payment:4001`, `INVENTORY_URL` = `http://inventory:4002`, `SHIPPING_URL` = `http://shipping:4003`, `NOTIFICATION_URL` = `http://notification:4004`, `REQUEST_TIMEOUT_MS` = `2500`, `MAX_RETRIES` = `3`, `SAGA_CONCURRENCY` = `5`, `SAGA_STUCK_AFTER_MS` = `10000`, `SAGA_ENGINE` = `handrolled`, `TEMPORAL_ADDRESS` = `temporal:7233` |
| notifier | `NOTIFICATION_URL` = `http://notification:4004`, `REQUEST_TIMEOUT_MS` = `2500`, `MAX_RETRIES` = `3` |
| worker | the orchestrator's four provider URLs, `REQUEST_TIMEOUT_MS` = `2500`, `TEMPORAL_ADDRESS` = `temporal:7233` |

`SAGA_ENGINE` is `handrolled` because the doctor resolves the file with it unset.

### Live

| Check | What it checks | Requirements |
|---|---|---|
| **D11** | The running broker has the topology of README §3.2: every exchange with its type, every queue with its arguments, every binding. Read it from the management API on <http://localhost:15680> (user `eai`, password `eai-capstone`): `/api/exchanges/%2F`, `/api/queues/%2F`, `/api/bindings/%2F` | R-3.2.1 |
| **D12** | `GET /health` on each of your four services answers `200 {status: "ok", checks: {broker: "up", consumers: {…}}}`. `consumers` lists each queue the service consumes, each with a count of at least 1: `trace.store` for the observer, `saga.queue` for the orchestrator, `notifications.queue` for the notifier | R-4.9.12 |
| **D13** | If `cap-worker` exists, it is running | R-3.1.6 |

---

## What it is not

- **Not the configuration policy.** README §9's rules (no `privileged`, no Docker socket, no fixed volume names, …) are checked before anything runs at grading. A doctor that checks them too is a good idea: they are simple rules on the same resolved configuration.
- **Not a test of behaviour.** A PASS says the contract's fixed parts are right. Whether your system behaves as §4 says is the tests' job.

## Building it

Any language, anywhere in your repository, for example `capstone/doctor/`. Add that folder to `.dockerignore`, so that it stays out of your images' build context. It is yours: nothing grades it, and nothing runs it at grading.
