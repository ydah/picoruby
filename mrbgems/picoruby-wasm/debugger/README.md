# PicoRuby Debugger

A Chrome DevTools extension for debugging [PicoRuby.WASM](https://github.com/picoruby/picoruby)
applications in the browser.

## Features

- **REPL** - Evaluate Ruby expressions in the context of the running application
- **`binding.irb` breakpoints** - Pause execution at any point in Ruby code
- **Step debugger** - Step into, step over, and continue from breakpoints
- **Local variables** - Inspect all local variables at the current scope
- **Call stack** - Navigate the Ruby call stack when paused
- **Component inspector** - Browse the Funicular component tree and inspect state
- **Funicular Profiler** - Inspect bounded summaries, timeline records, and details

## Requirements

- Chrome 102 or later
- A PicoRuby.WASM application loaded from a debug package such as `@picoruby/wasm-wasi@X.Y.Z-debug`

The debugger requires the `mrb_debug_*` API which is only present in debug
builds. The production package (`@picoruby/wasm-wasi@latest`) does not include
it. When a release build is detected the panel shows an error and the REPL
remains inactive.

### Using the debug package (no local build required)

Replace your script tag or import with a debug package:

```html
<!-- CDN -->
<script src="https://cdn.jsdelivr.net/npm/@picoruby/wasm-wasi@X.Y.Z-debug/dist/init.iife.js"></script>
```

```js
// npm
import { loadPicoRuby } from '@picoruby/wasm-wasi@X.Y.Z-debug';
```

Use `@head-debug` when you need the latest HEAD debug build.

Switch back to `@latest` before deploying to production.

### Building locally

Alternatively, build from source:

```bash
rake wasm:build_debug
```

## Installation

### From the Chrome Web Store

*(Link will be added after publication.)*

### Developer mode (load unpacked)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `debugger/` directory

## Usage

### REPL

Open the **PicoRuby** tab in Chrome DevTools. The REPL is available as long as
a page with `window.picorubyModule` (debug build) is open.

```
irb:001> 1 + 1
=> 2
irb:002> puts "hello"
hello
=> nil
```

### Setting breakpoints with `binding.irb`

Add `binding.irb` anywhere in your Ruby source code:

```ruby
def my_method(x)
  binding.irb   # execution pauses here
  x * 2
end
```

When execution reaches `binding.irb`, the debugger panel suspends the task and
the prompt changes to `irb(debug):NNN>`.

### Debug commands

When paused at a breakpoint, the following commands are available in the REPL:

| Command | Shorthand | Description |
|---|---|---|
| `continue` | `c` | Resume execution |
| `step` | `s` | Step into the next expression |
| `next` | `n` | Step over to the next line |
| `help` | `h` | Show command list |

### Keyboard shortcuts

| Key | Action |
|---|---|
| F8 | Continue |
| F10 | Step over |
| F11 | Step into |

### Funicular component inspector

When the page uses [Funicular](https://picoruby.org/funicular) with debug mode
enabled (`$__funicular_debug__ = true`), a **Components** panel appears
alongside the REPL showing the live component tree. Click any component to
inspect its state and instance variables.

### Funicular Profiler

Applications that explicitly install `funicular-profiler` expose a versioned,
local-only snapshot API to debug PicoRuby builds. Open **Profiler** and use
**Record**, **Stop**, **Clear**, **Refresh**, or **Export**. The panel stops
profiler polling whenever that view or the DevTools document is hidden.

Summary percentiles describe the bounded browser record window. Cursor-gap and
dropped-record warnings mean the profile is incomplete. Export excludes the
page URL and user agent, and the debugger never reads DOM, cookie, storage,
request-body, state, props, or SQL data for profiling.

Troubleshooting:

- **Profiler not installed** — install/start `funicular-profiler` in the page
- **Unsupported schema** — update either DevTools or the profiler adapter
- **Response too large** — reduce profiler snapshot/attribute limits
- **Disconnected** — reload the inspected page and use **Refresh**

Development checks from the repository root:

```bash
node --test mrbgems/picoruby-wasm/debugger/test/*.test.cjs
rake 'test:gems:wasm[picoruby-wasm]'
CONFIG=picoruby-wasm rake
node mrbgems/picoruby-wasm/debugger/test/profiler_bridge_integration.mjs \
  build/picoruby-wasm-test/bin/picoruby.js \
  build/picoruby-wasm/bin/picoruby.wasm
```

## Packaging for Chrome Web Store submission

Run from the PicoRuby repository root:

```bash
rake wasm:zip_debugger
```

This produces `picoruby-debugger-X.Y.Z.zip` in the repository root, with
`README.md` and the privacy policy HTML excluded. Upload this file to the
Chrome Web Store Developer Dashboard.

### Store listing

**Short description** (132 chars max):

> Debug PicoRuby.WASM applications from Chrome DevTools: REPL, binding.irb breakpoints, step debugger, locals, and call stack.

**Detailed description**:

> PicoRuby Debugger adds a dedicated panel to Chrome DevTools for inspecting and debugging web applications built with PicoRuby.WASM.
>
> Features:
> - Interactive Ruby REPL evaluated in the context of the running PicoRuby instance
> - Pause execution with binding.irb breakpoints anywhere in your Ruby source
> - Step into, step over, and continue from breakpoints
> - Inspect local variables and navigate the call stack while paused
> - Browse the Funicular component tree and inspect component state
>
> Requirements: PicoRuby.WASM debug build (`rake wasm:build_debug`). Release builds are not supported.
>
> Open source: https://github.com/picoruby/picoruby

**Single purpose**: Debug PicoRuby.WASM applications in browser DevTools.

## Privacy

This extension does not collect, store, or transmit any data.
All debugging information is read from the local browser session and displayed
only within DevTools. See the full [Privacy Policy](https://picoruby.org/picoruby-wasm-debugger-privacy-policy).

## License

MIT - see the [PicoRuby repository](https://github.com/picoruby/picoruby) for details.
