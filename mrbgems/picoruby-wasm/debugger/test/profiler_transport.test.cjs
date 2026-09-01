const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { ProfilerTransport } = require('../profiler_transport.js');

test('uses the dedicated C API with bounded numeric arguments', async () => {
  const calls = [];
  const transport = new ProfilerTransport(async code => {
    calls.push(code);
    return { schema_version: 1 };
  });
  await transport.fetchSnapshot(-1, 999);
  assert.match(calls[0], /\[0, 200\]/);
  assert.match(calls[0], /mrb_funicular_profiler_snapshot/);
  await transport.fetchSnapshot(Infinity, NaN);
  assert.match(calls[1], /\[0, 200\]/);
  await transport.fetchSnapshot(2 ** 40, 1);
  assert.match(calls[2], /\[4294967295, 1\]/);
});

test('allows only fixed control commands', async () => {
  const transport = new ProfilerTransport(async code => ({ code }));
  await assert.rejects(transport.control('destroy'), /unknown_command/);
  const result = await transport.control('clear');
  assert.match(result.code, /\['clear'\]/);
});

test('propagates eval errors and rejects invalid results', async () => {
  const failed = new ProfilerTransport(async () => { throw new Error('eval failed'); });
  await assert.rejects(failed.fetchSummary(), /devtools_eval_error/);
  const invalid = new ProfilerTransport(async () => 'not an object');
  await assert.rejects(invalid.fetchSummary(), /protocol_error/);
});

test('distinguishes module, C call, and JSON failures', async () => {
  const runWith = picorubyModule => code => vm.runInNewContext(code, {
    window: { picorubyModule },
  });
  assert.equal((await new ProfilerTransport(runWith(undefined)).fetchSummary()).error,
    'module_unavailable');
  assert.equal((await new ProfilerTransport(runWith({})).fetchSummary()).error,
    'debug_api_unavailable');
  assert.equal((await new ProfilerTransport(runWith({
    ccall() { throw new Error('bridge failed'); },
  })).fetchSummary()).error, 'ccall_error');
  assert.equal((await new ProfilerTransport(runWith({
    ccall() { return '{'; },
  })).fetchSummary()).error, 'invalid_json');
});

test('allows only one transport request at a time', async () => {
  let resolve;
  const transport = new ProfilerTransport(() => new Promise(done => { resolve = done; }));
  const pending = transport.fetchSummary();
  await assert.rejects(transport.fetchSummary(), /request_in_flight/);
  resolve({ schema_version: 1 });
  assert.deepEqual(await pending, { schema_version: 1 });
});

test('fetches at most five snapshot pages per cycle', async () => {
  const transport = new ProfilerTransport(async () => ({}));
  const cursors = [];
  transport.fetchSnapshot = async cursor => {
    cursors.push(cursor);
    return { next_cursor: cursor + 1 };
  };
  const result = await transport.fetchSnapshotPages(0, 0,
    () => ({ hasMore: true }));
  assert.deepEqual(result, { hasMore: true, pages: 5 });
  assert.deepEqual(cursors, [0, 1, 2, 3, 4]);
});

test('ignores stale generation responses after reload or clear', async () => {
  let resolve;
  const transport = new ProfilerTransport(() => new Promise(done => { resolve = done; }));
  const pending = transport.fetchSummary(transport.generation);
  transport.resetGeneration();
  resolve({ schema_version: 1 });
  assert.equal(await pending, null);

  const rejected = new ProfilerTransport(() => new Promise((_, reject) => {
    resolve = reject;
  }));
  const staleFailure = rejected.fetchSummary(rejected.generation);
  rejected.resetGeneration();
  resolve(new Error('old page failed'));
  assert.equal(await staleFailure, null);
});

test('checks availability through the debug-only symbol', async () => {
  const transport = new ProfilerTransport(async code => ({
    available: code.includes('_mrb_funicular_profiler_available'),
  }));
  assert.deepEqual(await transport.checkProfilerAvailability(), { available: true });
});
