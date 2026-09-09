# PA1 — Legacy file ingestion

| | |
|---|---|
| **Session** | S1 — Integration landscape, coupling and styles · 2026-09-02, C113 |
| **Language** | TypeScript · Node 20+ |
| **Deadline** | **2026-09-14, 20:00 Europe/Riga** |
| **Hard cut-off** | **2026-09-21, 20:00** — miss it and the capstone is not graded |
| **Weight** | one seventh of the homework half — about 7.1% of the final grade |
| **Mark** | 70% automated tests, 30% manual (ADR quality, self-assessment honesty) |
| **Containers** | none. Session 0 already proved your environment works |

---

## The situation

Another department has an order system. You need its orders in your system.
Nobody is going to build you an API, and nobody is going to change their export
format because you asked. What you get is a file on a share, every morning,
in the shape their system happened to produce in about 2004.

This is the most common integration in the world, and it is the one everybody
underestimates. Reading a file is the fastest thing you can do. It is also
wrong in about six ways that do not announce themselves — the program does not
crash, it produces a report that looks completely plausible and is quietly
incorrect.

Your job this week is to feel every one of those six ways.

---

## What you are given

### `data/orders-20260901.txt` — the order export

**Fixed-width. Encoded in CP1257 (`windows-1257`), not UTF-8.**

Every field is **left-aligned and padded with trailing spaces**. A well-formed
line is exactly **77 characters**.

| Field | Columns (0-indexed, end exclusive) | Width | Notes |
|---|---|---|---|
| `orderId` | 0 .. 10 | 10 | |
| `customerId` | 10 .. 20 | 10 | |
| `customerName` | 20 .. 52 | 32 | contains spaces, and Latvian diacritics |
| `orderDate` | 52 .. 62 | 10 | `DD.MM.YYYY` |
| `amount` | 62 .. 74 | 12 | comma as the decimal separator, may be negative |
| `currency` | 74 .. 77 | 3 | |

Because the names contain spaces, **you cannot split on whitespace.** Slice by
column position.

### `data/customers.csv` — the customer master

**Semicolon-separated. Encoded in UTF-8** — a different encoding from the order
file, in the same integration. This is not a trick; it is what happens when two
systems are built fifteen years apart.

```csv
customerId;fullName;email;city
C0000001;Jānis Bērziņš;janis.berzins@example.lv;Rīga
```

No field contains a semicolon or a quote, so you do not need a CSV parser.
Do skip the header row.

---

## What to build

Implement `ingest()` in `starter/src/ingest.ts`:

```ts
export function ingest(options: {
  ordersPath: string;
  customersPath: string;
}): Report;
```

**Do not change that signature.** I call it directly with my own input files
when I grade. Everything else in the file is yours to restructure — the
suggested helper functions are suggestions.

It returns:

```jsonc
{
  "orders": [
    {
      "orderId":      "ORD-0001",
      "customerId":   "C0000001",
      "customerName": "Jānis Bērziņš",   // correctly decoded, trimmed
      "orderDate":    "2026-09-01",      // ISO-8601 calendar date
      "amount":       "1234.56",         // decimal STRING, never a number
      "currency":     "EUR"
    }
  ],
  "rejected": [
    { "line": 6, "raw": "ORD-0006  C0000006  Ilze V", "reason": "expected 77 characters, got 26" }
  ],
  "unmatchedCustomers": ["C0000009"]     // in the CSV, on no accepted order
}
```

`npm start` writes exactly this to `pa1/out/report.json`, so you can look at
what you produced. The graded artefact is the code, not the file.

---

## Running it

```bash
cd pa1/starter
npm ci
npm test          # the public tests. Run them constantly
npm start         # writes ../out/report.json
npm run typecheck # tsc --noEmit over your code
```

Windows: no `make` needed anywhere in this assignment, and no Docker.

---

## Where to start

The tests will cascade at first — one crash takes the whole run down and you
get twenty identical failures. That is not the tests being unhelpful, it is
your program stopping at the first bad record. Work in this order:

1. **Stop it crashing.** Line 6 of the order file is a truncated record. Put it
   in `rejected` with its line number and a reason, and carry on. Nothing
   downstream works until one bad line stops killing the run.
2. **Fix the encoding.** Names will be full of `?` or `�`. `TextDecoder` knows
   the label `"windows-1257"`; read the file as bytes, not as a string.
3. **Fix the dates.** `DD.MM.YYYY` → `YYYY-MM-DD`. String work, not `Date`.
4. **Fix the amounts.** Comma to full stop, and keep it a string.
5. **The customer master.** Which customers never appear on an order?

Each step turns a block of tests green. If you are stuck for more than thirty
minutes, ask — see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## Rules

**No parsing, CSV or encoding dependencies.** Everything this assignment needs
is in the Node standard library, and a public test checks that `dependencies`
in `package.json` is empty. Reaching for `iconv-lite` takes ninety seconds and
removes the entire point of the week.

You may of course read documentation, and you may use AI tools — but see
[SYLLABUS.md](../SYLLABUS.md) §12: you have to be able to defend every line in
November, on your own code, with a fault planted in it.

---

## What is tested

Public tests (`tests/public/`, run them yourself) check that:

- `Bērziņš` and `Šmite` decode correctly, and nothing anywhere contains `�`
- trailing padding is stripped from every field
- `01.09.2026` becomes `2026-09-01` — not 9 January, and with no time or timezone
- `1234,56` becomes the string `"1234.56"`
- **trailing zeros survive**: `45,20` stays `"45.20"`, not `45.2`
- the **negative** amount is present and not silently dropped
- the malformed record lands in `rejected`, with a line number and a reason
- every line in the file is accounted for — nothing silently disappears
- the customer with no orders is reported
- `docs/adr-000.md` exists with its four sections

**Hidden tests** also run at grading time. They are never published, they test
the same requirements as the public ones, and they exist so that code written
to satisfy the visible tests specifically does not score well. If your
implementation is correct rather than tuned to the fixtures, you will not
notice they exist.

---

## Your ADR

`docs/adr-000.md`, four sections, one page. **It is 30% of this assignment's
mark**, so it is worth twenty minutes of real thought rather than five of
filler.

The question it is really asking:

> Reading another system's raw file export is the fastest thing you can do, and
> it is wrong. Where specifically did it bite you — and what would you build
> instead if you had to run this for five years?

The template has prompts under each heading. Write it after the code, while the
annoyance is still fresh.

---

## Submitting

Your work goes in **your** repository, not this one:

```text
eai-2026-<surname>/
  pa1/
    data/          unchanged, as given
    starter/       your implementation
    tests/public/  unchanged, as given
    docs/adr-000.md
```

Then submit your repository URL through the portal at
**<https://evaluentis.leitass.eu>**. Never by email.

The graded commit is the SHA at `HEAD` **when you submit** — later pushes are
not seen. Run `npm test` one more time before you do.

---

## Common ways to lose marks

| | |
|---|---|
| `readFileSync(path, "utf8")` on the order file | The names come out wrong and nothing throws. This is the whole assignment |
| `parseFloat` on the amount | `45,20` becomes `45.2` and `7800,00` becomes `7800`. That is money you deleted |
| `new Date("01.09.2026")` | Ambiguous parsing, plus a timezone on a value that has none |
| Skipping the malformed line with `continue` | Silent data loss. Reject it *visibly* |
| Filtering out the negative amount | It is a refund. It is real |
| `line.split(/\s+/)` | The names contain spaces. Fixed-width means slice by column |
| Committing `node_modules/` or `out/` | Both are ignored by `pa1/.gitignore`. Leave it in place |
| An ADR that restates this README | 30% of the mark, and I have read this README |
