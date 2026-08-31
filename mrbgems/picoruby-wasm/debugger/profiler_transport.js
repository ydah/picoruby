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
    }

    resetGeneration() {
      this.generation++;
      return this.generation;
    }

    async call(code, generation) {
      let result;
      try {
        result = await this.evalInPage(code);
      } catch (error) {
        if (generation !== undefined && generation !== this.generation) return null;
        throw error;
      }
      if (generation !== undefined && generation !== this.generation) return null;
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
          return { available: Module.ccall(
            'mrb_funicular_profiler_available', 'number', [], []) === 1 };
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
        try {
          const Module = window.picorubyModule;
          const json = Module.ccall('mrb_funicular_profiler_snapshot', 'string',
            ['number', 'number'], [${cursor}, ${pageSize}]);
          return JSON.parse(json);
        } catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }

    fetchSummary(generation) {
      return this.call(`(function() {
        try {
          const Module = window.picorubyModule;
          const json = Module.ccall('mrb_funicular_profiler_summary', 'string', [], []);
          return JSON.parse(json);
        } catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }

    control(command, generation) {
      if (!COMMANDS.has(command)) return Promise.reject(new Error('unknown_command'));
      return this.call(`(function() {
        try {
          const Module = window.picorubyModule;
          const json = Module.ccall('mrb_funicular_profiler_control', 'string',
            ['string'], ['${command}']);
          return JSON.parse(json);
        } catch (_) { return { error: 'invalid_json' }; }
      })()`, generation);
    }
  }

  return { ProfilerTransport };
});
