import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const [debugPath, releasePath] = process.argv.slice(2);
if (!debugPath || !releasePath) {
  throw new Error('usage: node profiler_bridge_integration.mjs DEBUG_JS RELEASE_WASM');
}

const load = async file => {
  const factory = (await import(pathToFileURL(file))).default;
  return factory({ print() {}, printErr() {} });
};

const debug = await load(debugPath);
assert.equal(debug.ccall('mrb_funicular_profiler_available', 'number', [], []), 0);
assert.equal(JSON.parse(debug.ccall(
  'mrb_funicular_profiler_control', 'string', ['string'], ['unknown']
)).error, 'unknown_command', 'unknown command must not require a VM');
assert.equal(JSON.parse(debug.ccall(
  'mrb_funicular_profiler_control', 'string', ['string'], [null]
)).error, 'unknown_command');
assert.equal(debug.ccall('picorb_init', 'number', [], []), 0);

const evaluate = code => JSON.parse(debug.ccall(
  'mrb_eval_string', 'string', ['string'], [code]
));
const snapshot = (cursor, limit) => JSON.parse(debug.ccall(
  'mrb_funicular_profiler_snapshot', 'string', ['number', 'number'], [cursor, limit]
));
const summary = () => JSON.parse(debug.ccall(
  'mrb_funicular_profiler_summary', 'string', [], []
));
const control = command => JSON.parse(debug.ccall(
  'mrb_funicular_profiler_control', 'string', ['string'], [command]
));

assert.equal(snapshot(0, 1).error, 'profiler_unavailable');
assert.equal(summary().error, 'profiler_unavailable');

const fixture = `
class DebugProfiler
  def initialize; @recording = false; @session = 1; end
  def snapshot_json(after_seq, limit)
    %Q({"schema_version":1,"session_id":#{@session},"recording":#{@recording},"after":#{after_seq},"limit":#{limit},"next_cursor":#{after_seq},"records":[]})
  end
  def summary_json
    %Q({"schema_version":1,"session_id":#{@session},"recording":#{@recording},"groups":[]})
  end
  def start!; @recording = true; end
  def stop!; @recording = false; end
  def clear!; @session += 1; end
  def recording?; @recording; end
end
$__funicular_profiler__ = DebugProfiler.new
`;
assert.equal(evaluate(fixture).error, undefined);
assert.equal(debug.ccall('mrb_funicular_profiler_available', 'number', [], []), 1);
for (let i = 0; i < 1000; i++) {
  assert.equal(debug.ccall('mrb_funicular_profiler_available', 'number', [], []), 1);
}
assert.equal(snapshot(9, 0).limit, 1);
assert.equal(snapshot(9, 201).limit, 200);
assert.equal(snapshot(0xffffffff, 1).after, 0xffffffff);
assert.equal(summary().session_id, 1);
const started = control('start');
assert.equal(started.recording, true);
assert.equal(started.session_id, 1);
assert.equal(control('status').recording, true);
assert.equal(control('stop').recording, false);
const cleared = control('clear');
assert.equal(cleared.ok, true);
assert.equal(cleared.session_id, 2);
assert.equal(control('unknown').error, 'unknown_command');

evaluate('class AvailabilityRaise; def respond_to?(name); raise "boom"; end; end; $__funicular_profiler__=AvailabilityRaise.new');
assert.equal(debug.ccall('mrb_funicular_profiler_available', 'number', [], []), 0);
assert.equal(evaluate(fixture).error, undefined, 'availability exception state was not cleared');
assert.equal(debug.ccall('mrb_funicular_profiler_available', 'number', [], []), 1);

evaluate('class BadProfiler < DebugProfiler; def snapshot_json(a,l); 1; end; end; $__funicular_profiler__=BadProfiler.new');
assert.equal(snapshot(0, 1).error, 'invalid_response');
evaluate('class RaiseProfiler < DebugProfiler; def snapshot_json(a,l); raise "boom"; end; end; $__funicular_profiler__=RaiseProfiler.new');
assert.equal(snapshot(0, 1).error, 'ruby_exception');
assert.equal(control('status').ok, true, 'Ruby exception state was not cleared');
evaluate(`class BorderProfiler < DebugProfiler
  def snapshot_json(a,l); '"' + 'x'*65533 + '"'; end
end
$__funicular_profiler__=BorderProfiler.new`);
assert.equal(snapshot(0, 1).length, 65533);
evaluate(`class LargeProfiler < DebugProfiler
  def snapshot_json(a,l); '"' + 'x'*65534 + '"'; end
end
$__funicular_profiler__=LargeProfiler.new`);
assert.equal(snapshot(0, 1).error, 'response_too_large');

const releaseExports = WebAssembly.Module.exports(
  new WebAssembly.Module(fs.readFileSync(releasePath))
).map(entry => entry.name);
assert.equal(releaseExports.includes('mrb_funicular_profiler_available'), false);
assert.equal(releaseExports.includes('mrb_funicular_profiler_snapshot'), false);
assert.equal(releaseExports.includes('mrb_funicular_profiler_summary'), false);
assert.equal(releaseExports.includes('mrb_funicular_profiler_control'), false);

process.stdout.write('profiler bridge integration: pass\n');
