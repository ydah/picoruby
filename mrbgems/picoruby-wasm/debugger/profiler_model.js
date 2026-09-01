(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PicoRubyProfilerModel = api;
})(typeof globalThis === 'object' ? globalThis : this, function() {
  const VALID_KINDS = new Set(['span', 'event']);
  const VALID_STATUSES = new Set(['ok', 'error', 'cancelled']);

  function integer(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('protocol_error: invalid ' + name);
    }
    return value;
  }

  function primitive(value) {
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 256;
    if (typeof value === 'number') return Number.isFinite(value);
    return false;
  }

  function scalar(value) {
    if (primitive(value)) return true;
    if (!Array.isArray(value) || value.length > 16) return false;
    let i = 0;
    while (i < value.length) {
      if (!primitive(value[i])) return false;
      i++;
    }
    return true;
  }

  function percentile(values, ratio) {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * ratio) - 1];
  }

  class ProfilerModel {
    constructor(options) {
      const config = options || {};
      this.maxRecords = config.maxRecords || 5000;
      this.maxVisibleRecords = config.maxVisibleRecords || 1000;
      this.filters = { name: '', component: '', status: 'all' };
      this.sort = { by: 'total_us', direction: 'desc' };
      this.clearLocal();
    }

    clearLocal() {
      this.schemaVersion = 1;
      this.profilerVersion = null;
      this.sessionId = null;
      this.recording = false;
      this.cursor = 0;
      this.records = [];
      this.recordById = new Map();
      this.summaryGroups = [];
      this.selectedRecordId = null;
      this.connectionState = 'loading';
      this.counters = {};
      this.cursorGap = false;
      this.clientEvictedCount = 0;
      this.protocolWarningCount = 0;
    }

    profilerVersionFrom(payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, 'profiler_version')) return undefined;
      if (typeof payload.profiler_version !== 'string' ||
          payload.profiler_version.length === 0 || payload.profiler_version.length > 64) {
        throw new Error('protocol_error: invalid profiler_version');
      }
      return payload.profiler_version;
    }

    normalizeRecord(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('invalid record');
      }
      if (record.schema_version !== 1) {
        throw new Error('invalid record schema');
      }
      const seq = integer(record.seq, 'record seq');
      if (!VALID_KINDS.has(record.kind) || !VALID_STATUSES.has(record.status) ||
          typeof record.id !== 'string' || record.id.length === 0 ||
          typeof record.name !== 'string' ||
          (record.parent_id !== null && typeof record.parent_id !== 'string')) {
        throw new Error('invalid record fields');
      }
      const attributes = record.attributes;
      if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
        throw new Error('invalid attributes');
      }
      const keys = Object.keys(attributes);
      if (keys.length > 24) throw new Error('too many attributes');
      const sanitizedAttributes = Object.create(null);
      let i = 0;
      while (i < keys.length) {
        const key = keys[i];
        if (key.length > 64 || !scalar(attributes[key])) {
          throw new Error('invalid attribute');
        }
        sanitizedAttributes[key] = Array.isArray(attributes[key])
          ? attributes[key].slice() : attributes[key];
        i++;
      }
      return {
        schema_version: 1,
        seq,
        kind: record.kind,
        id: record.id.slice(0, 256),
        parent_id: typeof record.parent_id === 'string' ? record.parent_id.slice(0, 256) : null,
        name: record.name.slice(0, 128),
        started_at_us: integer(record.started_at_us, 'started_at_us'),
        duration_us: integer(record.duration_us, 'duration_us'),
        status: record.status,
        attributes: sanitizedAttributes,
      };
    }

    applySnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('protocol_error: snapshot must be an object');
      }
      if (snapshot.error) throw new Error(snapshot.error);
      if (snapshot.schema_version !== 1) throw new Error('unsupported_schema');
      if (!Array.isArray(snapshot.records)) throw new Error('protocol_error: records');
      if (snapshot.records.length > 200 || typeof snapshot.recording !== 'boolean' ||
          typeof snapshot.cursor_gap !== 'boolean' || typeof snapshot.has_more !== 'boolean') {
        throw new Error('protocol_error: snapshot fields');
      }

      const previousCursor = this.cursor;
      if (integer(snapshot.cursor, 'cursor') !== previousCursor) {
        throw new Error('protocol_error: cursor mismatch');
      }
      const sessionId = integer(snapshot.session_id, 'session_id');
      const profilerVersion = this.profilerVersionFrom(snapshot);
      if (this.sessionId !== null && sessionId !== this.sessionId) {
        this.clearLocal();
        if (profilerVersion !== undefined) this.profilerVersion = profilerVersion;
        this.sessionId = sessionId;
        this.recording = Boolean(snapshot.recording);
        this.connectionState = 'connected';
        return { hasMore: true, added: 0, sessionReset: true };
      }

      const normalized = [];
      const knownSeqs = new Set(this.records.map(record => record.seq));
      const knownIds = new Set(this.records.map(record => record.id));
      let warningCount = 0;
      let i = 0;
      while (i < snapshot.records.length) {
        try {
          const record = this.normalizeRecord(snapshot.records[i]);
          if (knownIds.has(record.id) && !knownSeqs.has(record.seq)) {
            warningCount++;
          } else if (record.seq <= previousCursor && !knownSeqs.has(record.seq)) {
            warningCount++;
          } else if (!knownSeqs.has(record.seq)) {
            normalized.push(record);
            knownSeqs.add(record.seq);
            knownIds.add(record.id);
          }
        } catch (_) {
          warningCount++;
        }
        i++;
      }
      normalized.sort((a, b) => a.seq - b.seq);

      const nextCursor = integer(snapshot.next_cursor, 'next_cursor');
      if (nextCursor < previousCursor ||
          ((snapshot.has_more || normalized.length > 0) && nextCursor === previousCursor) ||
          (normalized.length > 0 && normalized[normalized.length - 1].seq > nextCursor)) {
        throw new Error('protocol_error: cursor did not advance');
      }

      if (profilerVersion !== undefined) this.profilerVersion = profilerVersion;
      this.sessionId = sessionId;
      this.recording = Boolean(snapshot.recording);
      if (snapshot.cursor_gap) {
        this.records = [];
        this.recordById.clear();
        this.selectedRecordId = null;
        this.cursorGap = true;
      }
      this.protocolWarningCount += warningCount;
      i = 0;
      while (i < normalized.length) {
        const record = normalized[i];
        this.records.push(record);
        this.recordById.set(record.id, record);
        i++;
      }

      this.cursor = nextCursor;
      this.evictRecords();

      const counterNames = [
        'dropped_count', 'dropped_in_flight_count', 'truncated_attribute_count',
        'adapter_error_count', 'corrupt_record_count',
      ];
      i = 0;
      while (i < counterNames.length) {
        const key = counterNames[i];
        if (Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0) {
          this.counters[key] = snapshot[key];
        }
        i++;
      }
      this.connectionState = 'connected';
      return { hasMore: Boolean(snapshot.has_more), added: normalized.length };
    }

    evictRecords() {
      const excess = this.records.length - this.maxRecords;
      if (excess <= 0) return;
      const evicted = this.records.splice(0, excess);
      let i = 0;
      while (i < evicted.length) {
        this.recordById.delete(evicted[i].id);
        i++;
      }
      this.clientEvictedCount += excess;
      if (this.selectedRecordId && !this.recordById.has(this.selectedRecordId)) {
        this.selectedRecordId = null;
      }
    }

    applySummary(summary) {
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
        throw new Error('protocol_error: summary must be an object');
      }
      if (summary.schema_version !== 1) throw new Error('unsupported_schema');
      if (!Array.isArray(summary.groups) || typeof summary.recording !== 'boolean') {
        throw new Error('protocol_error: summary fields');
      }
      const sessionId = integer(summary.session_id, 'session_id');
      const profilerVersion = this.profilerVersionFrom(summary);
      const groups = [];
      let warnings = 0;
      let i = 0;
      while (i < summary.groups.length && i < 500) {
        try {
          groups.push(this.normalizeGroup(summary.groups[i]));
        } catch (_) {
          warnings++;
        }
        i++;
      }
      if (this.sessionId !== null && sessionId !== this.sessionId) this.clearLocal();
      if (profilerVersion !== undefined) this.profilerVersion = profilerVersion;
      this.sessionId = sessionId;
      this.recording = Boolean(summary.recording);
      this.summaryGroups = groups;
      this.protocolWarningCount += warnings;
      const counterNames = ['dropped_count', 'dropped_in_flight_count', 'record_count'];
      i = 0;
      while (i < counterNames.length) {
        const key = counterNames[i];
        if (Number.isSafeInteger(summary[key]) && summary[key] >= 0) {
          this.counters[key] = summary[key];
        }
        i++;
      }
    }

    setFilters(filters) {
      const next = filters || {};
      this.filters = {
        name: String(next.name || '').slice(0, 128).toLowerCase(),
        component: String(next.component || '').slice(0, 128).toLowerCase(),
        status: VALID_STATUSES.has(next.status) ? next.status : 'all',
      };
    }

    visibleRecords(options) {
      const limit = Math.min((options && options.limit) || this.maxVisibleRecords,
                             this.maxVisibleRecords);
      const result = [];
      let i = 0;
      while (i < this.records.length) {
        const record = this.records[i];
        const component = String(record.attributes['funicular.component.class'] || '').toLowerCase();
        if ((!this.filters.name || record.name.toLowerCase().includes(this.filters.name)) &&
            (!this.filters.component || component.includes(this.filters.component)) &&
            (this.filters.status === 'all' || record.status === this.filters.status)) {
          result.push(record);
        }
        i++;
      }
      result.sort((left, right) =>
        left.started_at_us - right.started_at_us || left.seq - right.seq);
      return result.slice(Math.max(0, result.length - limit));
    }

    summaryRows() {
      if (this.records.length === 0 && this.summaryGroups.length > 0) {
        return this.sortRows(this.summaryGroups.slice());
      }
      const groups = new Map();
      let i = 0;
      while (i < this.records.length) {
        const record = this.records[i];
        const component = String(record.attributes['funicular.component.class'] || '');
        const key = record.name + '\0' + component;
        let group = groups.get(key);
        if (!group) {
          group = { name: record.name, component_class: component, count: 0,
            error_count: 0, empty_diff_count: 0, total_us: 0, max_us: 0,
            durations: [] };
          groups.set(key, group);
        }
        group.count++;
        group.total_us += record.duration_us;
        group.max_us = Math.max(group.max_us, record.duration_us);
        if (record.status === 'error') group.error_count++;
        if (record.attributes['funicular.diff.empty'] === true) group.empty_diff_count++;
        group.durations.push(record.duration_us);
        i++;
      }
      const rows = [];
      groups.forEach(group => {
        group.average_us = group.count ? Math.round(group.total_us / group.count) : 0;
        group.p50_us = percentile(group.durations, 0.5);
        group.p95_us = percentile(group.durations, 0.95);
        group.empty_diff_rate = group.count ? group.empty_diff_count / group.count : 0;
        delete group.durations;
        rows.push(group);
      });
      return this.sortRows(rows);
    }

    normalizeGroup(group) {
      if (!group || typeof group !== 'object' || Array.isArray(group) ||
          typeof group.name !== 'string' ||
          (group.component_class != null && typeof group.component_class !== 'string')) {
        throw new Error('invalid summary group');
      }
      const count = integer(group.count, 'summary count');
      const errorCount = integer(group.error_count, 'summary error_count');
      const emptyDiffCount = integer(group.empty_diff_count, 'summary empty_diff_count');
      const total = integer(group.total_us, 'summary total_us');
      const max = integer(group.max_us, 'summary max_us');
      const p50 = integer(group.p50_us, 'summary p50_us');
      const p95 = integer(group.p95_us, 'summary p95_us');
      if (errorCount > count || emptyDiffCount > count) {
        throw new Error('invalid summary counters');
      }
      return {
        name: group.name.slice(0, 128),
        component_class: (group.component_class || '').slice(0, 128),
        count,
        error_count: errorCount,
        empty_diff_count: emptyDiffCount,
        total_us: total,
        average_us: count ? Math.round(total / count) : 0,
        max_us: max,
        p50_us: p50,
        p95_us: p95,
        empty_diff_rate: count ? emptyDiffCount / count : 0,
      };
    }

    setSort(by, direction) {
      this.sort = { by, direction: direction === 'asc' ? 'asc' : 'desc' };
    }

    sortRows(rows) {
      const by = this.sort.by;
      const multiplier = this.sort.direction === 'asc' ? 1 : -1;
      return rows.map((row, index) => ({ row, index })).sort((a, b) => {
        const left = a.row[by];
        const right = b.row[by];
        if (left === right) return a.index - b.index;
        return (typeof left === 'string' ? left.localeCompare(right) : left - right) * multiplier;
      }).map(item => item.row);
    }

    selectRecord(id) {
      this.selectedRecordId = this.recordById.has(id) ? id : null;
      return this.selectedRecordId ? this.recordById.get(this.selectedRecordId) : null;
    }

    exportObject(metadata) {
      const incompleteCounters = [
        'dropped_count', 'dropped_in_flight_count', 'corrupt_record_count',
        'adapter_error_count', 'truncated_attribute_count',
      ];
      let incomplete = this.cursorGap || this.clientEvictedCount > 0 ||
        this.protocolWarningCount > 0;
      let i = 0;
      while (!incomplete && i < incompleteCounters.length) {
        incomplete = (this.counters[incompleteCounters[i]] || 0) > 0;
        i++;
      }
      const exported = {
        format: 'picoruby-funicular-profile',
        format_version: 1,
        exported_at: new Date().toISOString(),
        profiler_schema_version: this.schemaVersion,
        session_id: this.sessionId,
        incomplete,
        counters: Object.assign({}, this.counters, {
          client_evicted_count: this.clientEvictedCount,
          protocol_warning_count: this.protocolWarningCount,
        }),
        records: this.records.slice(),
      };
      if (this.profilerVersion) exported.profiler_version = this.profilerVersion;
      if (metadata && typeof metadata.pico_ruby_debugger_version === 'string' &&
          metadata.pico_ruby_debugger_version.length > 0 &&
          metadata.pico_ruby_debugger_version.length <= 64) {
        exported.pico_ruby_debugger_version = metadata.pico_ruby_debugger_version;
      }
      return exported;
    }

    statusText() {
      if (this.connectionState === 'loading') return 'Loading...';
      if (this.connectionState === 'reconnecting') return 'Reconnecting...';
      if (this.connectionState === 'unavailable') return 'Profiler not installed';
      const dropped = this.counters.dropped_count || 0;
      return `${this.recording ? 'Recording' : 'Stopped'} · ` +
        `${this.records.length} records · ${dropped} dropped`;
    }

    static formatDuration(microseconds) {
      if (microseconds < 1000) return microseconds + ' µs';
      if (microseconds < 1000000) return (microseconds / 1000).toFixed(2) + ' ms';
      return (microseconds / 1000000).toFixed(2) + ' s';
    }

    static exportFilename(date) {
      const iso = (date || new Date()).toISOString();
      const day = iso.slice(0, 10).replace(/-/g, '');
      const time = iso.slice(11, 19).replace(/:/g, '');
      return `funicular-profile-${day}-${time}.json`;
    }
  }

  return { ProfilerModel };
});
