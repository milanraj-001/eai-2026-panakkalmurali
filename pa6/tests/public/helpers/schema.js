const fs = require('fs');
const path = require('path');
// The grading schemas declare "$schema": ".../draft/2020-12/schema". The
// plain `Ajv` export only knows the draft-07 meta-schema, so compiling any
// of them throws `no schema with key or ref ".../draft/2020-12/schema"`.
// Ajv2020 is the same engine with the 2020-12 meta-schema registered; the
// keywords these schemas actually use (type, required, properties, enum,
// additionalProperties, format, minLength, minimum) behave identically
// under both drafts, so this changes no validation behavior.
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(relativePath) {
  // pa6/tests/public/helpers -> ../../../grading/schema -> pa6/grading/schema
  const absolute = path.resolve(__dirname, '..', '..', '..', 'grading', 'schema', relativePath);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

const traceItemSchema = loadSchema('trace-item.schema.json');
const checkoutResponseSchema = loadSchema('checkout-response.schema.json');
const idempotencyStoreSchema = loadSchema('idempotency-store.schema.json');
const sagaStoreSchema = loadSchema('saga-store.schema.json');

// checkout-response and saga-store both $ref "trace-item.schema.json" by
// bare filename (neither file declares an $id). Register it under that
// exact key so ajv can resolve the ref instead of throwing at compile time.
ajv.addSchema(traceItemSchema, 'trace-item.schema.json');

const validateCheckoutResponse = ajv.compile(checkoutResponseSchema);
const validateIdempotencyStore = ajv.compile(idempotencyStoreSchema);
const validateSagaStore = ajv.compile(sagaStoreSchema);

function assertValid(validator, payload) {
  const ok = validator(payload);
  if (!ok) {
    const text = JSON.stringify(validator.errors || []);
    throw new Error(`Schema validation failed: ${text}`);
  }
}

module.exports = {
  assertValid,
  validateCheckoutResponse,
  validateIdempotencyStore,
  validateSagaStore
};
