/**
 * PA1 — legacy file ingestion.
 *
 * You are reading two files that a system you do not control exports for you:
 *
 *   data/orders-20260901.txt   fixed-width, CP1257 ("windows-1257")
 *   data/customers.csv         semicolon-separated, UTF-8
 *
 * Yes, two different encodings in one integration. That is not a trick I
 * invented; it is Tuesday.
 *
 * Everything you need is in the Node standard library. Do not add a parsing,
 * CSV or encoding dependency — feeling where these files fight back is the
 * entire point of the assignment, and a public test checks for it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------- contract --
// The grader calls ingest() directly, with its own input files. Do not change
// its name, its parameters or the shape of what it returns. Everything else in
// this file is yours to restructure.

export interface Order {
  orderId: string;
  customerId: string;
  /** Correctly decoded and trimmed. "Bērziņš", never "B?rzi??". */
  customerName: string;
  /** ISO-8601 calendar date: "2026-09-01". */
  orderDate: string;
  /** Decimal STRING, never a number: "1234.56", "-250.00", "0.00". */
  amount: string;
  currency: string;
}

export interface RejectedRecord {
  /** 1-based line number in the orders file. */
  line: number;
  /** The offending line, as you decoded it. */
  raw: string;
  /** Why you rejected it, in plain language. */
  reason: string;
}

export interface Report {
  orders: Order[];
  rejected: RejectedRecord[];
  /** Customer ids that appear in the CSV but on no accepted order. */
  unmatchedCustomers: string[];
}

export interface IngestOptions {
  ordersPath: string;
  customersPath: string;
}

// ------------------------------------------------------------------ layout --
// The order file is fixed-width. Every field is LEFT-aligned and padded with
// trailing spaces. Slice by position — you cannot split on whitespace, because
// the names contain spaces.
//
//   field         columns (0-indexed, end exclusive)   width
//   orderId        0 .. 10                               10
//   customerId    10 .. 20                               10
//   customerName  20 .. 52                               32
//   orderDate     52 .. 62                               10   DD.MM.YYYY
//   amount        62 .. 74                               12   comma decimal
//   currency      74 .. 77                                3
//
// A well-formed line is exactly 77 characters.

export const ORDER_LAYOUT = {
  orderId: [0, 10],
  customerId: [10, 20],
  customerName: [20, 52],
  orderDate: [52, 62],
  amount: [62, 74],
  currency: [74, 77],
} as const;

export const ORDER_LINE_LENGTH = 77;

// ------------------------------------------------------------------- paths --
// Resolved from this file's own location, so the program behaves the same
// whichever directory you run it from.

const PA1_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const DEFAULT_ORDERS_PATH = path.join(PA1_ROOT, "data", "orders-20260901.txt");
export const DEFAULT_CUSTOMERS_PATH = path.join(PA1_ROOT, "data", "customers.csv");
export const OUTPUT_PATH = path.join(PA1_ROOT, "out", "report.json");

// ------------------------------------------------------------------- steps --
// Suggested decomposition. Only ingest() is contractual — if you would rather
// structure this differently, do, and say why in your ADR.

/**
 * Turn the raw bytes of the order export into text.
 *
 * TODO: The file is CP1257. Node will happily read it as UTF-8 and give you
 * something that looks almost right, which is worse than an error. Decode it
 * properly. `TextDecoder` knows the label "windows-1257" — no dependency needed.
 */
export function decodeOrderFile(bytes: Buffer): string {
  const decoder = new TextDecoder("windows-1257");
  return decoder.decode(bytes);
}

/**
 * "01.09.2026" -> "2026-09-01"
 *
 * TODO: Convert to an ISO-8601 calendar date. Do not route this through
 * `new Date(...)`: that parses ambiguously and drags a timezone into a value
 * that does not have one.
 */
export function toIsoDate(ddmmyyyy: string): string {
  const [day, month, year] = ddmmyyyy.split(".");
  return `${year}-${month}-${day}`;
}
/**
 * "1234,56" -> "1234.56"   "-250,00" -> "-250.00"   "0,00" -> "0.00"
 *
 * TODO: Return a decimal STRING. The moment this value becomes a float you
 * have lost information you cannot get back: "45,20" becomes 45.2 and
 * "7800,00" becomes 7800. Money does not survive a round trip through
 * parseFloat, and a test checks exactly that.
 */
export function toDecimalString(amount: string): string {
  return amount.replace(",", ".");
}
/**
 * Parse the semicolon-separated customer master into id -> full name.
 *
 * TODO: This file is UTF-8, unlike the order file. No field contains a
 * semicolon or a quote, so you do not need a CSV parser — but do skip the
 * header row.
 */
export function parseCustomers(csv: string): Map<string, string> {
  const lines = csv.split(/\r?\n/).filter((line) => line.length > 0);
  const map = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const fields = line.split(";");
    const customerId = fields[0]!.trim();
    const fullName = fields[1]!.trim();
    map.set(customerId, fullName);
  }
  return map;
}

// ------------------------------------------------------------------ ingest --

/**
 * Read both files and produce the report.
 *
 * TODO: Put it together.
 *
 *   - Read the orders file as BYTES and decode it (decodeOrderFile).
 *   - Split into lines. Watch out: the file may use LF or CRLF endings, and
 *     the last line may or may not be followed by a newline.
 *   - For each line, slice the fields by position and trim them.
 *   - A line that is not exactly ORDER_LINE_LENGTH characters is malformed:
 *     push it to `rejected` with its 1-based line number and a reason. Do not
 *     throw, and do not silently drop it.
 *   - Negative amounts are real. They are refunds. Keep them.
 *   - Collect the customer ids from the CSV that no accepted order refers to
 *     into `unmatchedCustomers`.
 */
export function ingest(options: IngestOptions): Report {
  const bytes = readFileSync(options.ordersPath);
  const text = decodeOrderFile(bytes);
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);

  const orders: Order[] = [];
  const rejected: RejectedRecord[] = [];

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (line.length !== ORDER_LINE_LENGTH) {
      rejected.push({
        line: lineNumber,
        raw: line,
        reason: `expected ${ORDER_LINE_LENGTH} characters, got ${line.length}`,
      });
      return;
    }

    const [oIdStart, oIdEnd] = ORDER_LAYOUT.orderId;
    const [cIdStart, cIdEnd] = ORDER_LAYOUT.customerId;
    const [nameStart, nameEnd] = ORDER_LAYOUT.customerName;
    const [dateStart, dateEnd] = ORDER_LAYOUT.orderDate;
    const [amtStart, amtEnd] = ORDER_LAYOUT.amount;
    const [curStart, curEnd] = ORDER_LAYOUT.currency;

    orders.push({
      orderId: line.slice(oIdStart, oIdEnd).trim(),
      customerId: line.slice(cIdStart, cIdEnd).trim(),
      customerName: line.slice(nameStart, nameEnd).trim(),
      orderDate: toIsoDate(line.slice(dateStart, dateEnd).trim()),
      amount: toDecimalString(line.slice(amtStart, amtEnd).trim()),
      currency: line.slice(curStart, curEnd).trim(),
    });
  });

  const customersCsv = readFileSync(options.customersPath, "utf8");
  const customerMap = parseCustomers(customersCsv);

  const orderedCustomerIds = new Set(orders.map((o) => o.customerId));
  const unmatchedCustomers = [...customerMap.keys()].filter(
    (id) => !orderedCustomerIds.has(id),
  );

  return { orders, rejected, unmatchedCustomers };
}
// -------------------------------------------------------------------- main --

/** Writes the report to pa1/out/report.json. Run with: npm start */
export function main(): void {
  const report = ingest({
    ordersPath: DEFAULT_ORDERS_PATH,
    customersPath: DEFAULT_CUSTOMERS_PATH,
  });

  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + "\n", "utf8");

  console.log(
    `wrote ${OUTPUT_PATH}\n` +
      `  ${report.orders.length} orders\n` +
      `  ${report.rejected.length} rejected\n` +
      `  ${report.unmatchedCustomers.length} customers with no order`,
  );
}

// Only run main() when this file is executed directly, not when it is imported
// by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
