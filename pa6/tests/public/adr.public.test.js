const fs = require('fs');
const path = require('path');

// pa6/tests/public -> ../.. -> pa6/
const ROOT = path.resolve(__dirname, '..', '..');

describe('assignment requirements', () => {
  test('has an ADR with the four required sections', () => {
    const adr = fs.readFileSync(path.resolve(ROOT, 'docs', 'adr-005.md'), 'utf8');
    expect(adr).toContain('## Context');
    expect(adr).toContain('## Decision');
    expect(adr).toContain('## Alternatives considered');
    expect(adr).toContain('## Consequences');
  });
});
