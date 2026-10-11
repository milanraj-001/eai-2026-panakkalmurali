# The canonical model

This folder contains **one file**:

```
order.schema.json     the canonical order — a JSON Schema
```

It shipped with **PA4 on 2026-09-30** and does not change after that.

---

## Why it is a folder of its own

From PA4 onward every assignment reads or writes the same order shape:

| | |
|---|---|
| **PA4** | three unrelated input formats → this schema |
| **PA5** | the events you publish carry this shape |
| **PA6** | your API's `POST /checkout` accepts it |
| **PA7** | the Temporal workflow carries it through the saga |
| **capstone** | end to end, all of the above, one shape |

That is the entire argument for a canonical model, and you will feel it rather
than be told it: PA5 through PA8 do not require a single new translator,
because PA4 already did that work once. Systems that skip this step write
`n × (n−1)` translators instead of `2n`, and then maintain them.

**The schema is mine, not yours.** You do not design it and you do not get to
adjust it to suit your implementation — that is deliberate. Conforming to a
canonical model somebody else owns, including the parts of it you would have
designed differently, is the actual job.

---

## It is here now, and it is final

`order.schema.json` shipped with PA4 and will not change for the rest of the
semester — not to make your PA4 implementation easier, not to accommodate a
field PA6 turns out to want, not for any reason. That is not carelessness:
a canonical model that changes underneath its consumers is the exact failure
this course spends a session on (schema evolution, the tolerant reader).
Freezing it here means the version of that problem you meet in PA5–PA8 is the
realistic one — an old client against a schema that has moved on — not one of
my own making.

Two decisions in it are worth stating explicitly, because they were made for
you rather than derived from any one source format:

- **Every monetary amount (`unitPrice`) is a decimal STRING**, matching
  `^-?[0-9]+\.[0-9]{2}$`, never a JSON number. PA1 already established this
  for `amount`; the reason is the same one — a float silently drops the
  trailing zero a currency needs, and there is no way to get it back once it
  is gone.
- **There is no field, anywhere in this schema, for payment details.** Every
  PA4 source carries some (a card number, an IBAN); the schema's
  `additionalProperties: false` — on the order, on `customer`, and on each
  item — means a translator that forgets to strip one does not just leave the
  data somewhere untidy, it fails validation outright.

If you find a field you would have designed differently, that is normal, and
it is also not a bug report — see the paragraph above about whose schema this
is.
