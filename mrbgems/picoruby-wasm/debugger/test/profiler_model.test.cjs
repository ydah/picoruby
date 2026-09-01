const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ProfilerModel } = require('../profiler_model.js');

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'profiler_v1.json'), 'utf8'
)).snapshot;

const snapshot = overrides => Object.assign({}, fixture, overrides || {});

test('applies initial and duplicate snapshots', () => {
  const model = new ProfilerModel();
  assert.deepEqual(model.applySnapshot(fixture), { hasMore: false, added: 2 });
  assert.equal(model.cursor, 2);
  assert.equal(model.records.length, 2);
  assert.equal(model.applySnapshot(snapshot({ cursor: 2 })).added, 0);
  assert.equal(model.records.length, 2);
});

test('resets records when the session changes', () => {
  const model = new ProfilerModel();
  model.applySnapshot(fixture);
  assert.deepEqual(model.applySnapshot(snapshot({ session_id: 4, cursor: 2,
    next_cursor: 2, records: [] })),
  { hasMore: true, added: 0, sessionReset: true });
  assert.equal(model.sessionId, 4);
  assert.equal(model.cursor, 0);
  assert.equal(model.records.length, 0);
  model.applySnapshot(snapshot({ session_id: 4, cursor: 0, next_cursor: 1,
    records: [fixture.records[0]] }));
  assert.equal(model.records.length, 1);
});

test('rejects mismatched cursors without partially applying records', () => {
  const model = new ProfilerModel();
  const bad = snapshot({ cursor: 1, next_cursor: 3,
    records: [Object.assign({}, fixture.records[0], { seq: 3, id: 's-3' })] });
  assert.throws(() => model.applySnapshot(bad), /cursor mismatch/);
  assert.equal(model.records.length, 0);
  assert.equal(model.cursor, 0);
});

test('marks cursor gaps and rejects a stuck pagination cursor', () => {
  const model = new ProfilerModel();
  model.applySnapshot(fixture);
  model.applySnapshot(snapshot({ cursor_gap: true, cursor: 2, next_cursor: 3,
    records: [Object.assign({}, fixture.records[0], { seq: 3, id: 's-3' })] }));
  assert.equal(model.cursorGap, true);
  assert.equal(model.records.length, 1);
  assert.throws(() => model.applySnapshot(snapshot({ cursor: 3, next_cursor: 3,
    has_more: true, records: [] })), /cursor did not advance/);
});

test('bounds records and removes evicted records from the index', () => {
  const model = new ProfilerModel({ maxRecords: 1 });
  model.applySnapshot(fixture);
  assert.equal(model.records.length, 1);
  assert.equal(model.recordById.has('s-1'), false);
  assert.equal(model.records[0].parent_id, 's-1');
  assert.equal(model.clientEvictedCount, 1);
});

test('filters timeline and aggregates the bounded window', () => {
  const model = new ProfilerModel();
  model.applySnapshot(fixture);
  model.setFilters({ name: 'diff', component: 'product', status: 'error' });
  assert.deepEqual(model.visibleRecords().map(record => record.id), ['s-2']);
  const update = model.summaryRows().find(row => row.name.endsWith('update'));
  assert.equal(update.count, 1);
  assert.equal(update.empty_diff_rate, 1);
  assert.equal(update.p95_us, 200);
});

test('sorts the timeline by start time and then sequence', () => {
  const model = new ProfilerModel();
  const earlier = Object.assign({}, fixture.records[0], {
    seq: 3, id: 's-3', started_at_us: 900,
  });
  const tied = Object.assign({}, fixture.records[0], {
    seq: 4, id: 's-4', started_at_us: 1000,
  });
  model.applySnapshot(snapshot({
    next_cursor: 4,
    records: [tied, fixture.records[1], earlier, fixture.records[0]],
  }));
  assert.deepEqual(model.visibleRecords().map(record => record.id),
    ['s-3', 's-1', 's-4', 's-2']);
});

test('uses stable summary sorting', () => {
  const model = new ProfilerModel();
  const group = name => ({ name, component_class: '', count: 1, error_count: 0,
    empty_diff_count: 0, total_us: 10, max_us: 10, p50_us: 10, p95_us: 10 });
  model.applySummary({ schema_version: 1, session_id: 1, recording: false,
    groups: [group('a'), group('b')] });
  assert.deepEqual(model.summaryRows().map(row => row.name), ['a', 'b']);
});

test('rejects malformed summaries without clearing valid records', () => {
  const model = new ProfilerModel();
  model.applySnapshot(fixture);
  assert.throws(() => model.applySummary({ schema_version: 1,
    session_id: 'new', recording: false, groups: [] }), /session_id/);
  assert.equal(model.sessionId, 3);
  assert.equal(model.records.length, 2);
});

test('skips malformed records and rejects unsupported schemas', () => {
  const model = new ProfilerModel();
  const malformed = Object.assign({}, fixture.records[0], { status: 'wat' });
  const nested = Object.assign({}, fixture.records[0], { seq: 2, id: 'nested',
    attributes: { bad: [[1]] } });
  const tooMany = Object.assign({}, fixture.records[0], { seq: 3, id: 'many',
    attributes: Object.fromEntries(Array.from({ length: 25 }, (_, i) => ['k' + i, i])) });
  model.applySnapshot(snapshot({ records: [malformed, nested, tooMany], next_cursor: 0 }));
  assert.equal(model.protocolWarningCount, 3);
  assert.throws(() => model.applySnapshot(snapshot({ schema_version: 2 })),
    /unsupported_schema/);
  assert.throws(() => model.applySnapshot(snapshot({ recording: 'yes' })),
    /snapshot fields/);
  assert.throws(() => model.applySummary({ schema_version: 1, session_id: 1,
    recording: false, groups: null }), /summary fields/);
});

test('exports versioned incomplete profiles', () => {
  const model = new ProfilerModel({ maxRecords: 1 });
  model.applySnapshot(snapshot({ dropped_count: 4, profiler_version: '0.1.0' }));
  const exported = model.exportObject({ pico_ruby_debugger_version: '0.2.1' });
  assert.equal(exported.format_version, 1);
  assert.equal(exported.incomplete, true);
  assert.equal(exported.records.length, 1);
  assert.equal(exported.profiler_version, '0.1.0');
  assert.equal(exported.pico_ruby_debugger_version, '0.2.1');

  const inFlight = new ProfilerModel();
  inFlight.applySnapshot(snapshot({ dropped_count: 0, dropped_in_flight_count: 1 }));
  assert.equal(inFlight.exportObject().incomplete, true);
});

test('preserves bounded profiler metadata without inventing a version', () => {
  const model = new ProfilerModel();
  model.applySummary({ schema_version: 1, session_id: 1, recording: false,
    profiler_version: '0.1.0', groups: [] });
  model.applySnapshot(snapshot({ session_id: 1 }));
  assert.equal(model.exportObject().profiler_version, '0.1.0');

  const unknown = new ProfilerModel();
  assert.equal(Object.hasOwn(unknown.exportObject(), 'profiler_version'), false);
  assert.throws(() => unknown.applySummary({ schema_version: 1, session_id: 1,
    recording: false, profiler_version: 'x'.repeat(65), groups: [] }),
  /profiler_version/);
});

test('formats loading, reconnecting, and export filename states', () => {
  const model = new ProfilerModel();
  assert.equal(model.statusText(), 'Loading...');
  model.connectionState = 'reconnecting';
  assert.equal(model.statusText(), 'Reconnecting...');
  assert.equal(ProfilerModel.exportFilename(new Date('2026-09-01T12:34:56Z')),
    'funicular-profile-20260901-123456.json');
});

test('copies attribute arrays at the protocol boundary', () => {
  const model = new ProfilerModel();
  const values = ['safe'];
  const record = Object.assign({}, fixture.records[0], { attributes: { values } });
  model.applySnapshot(snapshot({ records: [record], next_cursor: 1 }));
  values[0] = '<mutated>';
  assert.deepEqual(model.records[0].attributes.values, ['safe']);
});

test('formats integer microseconds', () => {
  assert.equal(ProfilerModel.formatDuration(999), '999 µs');
  assert.equal(ProfilerModel.formatDuration(1000), '1.00 ms');
  assert.equal(ProfilerModel.formatDuration(1000000), '1.00 s');
});
