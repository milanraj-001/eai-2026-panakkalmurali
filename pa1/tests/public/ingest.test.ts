/**
 * PA1 public tests.
 *
 * These are the same tests I run when I grade, plus hidden ones you do not
 * see. Run them as often as you like: `npm test` in pa1/starter.
 *
 * They test ingest() through its published contract only. How you structure
 * the inside is up to you.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ingest, type Order, type Report } from "../../starter/src/ingest";

const PA1_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ORDERS = path.join(PA1_ROOT, "data", "orders-20260901.txt");
const CUSTOMERS = path.join(PA1_ROOT, "data", "customers.csv");

// Evaluated lazily and once, so that an unimplemented ingest() shows up as a
// list of named failing tests rather than a single dead suite.
let cached: Report | undefined;
const report = (): Report => {
  cached ??= ingest({ ordersPath: ORDERS, customersPath: CUSTOMERS });
  return cached;
};

const byId = (id: string): Order => {
  const found = report().orders.find((o) => o.orderId === id);
  if (!found) {
    throw new Error(
      `no order ${id} in the report. Got: ${report().orders.map((o) => o.orderId).join(", ") || "(none)"}`,
    );
  }
  return found;
};

describe("the report as a whole", () => {
  it("accepts the nine well-formed orders", () => {
    expect(report().orders).toHaveLength(9);
  });

  it("returns arrays for every section, even when empty", () => {
    expect(Array.isArray(report().orders)).toBe(true);
    expect(Array.isArray(report().rejected)).toBe(true);
    expect(Array.isArray(report().unmatchedCustomers)).toBe(true);
  });
});

describe("encoding — the file is CP1257, not UTF-8", () => {
  it("decodes Bērziņš correctly", () => {
    expect(byId("ORD-0001").customerName).toBe("Jānis Bērziņš");
  });

  it("decodes Šmite correctly", () => {
    expect(byId("ORD-0002").customerName).toBe("Anna Šmite");
  });

  it("decodes every Latvian diacritic in the file", () => {
    expect(byId("ORD-0004").customerName).toBe("Līga Ozoliņa");
    expect(byId("ORD-0005").customerName).toBe("Kārlis Krūmiņš");
    expect(byId("ORD-0007").customerName).toBe("Ilze Vītola");
    expect(byId("ORD-0008").customerName).toBe("Pēteris Ozols");
    expect(byId("ORD-0009").customerName).toBe("Marta Liepiņa");
  });

  it("produces no replacement characters anywhere", () => {
    // U+FFFD is what you get when bytes are decoded as the wrong encoding.
    const everything = JSON.stringify(report());
    expect(everything).not.toContain("�");
  });

  it("does not mistake the file for Latin-1 either", () => {
    // Reading CP1257 as latin1 keeps the columns but corrupts the letters:
    // 0xE2 becomes "â" rather than "ā".
    expect(byId("ORD-0001").customerName).not.toBe("Jânis Bçrziòð");
  });
});

describe("fixed-width fields", () => {
  it("strips the trailing space padding", () => {
    for (const order of report().orders) {
      expect(order.customerName).toBe(order.customerName.trim());
      expect(order.orderId).toBe(order.orderId.trim());
      expect(order.customerId).toBe(order.customerId.trim());
      expect(order.currency).toBe(order.currency.trim());
    }
  });

  it("reads each field from its own columns", () => {
    const order = byId("ORD-0003");
    expect(order.customerId).toBe("C0000003");
    expect(order.customerName).toBe("Roberts Zvirbulis");
    expect(order.currency).toBe("EUR");
  });
});

describe("dates — DD.MM.YYYY becomes ISO-8601", () => {
  it("converts the day/month order correctly", () => {
    // 01.09.2026 is 1 September, not 9 January.
    expect(byId("ORD-0001").orderDate).toBe("2026-09-01");
    expect(byId("ORD-0009").orderDate).toBe("2026-09-04");
    expect(byId("ORD-0010").orderDate).toBe("2026-09-05");
  });

  it("emits a plain calendar date, with no time and no timezone", () => {
    for (const order of report().orders) {
      expect(order.orderDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("amounts — decimal strings, not floats", () => {
  it("converts the comma decimal separator", () => {
    expect(byId("ORD-0001").amount).toBe("1234.56");
  });

  it("is a string, not a number", () => {
    for (const order of report().orders) {
      expect(typeof order.amount).toBe("string");
    }
  });

  it("keeps trailing zeros that a float would drop", () => {
    // Every one of these changes if the value goes through parseFloat:
    // 45.2, 7800, 15, 89.
    expect(byId("ORD-0008").amount).toBe("45.20");
    expect(byId("ORD-0009").amount).toBe("7800.00");
    expect(byId("ORD-0010").amount).toBe("15.00");
    expect(byId("ORD-0002").amount).toBe("89.00");
  });

  it("keeps the negative amount instead of dropping it", () => {
    // ORD-0004 is a refund. It is money and it is real.
    expect(byId("ORD-0004").amount).toBe("-250.00");
  });

  it("has not silently filtered anything out", () => {
    const total = report().orders.length + report().rejected.length;
    expect(total).toBe(10); // every line in the file is accounted for
  });
});

describe("malformed records", () => {
  it("rejects the truncated line instead of throwing", () => {
    expect(report().rejected).toHaveLength(1);
  });

  it("reports which line it was", () => {
    expect(report().rejected[0]?.line).toBe(6);
  });

  it("gives a reason and keeps the raw line", () => {
    const bad = report().rejected[0]!;
    expect(typeof bad.reason).toBe("string");
    expect(bad.reason.length).toBeGreaterThan(0);
    expect(bad.raw).toContain("ORD-0006");
  });

  it("does not leak the malformed record into orders", () => {
    expect(report().orders.some((o) => o.orderId === "ORD-0006")).toBe(false);
  });
});

describe("the customer master", () => {
  it("reports the customer who has no orders", () => {
    expect(report().unmatchedCustomers).toEqual(["C0000009"]);
  });

  it("does not report customers who do have orders", () => {
    expect(report().unmatchedCustomers).not.toContain("C0000001");
  });
});

describe("assignment requirements", () => {
  it("has an ADR with the four required sections", () => {
    const adr = readFileSync(path.join(PA1_ROOT, "docs", "adr-000.md"), "utf8");
    expect(adr).toContain("## Context");
    expect(adr).toContain("## Decision");
    expect(adr).toContain("## Alternatives considered");
    expect(adr).toContain("## Consequences");
  });

  it("adds no runtime dependency", () => {
    // Everything this assignment needs is in the Node standard library.
    // Reaching for iconv-lite or a CSV parser removes the point of it.
    const pkg = JSON.parse(
      readFileSync(path.join(PA1_ROOT, "starter", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
