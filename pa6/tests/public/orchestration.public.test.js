/* eslint-disable no-console */
/**
 * PA6 public tests. They need the stack from pa6/docker-compose.yml running
 * (`docker compose up -d --build --wait`), and they talk to it on localhost.
 *
 * Every checkout uses a fresh orderId and a fresh Idempotency-Key, so the
 * suite can be run as often as you like without resetting the stores.
 * Each test sets the mock services' fail modes it needs through their
 * /admin/config endpoints and reads back what they were called with from
 * /admin/logs.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { checkout, health, resetMock, getMockLogs, configureMock } = require('./helpers/api');
const { assertValid, validateCheckoutResponse, validateIdempotencyStore, validateSagaStore } = require('./helpers/schema');
const { measure, sleep } = require('./helpers/timing');

// pa6/tests/public -> ../.. -> pa6/
const ROOT = path.resolve(__dirname, '..', '..');
const IDEMPOTENCY_STORE = path.resolve(ROOT, 'orchestrator', 'data', 'idempotency-store.json');
const SAGA_STORE = path.resolve(ROOT, 'orchestrator', 'data', 'saga-store.json');
const ORCHESTRATOR_CONTAINER = 'pa6-orchestrator';

const PAYMENT_URL = process.env.PAYMENT_URL || 'http://localhost:4001';
const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:4002';
const SHIPPING_URL = process.env.SHIPPING_URL || 'http://localhost:4003';
const NOTIFICATION_URL = process.env.NOTIFICATION_URL || 'http://localhost:4004';

const FORWARD_STEPS = ['payment', 'inventory', 'shipping', 'notification'];

// A canonical order: 2 x "22.50" + 1 x "18.90" = "63.90".
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'order.json'), 'utf8'));

let counter = 0;
function unique() {
  counter += 1;
  return `${Date.now()}-${counter}`;
}

function makeOrder() {
  return { ...JSON.parse(JSON.stringify(FIXTURE)), orderId: `WEB-PA6-${unique()}` };
}

function newKey(label) {
  return `pa6-${label}-${unique()}`;
}

// The amount the orchestrator must send to payment: the sum of
// unitPrice x quantity, in whole cents, as a two-digit decimal string.
function expectedAmount(order) {
  let cents = 0;
  for (const item of order.items) {
    const [whole, fraction] = item.unitPrice.split('.');
    cents += (Number(whole) * 100 + Number(fraction)) * item.quantity;
  }
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function stepNames(trace) {
  return (trace || []).map((t) => t.step);
}

// Fails with the response body in the message, so you can see why.
function expectResponse(res, status) {
  if (res.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

async function logsOf(serviceUrl) {
  const res = await getMockLogs(serviceUrl);
  expect(res.status).toBe(200);
  return res.data?.logs || [];
}

async function actionsOf(serviceUrl) {
  return (await logsOf(serviceUrl)).map((entry) => entry.action);
}

function loadStore(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function waitUntil(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function resetAllMocks() {
  await resetMock(PAYMENT_URL);
  await resetMock(INVENTORY_URL);
  await resetMock(SHIPPING_URL);
  await resetMock(NOTIFICATION_URL);

  await configureMock(PAYMENT_URL, {
    paymentFailMode: 'never',
    paymentRefundFailMode: 'never'
  });
  await configureMock(INVENTORY_URL, {
    inventoryFailMode: 'never',
    inventoryReleaseFailMode: 'never'
  });
  await configureMock(SHIPPING_URL, {
    shippingFailMode: 'never',
    shippingDelayMs: 0
  });
  await configureMock(NOTIFICATION_URL, {
    notificationFailMode: 'never'
  });
}

describe('PA6 public orchestration tests', () => {
  jest.setTimeout(120000);

  beforeEach(async () => {
    await resetAllMocks();
    await sleep(150);
  });

  test('1) services start and health checks pass', async () => {
    const orchestratorHealth = await health();
    expect(orchestratorHealth.status).toBe(200);
    expect(orchestratorHealth.data?.status).toBe('ok');

    const mockHealthChecks = await Promise.all([
      axios.get(`${PAYMENT_URL}/health`, { validateStatus: () => true }),
      axios.get(`${INVENTORY_URL}/health`, { validateStatus: () => true }),
      axios.get(`${SHIPPING_URL}/health`, { validateStatus: () => true }),
      axios.get(`${NOTIFICATION_URL}/health`, { validateStatus: () => true })
    ]);
    for (const h of mockHealthChecks) {
      expect(h.status).toBe(200);
      expect(h.data?.status).toBe('ok');
    }
  });

  test('2) happy path runs all four steps in order, with the derived amount and recipient', async () => {
    const order = makeOrder();
    const res = await checkout(order, newKey('happy'));

    expectResponse(res, 200);
    expect(res.data.status).toBe('completed');
    expect(res.data.orderId).toBe(order.orderId);
    assertValid(validateCheckoutResponse, res.data);
    expect(stepNames(res.data.trace)).toEqual(FORWARD_STEPS);
    expect(res.data.trace.map((t) => t.status)).toEqual(['success', 'success', 'success', 'success']);

    const payment = await logsOf(PAYMENT_URL);
    expect(payment.map((e) => [e.action, e.amount])).toEqual([['authorize', expectedAmount(order)]]);
    const notification = await logsOf(NOTIFICATION_URL);
    expect(notification.map((e) => [e.action, e.recipient])).toEqual([['send', order.customer.email]]);
  });

  test('3) payment failure short-circuits: nothing downstream is called', async () => {
    await configureMock(PAYMENT_URL, { paymentFailMode: 'always' });

    const res = await checkout(makeOrder(), newKey('pay-fail'));

    expectResponse(res, 422);
    expect(res.data.status).toBe('failed');
    expect(stepNames(res.data.trace)).toEqual(['payment']);
    expect(res.data.trace[0].status).toBe('failed');

    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize']);
    expect(await actionsOf(INVENTORY_URL)).toEqual([]);
    expect(await actionsOf(SHIPPING_URL)).toEqual([]);
    expect(await actionsOf(NOTIFICATION_URL)).toEqual([]);
  });

  test('4) inventory failure refunds the payment', async () => {
    await configureMock(INVENTORY_URL, { inventoryFailMode: 'always' });

    const res = await checkout(makeOrder(), newKey('inv-fail'));

    expectResponse(res, 422);
    expect(res.data.status).toBe('compensated');
    expect(stepNames(res.data.trace)).toEqual(['payment', 'inventory', 'payment_refund']);

    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize', 'refund']);
    expect(await actionsOf(SHIPPING_URL)).toEqual([]);
    expect(await actionsOf(NOTIFICATION_URL)).toEqual([]);
  });

  test('5) shipping timeout maps to 504 and compensates inventory, then payment', async () => {
    await configureMock(SHIPPING_URL, { shippingDelayMs: 6000, shippingFailMode: 'never' });

    const timed = await measure(() => checkout(makeOrder(), newKey('ship-timeout')));
    const res = timed.result;

    expectResponse(res, 504);
    expect(res.data.code).toBe('timeout');
    expect(res.data.status).toBe('compensated');
    expect(stepNames(res.data.trace)).toEqual([...FORWARD_STEPS.slice(0, 3), 'inventory_release', 'payment_refund']);
    expect(res.data.trace[2].status).toBe('timeout');
    expect(timed.durationMs).toBeLessThan(20000);

    expect(await actionsOf(INVENTORY_URL)).toEqual(['reserve', 'release']);
    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize', 'refund']);
    expect(await actionsOf(NOTIFICATION_URL)).toEqual([]);

    // The slow shipping call is still running inside the mock. Let it land,
    // so it cannot show up in a later test's logs.
    await waitUntil(async () => (await actionsOf(SHIPPING_URL)).length > 0, 10000, 'the delayed shipping call');
  });

  test('6) a failed compensation maps to 422 + compensation_failed', async () => {
    await configureMock(INVENTORY_URL, { inventoryFailMode: 'always', inventoryReleaseFailMode: 'never' });
    await configureMock(PAYMENT_URL, { paymentFailMode: 'never', paymentRefundFailMode: 'always' });

    const res = await checkout(makeOrder(), newKey('comp-fail'));

    expectResponse(res, 422);
    expect(res.data.code).toBe('compensation_failed');
    expect(res.data.status).toBe('failed');
    expect(stepNames(res.data.trace)).toEqual(['payment', 'inventory', 'payment_refund']);
    expect(res.data.trace[2].status).toBe('failed');
  });

  test('7) same key, same payload replays the stored result without running the saga again', async () => {
    const order = makeOrder();
    const key = newKey('replay');

    const first = await checkout(order, key);
    expectResponse(first, 200);
    const second = await checkout(order, key);

    expectResponse(second, 200);
    expect(second.data).toEqual(first.data);
    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize']);
  });

  test('8) same key, different payload returns 409 + idempotency_payload_mismatch', async () => {
    const order = makeOrder();
    const key = newKey('mismatch');

    const first = await checkout(order, key);
    expectResponse(first, 200);

    const changed = JSON.parse(JSON.stringify(order));
    changed.items[0].quantity += 1;
    const mismatch = await checkout(changed, key);

    expectResponse(mismatch, 409);
    expect(mismatch.data.code).toBe('idempotency_payload_mismatch');
    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize']);
  });

  test('9) same key while the first request is still running returns 409 + idempotency_conflict', async () => {
    await configureMock(SHIPPING_URL, { shippingDelayMs: 1500, shippingFailMode: 'never' });
    const order = makeOrder();
    const key = newKey('in-flight');

    const firstPromise = checkout(order, key);
    await sleep(500);
    const second = await checkout(order, key);
    const first = await firstPromise;

    expectResponse(first, 200);
    expectResponse(second, 409);
    expect(second.data.code).toBe('idempotency_conflict');
    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize']);
  });

  test('10) both stores record the finished saga and match their schemas', async () => {
    const order = makeOrder();
    const key = newKey('stores');

    const res = await checkout(order, key);
    expectResponse(res, 200);

    const idempotencyStore = loadStore(IDEMPOTENCY_STORE);
    const sagaStore = loadStore(SAGA_STORE);
    assertValid(validateIdempotencyStore, idempotencyStore);
    assertValid(validateSagaStore, sagaStore);

    const record = idempotencyStore.records[key];
    expect(record).toMatchObject({ state: 'completed', httpStatus: 200 });
    expect(record.response).toEqual(res.data);

    const saga = sagaStore.sagas[order.orderId];
    expect(saga).toMatchObject({ idempotencyKey: key, state: 'completed' });
    expect(stepNames(saga.steps)).toEqual(FORWARD_STEPS);
  });

  test('11) a replay after an orchestrator restart returns the same result', async () => {
    const order = makeOrder();
    const key = newKey('restart');

    const first = await checkout(order, key);
    expectResponse(first, 200);

    execFileSync('docker', ['restart', ORCHESTRATOR_CONTAINER], { stdio: 'pipe' });
    await waitUntil(async () => {
      try {
        return (await health()).status === 200;
      } catch {
        return false;
      }
    }, 30000, 'the orchestrator to come back after a restart');

    const second = await checkout(order, key);
    expectResponse(second, 200);
    expect(second.data).toEqual(first.data);
    expect(await actionsOf(PAYMENT_URL)).toEqual(['authorize']);
  });
});
