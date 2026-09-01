(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PicoRubyProfilerTransport = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  const COMMANDS = new Set(['start', 'stop', 'clear', 'status']);

  class ProfilerTransport {
    constructor(evalInPage) {
      this.evalInPage = evalInPage;
      this.generation = 0;
      this.activeRequest = null;
    }

    resetGeneration() {
      this.generation++;
      this.activeRequest = null;
      return this.generation;
    }

    async call(code, generation) {
      const requestGeneration = generation === undefined ? this.generation : generation;
      if (requestGeneration !== this.generation) return null;
      if (this.activeRequest) throw new Error('request_in_flight');
      const request = { generation: requestGeneration };
      this.activeRequest = request;
      let result;
      try {
        result = await this.evalInPage(code);
      } catch (_) {
        if (requestGeneration !== this.generation) return null;
        throw new Error('devtools_eval_error');
      } finally {
        if (this.activeRequest === request) this.activeRequest = null;
      }
      if (requestGeneration !== this.generation) return null;
      if (!result || typeof result !== 'object') throw new Error('protocol_error');
      return result;
    }

    checkProfilerAvailability(generation) {
      return this.call(`(function() {
        try {
          const Module = window.picorubyModule;
          if (!Module) return { error: 'module_unavailable' };
          if (typeof Module.ccall !== 'function' ||
              typeof Module._mrb_funicular_profiler_available === 'undefined')
            return { error: 'debug_api_unavailable' };
          try {
            return { available: Module.ccall(
              'mrb_funicular_profiler_available', 'number', [], []) === 1 };
          } catch (_) { return { error: 'ccall_error' }; }
        } catch (_) { return { error: 'module_unavailable' }; }
      })()`, generation);
    }

    fetchSnapshot(afterSeq, limit, generation) {
      const numericCursor = Number(afterSeq);
      const numericLimit = Number(limit);
      const cursor = Number.isFinite(numericCursor)
        ? Math.max(0, Math.min(0xffffffff, Math.floor(numericCursor))) : 0;
      const pageSize = Number.isFinite(numericLimit)
        ? Math.max(1, Math.min(200, Math.floor(numericLimit))) : 200;
      return this.call(`(function() {
        const Module = window.picorubyModule;
        if (!Module) return { error: 'module_unavailable' };
        if (typeof Module.ccall !== 'function') return { error: 'debug_api_unavailable' };
        let json;
        try {
          json = Module.ccall('mrb_funicular_profiler_snapshot', 'string',
            ['number', 'number'], [${cursor}, ${pageSize}]);
        } catch (_) { return { error: 'ccall_error' }; }
        try { return JSON.parse(json); }
        catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }

    fetchSummary(generation) {
      return this.call(`(function() {
        const Module = window.picorubyModule;
        if (!Module) return { error: 'module_unavailable' };
        if (typeof Module.ccall !== 'function') return { error: 'debug_api_unavailable' };
        let json;
        try {
          json = Module.ccall('mrb_funicular_profiler_summary', 'string', [], []);
        } catch (_) { return { error: 'ccall_error' }; }
        try { return JSON.parse(json); }
        catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }

    async fetchSnapshotPages(afterSeq, generation, applySnapshot) {
      let cursor = afterSeq;
      let hasMore = true;
      let pages = 0;
      while (hasMore && pages < 5) {
        const snapshot = await this.fetchSnapshot(cursor, 200, generation);
        if (!snapshot) return null;
        if (snapshot.error) throw new Error(snapshot.error);
        const applied = applySnapshot(snapshot);
        hasMore = applied.hasMore;
        cursor = applied.sessionReset ? 0 : snapshot.next_cursor;
        pages++;
      }
      return { hasMore, pages };
    }

    control(command, generation) {
      if (!COMMANDS.has(command)) return Promise.reject(new Error('unknown_command'));
      return this.call(`(function() {
        const Module = window.picorubyModule;
        if (!Module) return { error: 'module_unavailable' };
        if (typeof Module.ccall !== 'function') return { error: 'debug_api_unavailable' };
        let json;
        try {
          json = Module.ccall('mrb_funicular_profiler_control', 'string',
            ['string'], ['${command}']);
        } catch (_) { return { error: 'ccall_error' }; }
        try { return JSON.parse(json); }
        catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }
  }

  return { ProfilerTransport };
});
