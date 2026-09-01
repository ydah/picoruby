// PicoRuby.WASM Debugger - DevTools panel script

class PicoRubyDebugger {
  constructor() {
    this.status = document.getElementById('status');
    this.replOutput = document.getElementById('replOutput');
    this.localsContent = document.getElementById('localsContent');
    this.callstackContent = document.getElementById('callstackContent');
    this.btnContinue = document.getElementById('btnContinue');
    this.btnStep = document.getElementById('btnStep');
    this.btnNext = document.getElementById('btnNext');

    // Component debug elements
    this.componentsPanel = document.getElementById('componentsPanel');
    this.componentTree = document.getElementById('componentTree');
    this.componentInspector = document.getElementById('componentInspector');

    // Profiler elements and bounded client state
    this.consoleView = document.getElementById('consoleView');
    this.profilerView = document.getElementById('profilerView');
    this.consoleTab = document.getElementById('consoleTab');
    this.profilerTab = document.getElementById('profilerTab');
    this.consoleControls = document.getElementById('consoleControls');
    this.profilerStatus = document.getElementById('profilerStatus');
    this.profilerBanner = document.getElementById('profilerBanner');
    this.profilerSummaryBody = document.getElementById('profilerSummaryBody');
    this.profilerTimelineBody = document.getElementById('profilerTimelineBody');
    this.profilerDetails = document.getElementById('profilerDetails');
    this.profilerModel = new PicoRubyProfilerModel.ProfilerModel();
    this.profilerTransport = new PicoRubyProfilerTransport.ProfilerTransport(
      code => this.evalInPage(code)
    );
    this.activeView = 'console';
    this.profilerAvailable = false;
    this.profilerPollTimer = null;
    this.profilerRequestInFlight = false;
    this.profilerBackoff = 500;

    this.isPaused = false;
    this.pauseId = -1;
    this.isConnected = false;
    this.connectionRetryTimer = null;
    this.debugPollInterval = null;
    this.selectedComponentId = null;
    this.expandedComponents = new Set();
    this.autoRefreshInterval = null;
    this.lastComponentTreeHash = null;
    this.lineNumber = 1;

    // Console input state
    this.currentInputLine = null;
    this.inputEditable = null;
    this.history = [];
    this.historyIndex = -1;

    this.setupEventListeners();
    this.setupDebugButtons();
    this.setupProfiler();
    this.setupResizeHandles();
    this.createInputLine();
    this.checkConnection();
  }

  // -- Console input --

  createInputLine() {
    const line = document.createElement('div');
    line.className = 'repl-current-input';

    const prompt = document.createElement('span');
    prompt.className = 'repl-prompt';
    if (this.isPaused) prompt.classList.add('debug');
    prompt.textContent = this.getPromptText();

    const editable = document.createElement('span');
    editable.className = 'repl-input-editable';
    editable.contentEditable = 'true';
    editable.spellcheck = false;
    editable.autocorrect = 'off';
    editable.autocapitalize = 'off';

    line.appendChild(prompt);
    line.appendChild(editable);
    this.replOutput.appendChild(line);

    this.currentInputLine = line;
    this.inputEditable = editable;

    editable.addEventListener('keydown', (e) => this.handleInputKeydown(e));
    editable.addEventListener('paste', (e) => this.handlePaste(e));
    editable.focus();
  }

  handleInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.submitInput(this.inputEditable.textContent);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.historyBack();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.historyForward();
    }
  }

  handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }

  historyBack() {
    if (this.history.length === 0) return;
    if (this.historyIndex < this.history.length - 1) this.historyIndex++;
    this.inputEditable.textContent =
      this.history[this.history.length - 1 - this.historyIndex];
    this.moveCursorToEnd();
  }

  historyForward() {
    if (this.historyIndex <= 0) {
      this.historyIndex = -1;
      this.inputEditable.textContent = '';
      return;
    }
    this.historyIndex--;
    this.inputEditable.textContent =
      this.history[this.history.length - 1 - this.historyIndex];
    this.moveCursorToEnd();
  }

  moveCursorToEnd() {
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(this.inputEditable);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  submitInput(code) {
    // Freeze the current input line
    const promptText = this.getPromptText();
    const frozenEntry = this.currentInputLine;
    frozenEntry.className = 'repl-entry';
    frozenEntry.innerHTML =
      `<div class="repl-input-line">${this.escapeHtml(promptText)}${this.escapeHtml(code)}</div>`;

    this.lineNumber++;

    if (code.trim()) {
      this.history.push(code);
      this.historyIndex = -1;
    }

    // Create new input line at bottom
    this.createInputLine();
    this.updatePrompt();
    this.clearEmptyState();
    this.replOutput.scrollTop = this.replOutput.scrollHeight;

    if (!code.trim()) return;

    // Check for debug commands when paused
    if (this.isPaused) {
      const cmd = this.parseDebugCommand(code);
      if (cmd) {
        this.executeDebugCommand(cmd, frozenEntry);
        return;
      }
    }

    // Use debug eval when paused, otherwise normal eval
    const evalFn = this.isPaused ? 'mrb_debug_eval_in_binding' : 'mrb_eval_string';

    this.evalInPage(`
      (function() {
        if (typeof window.picorubyModule === 'undefined') {
          return { error: 'PicoRuby not available' };
        }
        try {
          const jsonStr = window.picorubyModule.ccall(
            '${evalFn}', 'string', ['string'], [${JSON.stringify(code)}]);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(response => {
      if (response.error) {
        const errorLine = document.createElement('div');
        errorLine.className = 'repl-error';
        errorLine.textContent = response.error;
        frozenEntry.appendChild(errorLine);
      } else {
        const row = document.createElement('div');
        row.className = 'repl-output-row';

        const outputLine = document.createElement('div');
        outputLine.className = 'repl-output-line';
        outputLine.textContent = '=> ' + response.result;

        const inputLine = frozenEntry.querySelector('.repl-input-line');
        const copyText = (inputLine ? inputLine.textContent : '') +
                         '\n=> ' + response.result;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.copyToClipboard(copyText, copyBtn);
        });

        row.appendChild(outputLine);
        row.appendChild(copyBtn);
        frozenEntry.appendChild(row);
      }
      this.replOutput.scrollTop = this.replOutput.scrollHeight;

      if (this.isPaused) {
        this.fetchLocals();
      }
    }).catch(err => {
      const errorLine = document.createElement('div');
      errorLine.className = 'repl-error';
      errorLine.textContent = 'DevTools error: ' + err.message;
      frozenEntry.appendChild(errorLine);
      this.replOutput.scrollTop = this.replOutput.scrollHeight;
    });
  }

  setupDebugButtons() {
    this.btnContinue.addEventListener('click', () => this.debugContinue());
    this.btnStep.addEventListener('click', () => this.debugStep());
    this.btnNext.addEventListener('click', () => this.debugNext());
  }

  setupProfiler() {
    this.consoleTab.addEventListener('click', () => this.switchView('console'));
    this.profilerTab.addEventListener('click', () => this.switchView('profiler'));
    document.getElementById('profilerRecord').addEventListener('click', () => {
      this.controlProfiler(this.profilerModel.recording ? 'stop' : 'start');
    });
    document.getElementById('profilerClear').addEventListener('click', () => {
      this.controlProfiler('clear');
    });
    document.getElementById('profilerRefresh').addEventListener('click', () => {
      this.refreshProfiler(true);
    });
    document.getElementById('profilerExport').addEventListener('click', () => {
      this.exportProfiler();
    });

    const updateFilters = () => {
      this.profilerModel.setFilters({
        name: document.getElementById('profilerNameFilter').value,
        component: document.getElementById('profilerComponentFilter').value,
        status: document.getElementById('profilerStatusFilter').value,
      });
      this.renderProfilerTimeline();
    };
    document.getElementById('profilerNameFilter').addEventListener('input', updateFilters);
    document.getElementById('profilerComponentFilter').addEventListener('input', updateFilters);
    document.getElementById('profilerStatusFilter').addEventListener('change', updateFilters);

    this.profilerView.querySelectorAll('[data-sort]').forEach(header => {
      header.tabIndex = 0;
      header.setAttribute('role', 'button');
      const sort = () => {
        const by = header.dataset.sort;
        const direction = this.profilerModel.sort.by === by &&
          this.profilerModel.sort.direction === 'desc' ? 'asc' : 'desc';
        this.profilerModel.setSort(by, direction);
        this.updateProfilerSortHeaders();
        this.renderProfilerSummary();
      };
      header.addEventListener('click', sort);
      header.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          sort();
        }
      });
    });
    this.updateProfilerSortHeaders();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleProfilerPoll(0);
      else this.stopProfilerPolling();
    });
    if (chrome.devtools.network && chrome.devtools.network.onNavigated) {
      chrome.devtools.network.onNavigated.addListener(() => {
        this.handleInspectedNavigation();
      });
    }
    window.addEventListener('unload', () => this.stopProfilerPolling());
  }

  handleInspectedNavigation() {
    this.profilerTransport.resetGeneration();
    this.stopProfilerPolling();
    this.profilerModel.clearLocal();
    this.profilerModel.connectionState = 'reconnecting';
    this.profilerAvailable = false;
    this.profilerTab.disabled = true;
    this.isConnected = false;
    this.stopDebugPolling();
    if (this.autoRefreshInterval) clearInterval(this.autoRefreshInterval);
    this.autoRefreshInterval = null;
    this.updateStatus('Reconnecting...');
    this.renderProfiler();
    this.scheduleConnectionRetry(100);
  }

  scheduleConnectionRetry(delay) {
    if (this.connectionRetryTimer) clearTimeout(this.connectionRetryTimer);
    this.connectionRetryTimer = setTimeout(() => {
      this.connectionRetryTimer = null;
      this.checkConnection();
    }, delay);
  }

  switchView(view) {
    this.activeView = view;
    const profiler = view === 'profiler';
    this.consoleView.classList.toggle('hidden-view', profiler);
    this.profilerView.classList.toggle('hidden-view', !profiler);
    this.consoleControls.classList.toggle('hidden-view', profiler);
    this.consoleTab.setAttribute('aria-selected', String(!profiler));
    this.profilerTab.setAttribute('aria-selected', String(profiler));
    if (profiler) {
      document.getElementById('profilerRecord').focus();
      this.refreshProfiler(true);
    } else {
      this.stopProfilerPolling();
      if (this.inputEditable) this.inputEditable.focus();
    }
  }

  setDebugButtonsEnabled(enabled) {
    this.btnContinue.disabled = !enabled;
    this.btnStep.disabled = !enabled;
    this.btnNext.disabled = !enabled;
  }

  setupResizeHandles() {
    const sidebar = document.getElementById('sidebar');
    const localsSection = document.getElementById('localsSection');
    const componentsPanel = document.getElementById('componentsPanel');

    this.setupColResizeHandle(
      document.getElementById('replSidebarHandle'),
      sidebar,
      150, 600
    );
    this.setupRowResizeHandle(
      document.getElementById('localCallstackHandle'),
      localsSection,
      60, null
    );
    this.setupSplitColResizeHandle(
      document.getElementById('sidebarComponentsHandle'),
      sidebar,
      componentsPanel,
      150, 600
    );
  }

  setupColResizeHandle(handle, targetEl, minWidth, maxWidth) {
    if (!handle || !targetEl) return;
    handle.addEventListener('mousedown', (e) => {
      const startX = e.clientX;
      const startWidth = targetEl.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const delta = startX - e.clientX;
        const newWidth = Math.max(minWidth, Math.min(maxWidth || 9999, startWidth + delta));
        targetEl.style.width = newWidth + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  setupSplitColResizeHandle(handle, leftEl, rightEl, minWidth, maxWidth) {
    if (!handle || !leftEl || !rightEl) return;
    handle.addEventListener('mousedown', (e) => {
      const startX = e.clientX;
      const startLeftWidth = leftEl.offsetWidth;
      const startRightWidth = rightEl.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const delta = e.clientX - startX;
        const newLeftWidth = Math.max(minWidth, Math.min(maxWidth, startLeftWidth + delta));
        const actualDelta = newLeftWidth - startLeftWidth;
        leftEl.style.width = newLeftWidth + 'px';
        rightEl.style.width = Math.max(minWidth, startRightWidth - actualDelta) + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  setupRowResizeHandle(handle, topEl, minHeight, maxHeight) {
    if (!handle || !topEl) return;
    handle.addEventListener('mousedown', (e) => {
      const startY = e.clientY;
      const startHeight = topEl.offsetHeight;
      handle.classList.add('dragging');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMove = (e) => {
        const delta = e.clientY - startY;
        const newHeight = Math.max(minHeight, Math.min(maxHeight || 9999, startHeight + delta));
        topEl.style.flex = 'none';
        topEl.style.height = newHeight + 'px';
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  setupEventListeners() {
    // Click anywhere in the output area focuses the input
    this.replOutput.addEventListener('click', () => {
      if (this.inputEditable &&
          this.inputEditable.contentEditable !== 'false') {
        this.inputEditable.focus();
        this.moveCursorToEnd();
      }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (!this.isPaused) return;
      if (e.key === 'F8') {
        e.preventDefault();
        this.debugContinue();
      } else if (e.key === 'F11') {
        e.preventDefault();
        this.debugStep();
      } else if (e.key === 'F10') {
        e.preventDefault();
        this.debugNext();
      }
    });
  }

  checkConnection() {
    this.evalInPage('typeof window.picorubyModule')
      .then(result => {
        if (result === 'undefined') {
          this.updateStatus('PicoRuby Module not found');
          this.scheduleConnectionRetry(500);
          return;
        }

        return this.evalInPage(
          'typeof window.picorubyModule._mrb_debug_get_status'
        ).then(apiResult => {
          if (apiResult === 'undefined') {
            this.updateStatus('Release build detected — use a debug PicoRuby.wasm package');
            this.appendReplInfo(
              'This page uses a release build of PicoRuby.WASM.\n' +
              'The debug API is not available.\n' +
              'Switch to @picoruby/wasm-wasi@X.Y.Z-debug or @picoruby/wasm-wasi@head-debug to use the debugger.'
            );
            return;
          }

          this.isConnected = true;
          if (this.connectionRetryTimer) clearTimeout(this.connectionRetryTimer);
          this.connectionRetryTimer = null;
          this.profilerTab.disabled = false;
          this.updateStatus('Connected to PicoRuby');
          this.startDebugPolling();
          this.checkComponentDebugMode();
          this.profilerTransport.checkProfilerAvailability(
            this.profilerTransport.generation
          ).then(profiler => {
            this.profilerAvailable = Boolean(profiler && profiler.available);
            if (this.activeView === 'profiler') this.refreshProfiler(true);
          }).catch(() => {});
        });
      })
      .catch(err => {
        console.error('Connection check error:', err);
        this.updateStatus('Error: ' + err.message);
        this.scheduleConnectionRetry(500);
      });
  }

  // -- Debug status polling --

  startDebugPolling() {
    if (this.debugPollInterval) return;

    this.debugPollInterval = setInterval(() => {
      this.pollDebugStatus();
    }, 200);
  }

  stopDebugPolling() {
    if (this.debugPollInterval) {
      clearInterval(this.debugPollInterval);
      this.debugPollInterval = null;
    }
  }

  pollDebugStatus() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          if (!Module || typeof Module.ccall !== 'function') return null;
          if (typeof Module._mrb_debug_get_status === 'undefined') return null;
          const jsonStr = Module.ccall('mrb_debug_get_status', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return null;
        }
      })()
    `).then(status => {
      if (!status) return;
      if (status.mode === 'paused') {
        const newPause = status.pause_id !== this.pauseId;
        if (!this.isPaused || newPause) {
          this.enterDebugMode(status);
        }
      } else if (this.isPaused) {
        this.exitDebugMode();
      }
    }).catch(() => {});
  }

  enterDebugMode(status) {
    this.isPaused = true;
    this.pauseId = status.pause_id;
    this.setDebugButtonsEnabled(true);
    this.enableInput();
    this.updatePrompt();
    const file = status.file || '(unknown)';
    const line = status.line || 0;
    this.updateStatus(`Paused at ${file}:${line}`, true);

    // Show pause info in REPL
    this.appendReplInfo(`-- Paused at ${file}:${line} --`);

    // Fetch locals and callstack
    this.fetchLocals();
    this.fetchCallstack();

    if (this.inputEditable) {
      this.inputEditable.focus();
      this.moveCursorToEnd();
    }
  }

  exitDebugMode() {
    this.isPaused = false;
    this.setDebugButtonsEnabled(false);
    this.updateStatus('Connected to PicoRuby');
    this.localsContent.innerHTML = '<div class="empty-state">Not paused</div>';
    this.callstackContent.innerHTML = '<div class="empty-state">Not paused</div>';
    this.disableInput();
  }

  disableInput() {
    if (!this.currentInputLine || !this.inputEditable) return;
    this.inputEditable.contentEditable = 'false';
    this.currentInputLine.classList.add('session-ended');
    const prompt = this.currentInputLine.querySelector('.repl-prompt');
    if (prompt) prompt.textContent = '-- session ended --';
  }

  enableInput() {
    if (!this.currentInputLine || !this.inputEditable) return;
    this.inputEditable.contentEditable = 'true';
    this.currentInputLine.classList.remove('session-ended');
  }

  // -- Debug actions --

  /* Handle the response from continue/step/next.
   * If the task synchronously re-paused, the C function returns the
   * paused status directly (mode === 'paused'); otherwise it returns
   * a running/stepping status and we fall back to polling. */
  handleDebugActionResult(result) {
    if (result.mode === 'paused') {
      this.enterDebugMode(result);
    } else {
      this.pollDebugStatus();
    }
  }

  debugContinue() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_debug_continue', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(result => {
      if (result.error) {
        this.appendReplError('Continue error: ' + result.error);
      } else {
        this.appendReplInfo('-- Continued --');
        this.handleDebugActionResult(result);
      }
    }).catch(err => {
      this.appendReplError('Continue error: ' + err.message);
    });
  }

  debugStep() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_debug_step', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(result => {
      if (result.error) {
        this.appendReplError('Step error: ' + result.error);
      } else {
        this.handleDebugActionResult(result);
      }
    }).catch(err => {
      this.appendReplError('Step error: ' + err.message);
    });
  }

  debugNext() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_debug_next', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(result => {
      if (result.error) {
        this.appendReplError('Next error: ' + result.error);
      } else {
        this.handleDebugActionResult(result);
      }
    }).catch(err => {
      this.appendReplError('Next error: ' + err.message);
    });
  }

  // -- Locals & Callstack --

  fetchLocals() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_debug_get_locals', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(locals => {
      if (locals.error) {
        this.localsContent.innerHTML =
          '<div class="empty-state">' + this.escapeHtml(locals.error) + '</div>';
        return;
      }
      this.displayLocals(locals);
    }).catch(() => {
      this.localsContent.innerHTML = '<div class="empty-state">Failed to load</div>';
    });
  }

  displayLocals(locals) {
    let html = '';
    for (const [name, value] of Object.entries(locals)) {
      html += `
        <div class="variable-item">
          <span class="variable-name">${this.escapeHtml(name)}</span>
          <span class="variable-sep">=</span>
          <span class="variable-value">${this.escapeHtml(value)}</span>
        </div>`;
    }
    if (!html) {
      html = '<div class="empty-state">No local variables</div>';
    }
    this.localsContent.innerHTML = html;
  }

  fetchCallstack() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_debug_get_callstack', 'string', [], []);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(stack => {
      if (stack.error) {
        this.callstackContent.innerHTML =
          '<div class="empty-state">' + this.escapeHtml(stack.error) + '</div>';
        return;
      }
      this.displayCallstack(stack);
    }).catch(() => {
      this.callstackContent.innerHTML = '<div class="empty-state">Failed to load</div>';
    });
  }

  displayCallstack(frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
      this.callstackContent.innerHTML = '<div class="empty-state">No frames</div>';
      return;
    }

    let html = '';
    frames.forEach((frame, idx) => {
      const cls = idx === 0 ? 'stack-frame active' : 'stack-frame';
      html += `
        <div class="${cls}">
          <div class="stack-frame-method">${this.escapeHtml(frame.method)}</div>
          <div class="stack-frame-location">${this.escapeHtml(frame.file)}:${frame.line}</div>
        </div>`;
    });
    this.callstackContent.innerHTML = html;
  }

  // -- REPL --

  parseDebugCommand(input) {
    const cmd = input.trim();
    switch (cmd) {
      case 'c': case 'continue': return 'continue';
      case 's': case 'step':     return 'step';
      case 'n': case 'next':     return 'next';
      case 'h': case 'help':     return 'help';
      default:                   return null;
    }
  }

  executeDebugCommand(cmd, entry) {
    switch (cmd) {
      case 'continue': {
        const info = document.createElement('div');
        info.className = 'repl-info';
        info.textContent = '=> continue';
        entry.appendChild(info);
        this.debugContinue();
        break;
      }
      case 'step': {
        const info = document.createElement('div');
        info.className = 'repl-info';
        info.textContent = '=> step';
        entry.appendChild(info);
        this.debugStep();
        break;
      }
      case 'next': {
        const info = document.createElement('div');
        info.className = 'repl-info';
        info.textContent = '=> next';
        entry.appendChild(info);
        this.debugNext();
        break;
      }
      case 'help': {
        const lines = [
          'Debug commands:',
          '  c, continue  - Resume execution',
          '  s, step      - Step into',
          '  n, next      - Step over',
          '  h, help      - Show this help',
          '',
          'Keyboard shortcuts:',
          '  F8  - Continue',
          '  F11 - Step into',
          '  F10 - Step over',
        ];
        lines.forEach(line => {
          const info = document.createElement('div');
          info.className = 'repl-info';
          info.textContent = line || '\u00A0';
          entry.appendChild(info);
        });
        break;
      }
    }
    this.replOutput.scrollTop = this.replOutput.scrollHeight;
  }

  getPromptText() {
    const num = String(this.lineNumber).padStart(3, '0');
    return this.isPaused ? `irb(debug):${num}> ` : `irb:${num}> `;
  }

  updatePrompt() {
    if (!this.currentInputLine) return;
    const prompt = this.currentInputLine.querySelector('.repl-prompt');
    if (!prompt) return;
    prompt.textContent = this.getPromptText();
    if (this.isPaused) {
      prompt.classList.add('debug');
    } else {
      prompt.classList.remove('debug');
    }
  }

  // -- Funicular profiler --

  canPollProfiler() {
    return this.activeView === 'profiler' &&
      document.visibilityState === 'visible' && this.isConnected &&
      this.profilerAvailable && !this.profilerRequestInFlight;
  }

  stopProfilerPolling() {
    if (this.profilerPollTimer) clearTimeout(this.profilerPollTimer);
    this.profilerPollTimer = null;
  }

  scheduleProfilerPoll(delay) {
    this.stopProfilerPolling();
    if (!this.canPollProfiler()) return;
    this.profilerPollTimer = setTimeout(() => this.refreshProfiler(false), delay);
  }

  async refreshProfiler(manual) {
    if (this.profilerRequestInFlight || this.activeView !== 'profiler') return;
    this.stopProfilerPolling();
    this.profilerRequestInFlight = true;
    if (this.profilerModel.connectionState !== 'connected' &&
        this.profilerModel.connectionState !== 'reconnecting') {
      this.profilerModel.connectionState = 'loading';
    }
    this.profilerStatus.textContent = this.profilerModel.statusText();
    const generation = this.profilerTransport.generation;
    try {
      const availability = await this.profilerTransport.checkProfilerAvailability(generation);
      if (!availability) return;
      if (availability.error) throw new Error(availability.error);
      this.profilerAvailable = availability.available;
      if (!this.profilerAvailable) {
        this.profilerModel.connectionState = 'unavailable';
        this.profilerStatus.textContent = this.profilerModel.statusText();
        this.setProfilerBanner(
          'Install and start funicular-profiler in the inspected application.'
        );
        return;
      }

      if (manual || this.profilerModel.sessionId === null) {
        const summary = await this.profilerTransport.fetchSummary(generation);
        if (!summary) return;
        if (summary.error) throw new Error(summary.error);
        this.profilerModel.applySummary(summary);
      }

      const pages = await this.profilerTransport.fetchSnapshotPages(
        this.profilerModel.cursor, generation,
        snapshot => this.profilerModel.applySnapshot(snapshot)
      );
      if (!pages) return;
      if (pages.hasMore) {
        this.setProfilerBanner('More records are waiting; polling is page-limited.');
      }
      else this.updateProfilerWarnings();
      this.profilerBackoff = 500;
      this.renderProfiler();
    } catch (error) {
      this.profilerBackoff = Math.min(this.profilerBackoff * 2, 5000);
      if (error.message === 'unsupported_schema') this.profilerAvailable = false;
      this.showProfilerError(error.message || 'disconnected');
      if (!this.profilerAvailable &&
          ['module_unavailable', 'ccall_error', 'devtools_eval_error'].includes(error.message)) {
        this.scheduleConnectionRetry(this.profilerBackoff);
      }
    } finally {
      this.profilerRequestInFlight = false;
      const delay = this.profilerModel.recording ? 500 : 2000;
      this.scheduleProfilerPoll(Math.max(delay, this.profilerBackoff));
    }
  }

  async controlProfiler(command) {
    if (this.profilerRequestInFlight || !this.profilerAvailable) return;
    this.stopProfilerPolling();
    this.profilerRequestInFlight = true;
    const buttons = this.profilerView.querySelectorAll('.profiler-toolbar button');
    buttons.forEach(button => { button.disabled = true; });
    if (command === 'clear') this.profilerTransport.resetGeneration();
    try {
      const response = await this.profilerTransport.control(
        command, this.profilerTransport.generation
      );
      if (!response) return;
      if (response.error) throw new Error(response.error);
      if (command === 'clear') this.profilerModel.clearLocal();
      if (typeof response.recording === 'boolean') {
        this.profilerModel.recording = response.recording;
      }
    } catch (error) {
      this.showProfilerError(error.message);
    } finally {
      this.profilerRequestInFlight = false;
      buttons.forEach(button => { button.disabled = false; });
    }
    await this.refreshProfiler(true);
  }

  updateProfilerWarnings() {
    const counters = this.profilerModel.counters;
    const warnings = [];
    if (this.profilerModel.cursorGap) {
      warnings.push('Cursor gap: older records were overwritten.');
    }
    if ((counters.dropped_count || 0) > 0 ||
        (counters.dropped_in_flight_count || 0) > 0) {
      warnings.push(`Dropped records: ${counters.dropped_count || 0}; ` +
        `in-flight: ${counters.dropped_in_flight_count || 0}.`);
    }
    if (this.profilerModel.clientEvictedCount > 0) {
      warnings.push(`Client window evicted ${this.profilerModel.clientEvictedCount} records.`);
    }
    if (this.profilerModel.protocolWarningCount > 0) {
      warnings.push(`Skipped ${this.profilerModel.protocolWarningCount} malformed records.`);
    }
    this.setProfilerBanner(warnings.join(' '));
  }

  showProfilerError(message) {
    const errors = {
      unsupported_schema: ['Unsupported schema',
        'Unsupported profiler schema. Upgrade PicoRuby DevTools.'],
      response_too_large: ['Response too large',
        'Profiler response exceeded 65,535 bytes. Reduce snapshot or attribute limits.'],
      protocol_error: ['Protocol error', 'Malformed profiler response.'],
      invalid_json: ['Protocol error', 'Profiler returned invalid JSON.'],
      invalid_response: ['Protocol error',
        'The profiler API returned a non-String response.'],
      ruby_exception: ['Ruby exception',
        'The profiler raised while handling the request.'],
      compile_error: ['Bridge compile error',
        'PicoRuby could not compile the fixed profiler bridge expression.'],
      module_unavailable: ['Reconnecting',
        'PicoRuby module is unavailable. Reconnecting...'],
      debug_api_unavailable: ['Debug API unavailable',
        'Use a debug PicoRuby.wasm package with profiler support.'],
      ccall_error: ['Reconnecting',
        'The profiler bridge call failed. Reconnecting...'],
      devtools_eval_error: ['Reconnecting',
        'DevTools could not evaluate the profiler request. Reconnecting...'],
      request_in_flight: ['Loading', 'A profiler request is already in progress.'],
      profiler_unavailable: ['Profiler not installed',
        'Install and start funicular-profiler in the inspected application.'],
    };
    const key = message.startsWith('protocol_error') ? 'protocol_error' : message;
    if (['module_unavailable', 'ccall_error', 'devtools_eval_error'].includes(key)) {
      this.profilerModel.connectionState = 'reconnecting';
    } else {
      this.profilerModel.connectionState = 'error';
    }
    const display = errors[key] || ['Disconnected', 'Profiler error: ' + message];
    this.profilerStatus.textContent = display[0];
    this.setProfilerBanner(display[1]);
  }

  setProfilerBanner(message) {
    this.profilerBanner.textContent = message;
    this.profilerBanner.classList.toggle('hidden-view', !message);
  }

  renderProfiler() {
    const recording = this.profilerModel.recording;
    document.getElementById('profilerRecord').textContent = recording ? 'Stop' : 'Record';
    document.getElementById('profilerRecord').title = recording
      ? 'Stop recording' : 'Start recording';
    this.profilerStatus.textContent = this.profilerModel.statusText();
    this.renderProfilerSummary();
    this.renderProfilerTimeline();
    if (!this.profilerModel.selectedRecordId) {
      this.profilerDetails.textContent = 'Select a record';
    }
  }

  appendProfilerCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = String(value);
    row.appendChild(cell);
  }

  renderProfilerSummary() {
    const fragment = document.createDocumentFragment();
    const format = PicoRubyProfilerModel.ProfilerModel.formatDuration;
    const rows = this.profilerModel.summaryRows();
    let i = 0;
    while (i < rows.length) {
      const group = rows[i];
      const row = document.createElement('tr');
      this.appendProfilerCell(row, group.name);
      this.appendProfilerCell(row, group.component_class || '—');
      this.appendProfilerCell(row, group.count);
      this.appendProfilerCell(row, group.error_count);
      this.appendProfilerCell(row, format(group.total_us));
      this.appendProfilerCell(row, format(group.average_us));
      this.appendProfilerCell(row, format(group.max_us));
      this.appendProfilerCell(row, format(group.p50_us));
      this.appendProfilerCell(row, format(group.p95_us));
      this.appendProfilerCell(row, (group.empty_diff_rate * 100).toFixed(1) + '%');
      fragment.appendChild(row);
      i++;
    }
    this.profilerSummaryBody.replaceChildren(fragment);
  }

  updateProfilerSortHeaders() {
    this.profilerView.querySelectorAll('[data-sort]').forEach(header => {
      header.setAttribute('aria-sort', header.dataset.sort === this.profilerModel.sort.by
        ? (this.profilerModel.sort.direction === 'asc' ? 'ascending' : 'descending')
        : 'none');
    });
  }

  renderProfilerTimeline() {
    const fragment = document.createDocumentFragment();
    const format = PicoRubyProfilerModel.ProfilerModel.formatDuration;
    const records = this.profilerModel.visibleRecords({ limit: 1000 });
    let i = 0;
    while (i < records.length) {
      const record = records[i];
      const row = document.createElement('tr');
      row.className = record.status === 'error' ? 'error' : '';
      if (record.id === this.profilerModel.selectedRecordId) row.classList.add('selected');
      this.appendProfilerCell(row, format(record.started_at_us));
      this.appendProfilerCell(row, format(record.duration_us));
      this.appendProfilerCell(row, record.name);
      this.appendProfilerCell(row, record.attributes['funicular.component.class'] || '—');
      this.appendProfilerCell(row, record.status);
      this.appendProfilerCell(row, record.parent_id || '—');
      row.addEventListener('click', () => this.showProfilerDetails(record.id));
      row.tabIndex = 0;
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.showProfilerDetails(record.id);
        }
      });
      fragment.appendChild(row);
      i++;
    }
    this.profilerTimelineBody.replaceChildren(fragment);
  }

  showProfilerDetails(id) {
    const record = this.profilerModel.selectRecord(id);
    if (!record) {
      this.profilerDetails.textContent = 'Select a record';
      return;
    }
    const details = {
      schema_version: record.schema_version,
      seq: record.seq,
      id: record.id,
      parent_id: record.parent_id,
      kind: record.kind,
      name: record.name,
      status: record.status,
      started_at_us: record.started_at_us,
      duration_us: record.duration_us,
      attributes: Object.keys(record.attributes).sort().reduce((result, key) => {
        result[key] = record.attributes[key];
        return result;
      }, Object.create(null)),
    };
    this.profilerDetails.textContent = JSON.stringify(details, null, 2);
    this.renderProfilerTimeline();
  }

  exportProfiler() {
    const manifest = chrome.runtime && chrome.runtime.getManifest
      ? chrome.runtime.getManifest() : null;
    const exported = this.profilerModel.exportObject(manifest
      ? { pico_ruby_debugger_version: manifest.version } : null);
    const json = JSON.stringify(exported, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = PicoRubyProfilerModel.ProfilerModel.exportFilename();
    link.href = url;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    this.profilerStatus.textContent = `Exported ${exported.records.length} records · ` +
      `${blob.size} bytes`;
  }

  // -- Helper methods --

  appendReplInfo(message) {
    this.clearEmptyState();
    const div = document.createElement('div');
    div.className = 'repl-info';
    div.textContent = message;
    this.replOutput.insertBefore(div, this.currentInputLine);
    this.replOutput.scrollTop = this.replOutput.scrollHeight;
  }

  appendReplError(message) {
    this.clearEmptyState();
    const div = document.createElement('div');
    div.className = 'repl-error';
    div.textContent = message;
    this.replOutput.insertBefore(div, this.currentInputLine);
    this.replOutput.scrollTop = this.replOutput.scrollHeight;
  }

  clearEmptyState() {
    const empty = this.replOutput.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  updateStatus(message, paused) {
    this.status.textContent = message;
    if (paused) {
      this.status.classList.add('paused');
    } else {
      this.status.classList.remove('paused');
    }
  }

  evalInPage(code) {
    return new Promise((resolve, reject) => {
      try {
        chrome.devtools.inspectedWindow.eval(code, (result, exceptionInfo) => {
          if (exceptionInfo) {
            reject(new Error(exceptionInfo.description || 'Eval failed'));
          } else {
            resolve(result);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  escapeHtml(text) {
    if (typeof text !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  copyToClipboard(text, btn) {
    const done = () => {
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('copied');
      }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        this.copyFallback(text);
        done();
      });
    } else {
      this.copyFallback(text);
      done();
    }
  }

  copyFallback(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  // -- Component Debug Mode (Funicular) --

  checkComponentDebugMode() {
    this.evalInPage(`
      (function() {
        if (typeof window.picorubyModule === 'undefined') return { available: false };
        const Module = window.picorubyModule;
        try {
          const code = "global_variables.include?(:$__funicular_debug__) ? 'enabled' : 'disabled'";
          const jsonStr = Module.ccall('mrb_eval_string', 'string', ['string'], [code]);
          const result = JSON.parse(jsonStr);
          return { available: result.result === '"enabled"' };
        } catch(e) {
          return { available: false };
        }
      })()
    `).then(result => {
      if (result.available) {
        this.enableComponentDebug();
      }
    }).catch(() => {});
  }

  enableComponentDebug() {
    if (!this.componentsPanel) return;
    this.componentsPanel.classList.add('visible');
    const h = document.getElementById('sidebarComponentsHandle');
    if (h) h.classList.remove('hidden');
    setTimeout(() => {
      this.refreshComponents();
      this.startComponentAutoRefresh();
    }, 100);
  }

  startComponentAutoRefresh() {
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
    }
    this.autoRefreshInterval = setInterval(() => {
      this.checkAndRefreshComponents();
    }, 500);
  }

  checkAndRefreshComponents() {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          if (!Module || typeof Module.ccall !== 'function') return null;
          return Module.ccall('mrb_get_component_debug_info', 'string',
                              ['string'], ['component_tree']);
        } catch (e) {
          return null;
        }
      })()
    `).then(response => {
      if (!response) return;

      const currentHash = this.simpleHash(response);
      if (this.lastComponentTreeHash !== null &&
          this.lastComponentTreeHash !== currentHash) {
        this.getComponentTree();
      }
      this.lastComponentTreeHash = currentHash;
    }).catch(() => {});
  }

  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + c;
      hash = hash & hash;
    }
    return hash;
  }

  refreshComponents() {
    if (!this.componentsPanel ||
        !this.componentsPanel.classList.contains('visible')) {
      return;
    }
    this.getComponentTree();
  }

  getComponentTree() {
    this.evalInPage(`
      (function() {
        const Module = window.picorubyModule;
        const jsonStr = Module.ccall('mrb_get_component_debug_info', 'string',
                                     ['string'], ['component_tree']);
        return JSON.parse(jsonStr);
      })()
    `).then(response => {
      if (!response.error) {
        const components = typeof response.result === 'string'
          ? JSON.parse(response.result)
          : response.result;
        this.displayComponentTree(components);
      }
    }).catch(() => {});
  }

  displayComponentTree(components) {
    if (!this.componentTree) return;

    if (!components || components.length === 0) {
      this.componentTree.innerHTML = '<div class="empty-state">No components</div>';
      return;
    }

    const componentMap = {};
    components.forEach(comp => { componentMap[comp.id] = comp; });

    const allChildIds = new Set();
    components.forEach(comp => {
      if (comp.children) {
        comp.children.forEach(childId => allChildIds.add(childId));
      }
    });

    const rootComponents = components.filter(comp => !allChildIds.has(comp.id));

    const renderComponent = (comp, depth) => {
      depth = depth || 0;
      const hasChildren = comp.children && comp.children.length > 0;
      const isExpanded = this.expandedComponents.has(comp.id);
      const isSelected = comp.id === this.selectedComponentId;

      let html = `
        <div class="component-item ${isSelected ? 'selected' : ''}"
             data-component-id="${comp.id}"
             style="padding-left: ${depth * 20}px;">
          ${hasChildren
            ? `<span class="tree-toggle ${isExpanded ? 'expanded' : ''}"
                     data-component-id="${comp.id}">${isExpanded ? '\u25BC' : '\u25B6'}</span>`
            : '<span class="tree-spacer"></span>'}
          <span class="component-class">${this.escapeHtml(comp.class)}</span>
          <span class="component-id">#${comp.id}</span>
          ${comp.mounted
            ? '<span class="component-status">\u25CF</span>'
            : '<span class="component-status-unmounted">\u25CB</span>'}
        </div>`;

      if (hasChildren && isExpanded) {
        comp.children.forEach(childId => {
          const child = componentMap[childId];
          if (child) html += renderComponent(child, depth + 1);
        });
      }
      return html;
    };

    this.componentTree.innerHTML = rootComponents
      .map(comp => renderComponent(comp)).join('');

    // Event listeners for component items
    this.componentTree.querySelectorAll('.component-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('tree-toggle')) return;
        const componentId = parseInt(item.dataset.componentId);
        this.selectComponent(componentId, components);
      });
    });

    this.componentTree.querySelectorAll('.tree-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const componentId = parseInt(toggle.dataset.componentId);
        if (this.expandedComponents.has(componentId)) {
          this.expandedComponents.delete(componentId);
        } else {
          this.expandedComponents.add(componentId);
        }
        this.getComponentTree();
      });
    });
  }

  selectComponent(componentId, components) {
    if (this.selectedComponentId === componentId) {
      this.selectedComponentId = null;
      this.componentInspector.innerHTML =
        '<div class="empty-state">Select a component</div>';
      this.getComponentTree();
      return;
    }

    this.selectedComponentId = componentId;
    const component = components.find(c => c.id === componentId);
    if (component && component.children && component.children.length > 0) {
      this.expandedComponents.add(componentId);
    }

    this.inspectComponent(componentId);
    this.getComponentTree();
  }

  inspectComponent(componentId) {
    this.evalInPage(`
      (function() {
        try {
          const Module = window.picorubyModule;
          const jsonStr = Module.ccall('mrb_get_component_state_by_id', 'string',
                                       ['number'], [${componentId}]);
          return JSON.parse(jsonStr);
        } catch(e) {
          return { error: e.toString() };
        }
      })()
    `).then(response => {
      if (response && !response.error) {
        this.displayComponentState(componentId, response.result || response);
      } else {
        this.componentInspector.innerHTML =
          '<div class="empty-state">Error loading component data</div>';
      }
    }).catch(() => {
      this.componentInspector.innerHTML =
        '<div class="empty-state">Error loading component data</div>';
    });
  }

  displayComponentState(componentId, data) {
    if (!this.componentInspector) return;

    const stateEntries = Object.entries(data.state || {});
    const ivarEntries = Object.entries(data.ivars || {});

    let html = `<div style="padding: 4px;"><strong>Component #${componentId}</strong>`;

    if (stateEntries.length > 0) {
      html += '<div class="inspector-section">State</div>';
      stateEntries.forEach(([key, value]) => {
        html += `
          <div class="variable-item">
            <span class="variable-name">${this.escapeHtml(key)}</span>
            <span class="variable-sep">=</span>
            <span class="variable-value">${this.escapeHtml(value)}</span>
          </div>`;
      });
    }

    if (ivarEntries.length > 0) {
      html += '<div class="inspector-section">Instance Variables</div>';
      ivarEntries.forEach(([key, value]) => {
        html += `
          <div class="variable-item">
            <span class="variable-name">${this.escapeHtml(key)}</span>
            <span class="variable-sep">=</span>
            <span class="variable-value">${this.escapeHtml(value)}</span>
          </div>`;
      });
    }

    html += '</div>';
    this.componentInspector.innerHTML = html;
  }
}

const picorubyDebugger = new PicoRubyDebugger();
