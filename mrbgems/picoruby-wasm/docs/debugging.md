# Debugging PicoRuby.wasm Applications

PicoRuby.wasm ships with a Chrome DevTools extension that provides an
interactive Ruby REPL, `binding.irb` breakpoints, a step debugger, and a
local-variable/call-stack inspector.

## Requirements

- Chrome 102 or later
- A page loaded from a debug build such as `@picoruby/wasm-wasi@X.Y.Z-debug`

The debug API (`mrb_debug_*`) is compiled only into debug builds.
Production builds (`@latest`) do not include it.
When the extension detects a release build it shows an error and the REPL
remains inactive.

## Installation

Install from the Chrome Web Store:
**[PicoRuby Debugger — Chrome Web Store](PLACEHOLDER)**

Or load unpacked for local development:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `mrbgems/picoruby-wasm/debugger/`

## Using the debug package

Switch your page to a debug package. No local build is required.

```html
<!-- CDN (development only) -->
<script src="https://cdn.jsdelivr.net/npm/@picoruby/wasm-wasi@X.Y.Z-debug/dist/init.iife.js"></script>
```

```js
// npm
import { loadPicoRuby } from '@picoruby/wasm-wasi@X.Y.Z-debug';
```

Use `@head-debug` when you need the latest HEAD debug build.

Switch back to `@latest` before deploying to production.

To publish new production and debug builds from source:

```bash
rake wasm:npm:publish
```

## Breakpoints with `binding.irb`

Call `binding.irb` anywhere in Ruby code to pause execution at that point:

```ruby
def calculate(x, y)
  binding.irb   # execution suspends here
  x + y
end
```

When execution reaches `binding.irb` the task is suspended, the DevTools
panel gains focus, and the REPL prompt changes to `irb(debug):NNN>`.

## Debug commands

The following commands are accepted in the REPL while paused:

| Command | Shorthand | Description |
|---|---|---|
| `continue` | `c` | Resume execution |
| `step` | `s` | Step into the next expression |
| `next` | `n` | Step over to the next line |
| `help` | `h` | Show command list |

Keyboard shortcuts:

| Key | Action |
|---|---|
| F8 | Continue |
| F10 | Step over |
| F11 | Step into |

## REPL

The REPL is available at all times, not only when paused. Expressions are
evaluated in the top-level context normally, or in the current binding context
when paused at a `binding.irb`.

```
irb:001> 1 + 1
=> 2
irb:002> MyClass.instance_methods(false)
=> [:foo, :bar]
```

Input history is navigable with the up/down arrow keys.
The **Copy** button on each entry copies the input and output together.

## Local variables and call stack

When paused, the right-hand sidebar shows:

- **Local Variables** — all locals visible in the current scope, updated after
  each REPL evaluation
- **Call Stack** — the Ruby call stack from the pause point; the active frame
  is highlighted

## Funicular component inspector

When the page uses [Funicular](https://picoruby.org/funicular) with the debug
global enabled, a **Components** panel appears alongside the REPL:

```ruby
$__funicular_debug__ = true
```

The panel shows the live component tree. Clicking a component opens the
**Inspector** showing its `state` hash and instance variables. The tree
refreshes automatically every 500 ms.

## Funicular Profiler

The **Profiler** view is available in a debug build when the inspected
application installs `funicular-profiler`. PicoRuby detects the profiler at
runtime; it does not bundle or depend on Funicular.

Use **Record** / **Stop** to control collection, **Clear** to begin a new
session, **Refresh** to fetch immediately, and **Export** to download the
bounded profile currently held by DevTools. The view contains:

- **Summary** — count, errors, total, average, max, p50, p95, and empty-diff
  rate for the current bounded record window
- **Timeline** — newest records with name, component, status, duration, and
  parent ID
- **Details** — the selected record and its sanitized attributes

Polling occurs only while the Profiler view and DevTools document are visible.
Each request fetches at most 200 records, and the client retains at most 5,000
records while rendering at most 1,000 rows. A cursor-gap or dropped-record
banner means older data was overwritten; exported data is then marked
`incomplete`.

Profiler data stays in the inspected browser session. The debugger does not
add page URLs, user-agent strings, DOM, cookies, local storage, request bodies,
state, props, or raw SQL to records or exports.

If the view says **Profiler not installed**, install and start
`funicular-profiler` in the application. **Unsupported profiler schema** means
the profiler and DevTools disagree on the protocol major version. A
**Response too large** error requires reducing the profiler page/attribute
limits; JSON is never byte-truncated.

## How the debug API works

The extension communicates with the page exclusively through
`chrome.devtools.inspectedWindow.eval`, which executes JavaScript in the
context of the inspected page. No background service worker or content script
is involved.

The JavaScript calls into the WASM module via `window.picorubyModule.ccall`:

| C function | Purpose |
|---|---|
| `mrb_debug_get_status` | Poll pause state (mode, file, line, pause_id) |
| `mrb_eval_string` | Evaluate Ruby in top-level context |
| `mrb_debug_eval_in_binding` | Evaluate Ruby in paused binding |
| `mrb_debug_get_locals` | Return local variables as JSON |
| `mrb_debug_get_callstack` | Return call stack frames as JSON |
| `mrb_debug_continue` | Resume execution |
| `mrb_debug_step` | Step into |
| `mrb_debug_next` | Step over |
| `mrb_get_component_debug_info` | Funicular component tree |
| `mrb_get_component_state_by_id` | Funicular component state |
| `mrb_funicular_profiler_available` | Detect the profiler protocol at runtime |
| `mrb_funicular_profiler_snapshot` | Fetch up to 200 records after a cursor |
| `mrb_funicular_profiler_summary` | Fetch aggregate summary JSON |
| `mrb_funicular_profiler_control` | Allowlisted start/stop/clear/status control |

The extension polls `mrb_debug_get_status` every 200 ms to detect pause events.
The profiler functions and their 64 KiB response buffer are exported only by
debug builds. They accept fixed operations and numeric cursor arguments, not
arbitrary Ruby code or method names.
