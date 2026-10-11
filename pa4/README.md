# PA4 — Three sources to one canonical model

| | |
|---|---|
| **Session** | S4 — Transformation and the canonical model · 2026-09-30, C211 |
| **Scaffold language** | TypeScript |
| **Published** | with S4 on 2026-09-30 |
| **Deadline** | **2026-10-12, 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-10-19, 20:00** — miss it and the capstone is not graded |
| **Weight** | one seventh of the homework half — about 7.1% of the final grade |
| **Mark** | 70% automated tests, 30% manual (ADR quality, self-assessment honesty) |
| **ADR** | `docs/adr-003.md` |

---

## The situation

Three systems send you the same kind of thing — a customer order — and no
two of them agree on what it looks like. The web store nests everything
under `customer.address`. The mobile app flattens it into abbreviated top-
level fields and gives you a comma-separated address string, an epoch
timestamp, and an integer status code instead of a word. The B2B partner
sends XML in an EDI dialect, declares an encoding that is not UTF-8, and
prices its own line items with numbers you must not trust.

None of the three tells you what a product actually costs right now — for
that you call a pricing service and use its answer. All three carry the
customer's payment details, in three different shapes, and none of those
details may travel any further than this assignment.

Your job is the transformation chapter of this course, applied for real:
**translator**, **content enricher**, **content filter** — three named
patterns, one assignment, using each of them because the input actually
requires it rather than because a slide said to.

---

## What you are given

### `../canonical/order.schema.json` — the canonical order

Fixed. See [`../canonical/README.md`](../canonical/README.md) for why it has
its own folder and why you do not get to change it. Two things about it are
not obvious from the source formats, so they are worth saying here directly:

- **`unitPrice` is a decimal STRING**, e.g. `"24.99"`, never a JSON number.
  The same reason as PA1's `amount`: `4.5` prints as `"4.5"`, not `"4.50"`,
  and a float silently drops the information a currency needs to round-trip.
- **There is no field anywhere in this schema for payment details.** Every
  source carries some — a card number, an IBAN — and the schema's
  `additionalProperties: false` (on the order, on `customer`, and on each
  item) means a stray field does not just look untidy, it fails validation.

### `data/web-order.json`, `data/mobile-order.json`, `data/b2b-order.xml`

The three source fixtures. They deliberately encode **the same logical
order** — same customer, same address, same two line items, same currency,
same status, same instant in time — so that once you translate all three,
the results should be identical except for `orderId`, `orderType`, `source`
and `receivedAt`. A public test checks exactly that. If your three outputs
disagree on anything else, one of your mappings is wrong, even if each
source passes its own tests in isolation.

`data/b2b-order.xml` is CP1257-encoded (declared `encoding="windows-1257"`
in its own XML prolog) and contains Latvian diacritics in the customer name
and address — the same lesson as PA1's order file, in XML this time. It also
carries a `<UnitListPrice>` per line item, in the comma-decimal style
(`24,99`) — a legacy list price. It is not the real price. Use the pricing
API, not this field; a public test checks that too.

### `mock-pricing/` — the pricing API (given, not a TODO)

`GET http://localhost:4100/pricing/:productId`, authenticated with an
`X-API-Key` header — the key is set in `docker-compose.yml`, and
`starter/src/transform.ts` already exports it as `DEFAULT_PRICING_API_KEY`.
Returns `200` with
`{ productId, unitPrice, currency, taxRate, productName }`, `401` on a
missing/wrong key, `404` on an unknown product id. `GET /pricing` returns
the full catalog. See `mock-pricing/server.js` for the (also given) admin
endpoints the test suite uses to change a price or simulate an outage at
runtime — you do not need them for your implementation, only the tests use
them.

---

## What to build

Implement the TODOs in `starter/src/transform.ts`:

```ts
export function translateWeb(webOrderPath: string, options: TranslateOptions): Promise<TransformResult>;
export function translateMobile(mobileOrderPath: string, options: TranslateOptions): Promise<TransformResult>;
export function translateB2B(b2bOrderPath: string, options: TranslateOptions): Promise<TransformResult>;
```

**Do not change those signatures.** I call them directly with my own fixture
paths and my own `pricingBaseUrl` when I grade — that is what makes the
hidden tests possible. Everything else in the file is yours to restructure;
the TODO functions are suggestions for how to decompose the work, not a
required shape.

Each function must:

1. Read and parse its own source format (JSON, JSON, or CP1257 XML).
2. Normalize each line item's product id to the pricing API's `PROD-XXX`
   format (see the table below), call the API, and use its price, currency
   and tax rate — never a number you typed into `transform.ts` yourself.
3. Map everything onto `CanonicalOrder`, dropping the source's payment
   details entirely.
4. Return `{ order, warnings }` rather than throwing, even when a product id
   is unknown or the pricing API errors — see `EnrichResult` and the
   TODOs on `enrichFromPricing`/`enrichItems` for what "report it, don't
   crash" means concretely.

### Product id normalization

| Source | Format | Example | Normalize to |
|---|---|---|---|
| web | `PROD-XXX` | `PROD-001` | unchanged |
| mobile | numeric only | `001` | prepend `PROD-` → `PROD-001` |
| b2b | `SKU-PROD-XXX` | `SKU-PROD-001` | strip `SKU-` → `PROD-001` |

### Currency and status mappings (mobile)

| Numeric code | Currency | | Integer | Status |
|---|---|---|---|---|
| 978 | EUR | | 1 | new |
| 840 | USD | | 2 | processing |
| 826 | GBP | | 3 | shipped |
| | | | 4 | delivered |

---

## Running it

First, copy **two** folders into the root of your own repository: `pa4/`,
and `canonical/`, which sits next to it (see
[starting an assignment](../README.md#starting-an-assignment)). The tests
read `../canonical/order.schema.json` from `pa4/` — without it, every schema
test fails before it ever reaches your code.

```bash
cd pa4
docker compose up -d --wait   # starts mock-pricing on :4100
cd starter
npm ci
npm test          # the public tests. Run them constantly
npm start         # writes ../out/{web,mobile,b2b}.json
npm run typecheck # tsc --noEmit over your code
```

Windows: no `make` needed anywhere in this assignment.

When you are done for the session: `docker compose down` from `pa4/`.

---

## Where to start

1. **Get one source enriching correctly before touching the other two.**
   `translateWeb` is closest to canonical already — start there.
2. **`enrichFromPricing` and `toDecimalAmount` first.** Nothing downstream
   is trustworthy until a single product id turns into a correctly
   formatted price. Test it against `PROD-013` (unit price `4.5` in the
   catalog) — if you see `"4.5"` instead of `"4.50"` you have found the bug
   this assignment is built around.
3. **Then the source-specific mapping**: addresses, dates, currency and
   status codes, product id normalization.
4. **Then the filter.** Grep your own output for the payment fields you
   just read from the source — if you can find them, so can the test.
5. **Then the edge cases**: an unknown product id, a pricing API error. Do
   not let either one throw out of your function.

---

## Rules

`fast-xml-parser` is already in `starter/package.json` — you do not need
another XML or CSV dependency. You may of course read
documentation, and you may use AI tools — but see
[SYLLABUS.md](../SYLLABUS.md) §12: you have to be able to defend every line
in November, on your own code, with a fault planted in it.

---

## What is tested

Public tests (`tests/public/`, run them yourself) check that:

- each of the three translators produces output that validates against
  `../canonical/order.schema.json`
- all three produce **structurally identical** output for the same logical
  order, modulo `orderId`/`orderType`/`source`/`receivedAt`
- `unitPrice` is always a decimal string with exactly two fraction digits
- changing a product's price in the mock catalog changes the translator's
  output accordingly (prices come from the API, not from your code)
- the B2B fixture's decorative `<UnitListPrice>` is never used as the real
  price
- no payment/card/IBAN data — key or value — reaches the canonical output,
  for any of the three sources
- `docs/adr-003.md` exists with its four sections

**Hidden tests** also run at grading time. They are never published, and
they test the same requirements as the public ones — an unknown product id,
a pricing API that returns `500`, and a B2B input with an element none of
this README described. If your implementation is correct rather than tuned
to the fixtures, you will not notice they exist.

---

## Your ADR

`docs/adr-003.md`, four sections, one page. **It is 30% of this
assignment's mark.** The template has the prompts; the short version of
what it is asking:

> You mapped three unrelated formats onto a canonical model you do not own,
> enriched them from a service that can fail, and removed data that must
> not travel. Where did each of those bite you — and what would you build
> differently if this canonical model had to outlive this course?

Write it after the code, while the annoyance is still fresh.

---

## Submitting

Your work goes in **your** repository, not this one:

```text
eai-2026-<surname>/
  canonical/          unchanged, as given — the tests read it
  pa4/
    data/             unchanged, as given
    mock-pricing/     unchanged, as given
    starter/          your implementation, in src/transform.ts
    tests/public/     unchanged, as given
    docs/adr-003.md
    docker-compose.yml
```

Then submit your repository URL through the portal at
**<https://evaluentis.leitass.eu>**. Never by email.

At grading, `canonical/` and `tests/public/` are replaced with the official
copies from this repository. An edit to either is not seen, so do not make
one to get a test passing.

The graded commit is the SHA at `HEAD` **when you submit** — later pushes are
not seen. Run `npm test` against a fresh `docker compose up -d --wait` one
more time before you do.

See [how an assignment works](../README.md#how-an-assignment-works) in the
root README for the late penalty and the progression gate. Read
[`../CONTRIBUTING.md`](../CONTRIBUTING.md) before asking a question — it will
usually be faster.
