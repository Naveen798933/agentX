import crypto from 'node:crypto';

/**
 * OpenTelemetry W3C TraceContext parser and generator
 * Format: 00-${traceId}-${spanId}-${flags}
 */
export class TraceContext {
  static parse(traceparent) {
    if (!traceparent || typeof traceparent !== 'string') return null;
    const parts = traceparent.trim().split('-');
    if (parts.length !== 4 || parts[0] !== '00') return null;
    const [version, traceId, spanId, flags] = parts;
    if (traceId.length !== 32 || spanId.length !== 16) return null;
    return { version, traceId, spanId, flags };
  }

  static generate(parent = null) {
    const traceId = parent?.traceId || crypto.randomBytes(16).toString('hex');
    const spanId = crypto.randomBytes(8).toString('hex');
    const flags = '01'; // sampled
    return {
      traceId,
      spanId,
      parentSpanId: parent?.spanId || null,
      flags,
      traceparent: `00-${traceId}-${spanId}-${flags}`
    };
  }
}

/**
 * OpenTelemetry Span
 */
export class Span {
  constructor(name, context, attributes = {}) {
    this.name = name;
    this.context = context;
    this.attributes = { ...attributes };
    this.events = [];
    this.status = { code: 'UNSET' };
    this.startTimeNs = process.hrtime.bigint();
    this.endTimeNs = null;
    this.durationMs = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs = {}) {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name, attributes = {}) {
    this.events.push({
      name,
      attributes,
      time: new Date().toISOString()
    });
    return this;
  }

  setStatus(status) {
    this.status = typeof status === 'string' ? { code: status } : status;
    return this;
  }

  recordException(error) {
    this.setStatus({ code: 'ERROR', message: error?.message });
    this.addEvent('exception', {
      'exception.type': error?.name || 'Error',
      'exception.message': error?.message || String(error),
      'exception.stacktrace': error?.stack || ''
    });
    return this;
  }

  end() {
    if (this.endTimeNs !== null) return;
    this.endTimeNs = process.hrtime.bigint();
    this.durationMs = Number(this.endTimeNs - this.startTimeNs) / 1_000_000;
    if (this.status.code === 'UNSET') {
      this.status.code = 'OK';
    }
  }

  toJSON() {
    return {
      name: this.name,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      durationMs: this.durationMs,
      status: this.status,
      attributes: this.attributes,
      events: this.events
    };
  }
}

/**
 * Metric Instruments (Counters, Histograms, Gauges)
 */
class MetricInstrument {
  constructor(name, help, type) {
    this.name = name;
    this.help = help;
    this.type = type;
  }

  _labelKey(labels = {}) {
    const keys = Object.keys(labels).sort();
    return keys.map(k => `${k}="${labels[k]}"`).join(',');
  }
}

export class Counter extends MetricInstrument {
  constructor(name, help) {
    super(name, help, 'counter');
    this.values = new Map(); // labelKey -> number
  }

  inc(labels = {}, amount = 1) {
    if (amount < 0) throw new Error('Counter cannot be decremented');
    const key = this._labelKey(labels);
    const curr = this.values.get(key) || { labels, val: 0 };
    curr.val += amount;
    this.values.set(key, curr);
  }

  get(labels = {}) {
    const key = this._labelKey(labels);
    return this.values.get(key)?.val || 0;
  }

  reset() {
    this.values.clear();
  }
}

export class Gauge extends MetricInstrument {
  constructor(name, help) {
    super(name, help, 'gauge');
    this.values = new Map();
  }

  set(labels = {}, value = 0) {
    const key = this._labelKey(labels);
    this.values.set(key, { labels, val: Number(value) });
  }

  inc(labels = {}, amount = 1) {
    const key = this._labelKey(labels);
    const curr = this.values.get(key) || { labels, val: 0 };
    curr.val += amount;
    this.values.set(key, curr);
  }

  dec(labels = {}, amount = 1) {
    this.inc(labels, -amount);
  }

  get(labels = {}) {
    const key = this._labelKey(labels);
    return this.values.get(key)?.val || 0;
  }

  reset() {
    this.values.clear();
  }
}

export class Histogram extends MetricInstrument {
  constructor(name, help, buckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]) {
    super(name, help, 'histogram');
    this.buckets = buckets;
    this.series = new Map(); // labelKey -> { count, sum, bucketCounts }
  }

  observe(labels = {}, value = 0) {
    const key = this._labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = {
        labels,
        count: 0,
        sum: 0,
        min: Infinity,
        max: -Infinity,
        bucketCounts: new Array(this.buckets.length).fill(0)
      };
      this.series.set(key, s);
    }

    s.count++;
    s.sum += value;
    if (value < s.min) s.min = value;
    if (value > s.max) s.max = value;

    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        s.bucketCounts[i]++;
      }
    }
  }

  get(labels = {}) {
    const key = this._labelKey(labels);
    return this.series.get(key) || { count: 0, sum: 0 };
  }

  reset() {
    this.series.clear();
  }
}

/**
 * TelemetryManager
 * Centralized OpenTelemetry tracing and metrics registry.
 */
export class TelemetryManager {
  constructor(options = {}) {
    this.serviceName = options.serviceName || 'pulse-platform';
    this.recentSpans = [];
    this.maxRecentSpans = options.maxRecentSpans || 100;

    // Standard Metrics
    this.httpRequestsTotal = new Counter('http_requests_total', 'Total number of HTTP requests processed');
    this.httpRequestDuration = new Histogram('http_request_duration_seconds', 'HTTP request latency in seconds', [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]);

    this.llmTokensTotal = new Counter('llm_tokens_total', 'Total LLM tokens consumed across models');
    this.llmGenerationDuration = new Histogram('llm_generation_duration_seconds', 'LLM generation duration in seconds', [0.1, 0.5, 1, 2, 5, 10, 20]);

    this.queueJobsTotal = new Counter('queue_jobs_total', 'Total queue jobs processed');
    this.queueJobDuration = new Histogram('queue_job_duration_seconds', 'Queue job execution duration in seconds', [0.5, 1, 5, 15, 30, 60, 120]);

    this.sandboxRunsTotal = new Counter('sandbox_runs_total', 'Total sandbox execution commands');
    this.sandboxDuration = new Histogram('sandbox_duration_seconds', 'Sandbox command execution duration in seconds', [0.05, 0.1, 0.5, 1, 5, 15]);

    this.deploymentsTotal = new Counter('deployments_total', 'Total application deployments attempted');
    this.usageEventsTotal = new Counter('usage_events_total', 'Total usage meter events recorded');

    // Gauges
    this.activePreviewsGauge = new Gauge('active_previews_count', 'Number of currently active HTTP preview servers');
    this.activeWorkersGauge = new Gauge('active_workers_count', 'Number of active background worker processes');
    this.activeConcurrentJobsGauge = new Gauge('active_concurrent_jobs', 'Active concurrent generation jobs by tenant');
  }

  /**
   * Start a new OpenTelemetry tracing span
   */
  startSpan(name, attributes = {}, parentTraceparent = null) {
    const parent = parentTraceparent ? TraceContext.parse(parentTraceparent) : null;
    const context = TraceContext.generate(parent);
    const span = new Span(name, context, {
      'service.name': this.serviceName,
      ...attributes
    });

    const originalEnd = span.end.bind(span);
    span.end = () => {
      originalEnd();
      this.recentSpans.push(span.toJSON());
      if (this.recentSpans.length > this.maxRecentSpans) {
        this.recentSpans.shift();
      }
    };

    return span;
  }

  // ── High-level Domain Metrics Helpers ─────────────────────────────────────
  recordHttpRequest({ method, path, status, durationSeconds }) {
    const cleanPath = path ? path.split('?')[0].replace(/\/[a-zA-Z0-9_-]{20,}/g, '/:id') : 'unknown';
    const labels = { method: (method || 'GET').toUpperCase(), path: cleanPath, status: String(status || 200) };
    this.httpRequestsTotal.inc(labels, 1);
    this.httpRequestDuration.observe(labels, Number(durationSeconds || 0));
  }

  recordLlmGeneration({ tenantId = 'tenant-default', model = 'gemini', promptTokens = 0, completionTokens = 0, totalTokens = 0, durationSeconds = 0 }) {
    if (promptTokens > 0) {
      this.llmTokensTotal.inc({ tenant_id: tenantId, model, type: 'prompt' }, promptTokens);
    }
    if (completionTokens > 0) {
      this.llmTokensTotal.inc({ tenant_id: tenantId, model, type: 'completion' }, completionTokens);
    }
    const computedTotal = totalTokens || (promptTokens + completionTokens);
    if (computedTotal > 0) {
      this.llmTokensTotal.inc({ tenant_id: tenantId, model, type: 'total' }, computedTotal);
    }
    this.llmGenerationDuration.observe({ tenant_id: tenantId, model }, Number(durationSeconds || 0));
  }

  recordQueueJob({ queue = 'project-generation', status = 'completed', durationSeconds = 0 }) {
    const labels = { queue, status };
    this.queueJobsTotal.inc(labels, 1);
    this.queueJobDuration.observe(labels, Number(durationSeconds || 0));
  }

  recordSandboxRun({ outcome = 'success', durationSeconds = 0 }) {
    const labels = { outcome }; // 'success' | 'failure' | 'timeout'
    this.sandboxRunsTotal.inc(labels, 1);
    this.sandboxDuration.observe(labels, Number(durationSeconds || 0));
  }

  recordDeployment({ provider = 'mock', environment = 'preview', status = 'DEPLOYED' }) {
    this.deploymentsTotal.inc({ provider, environment, status }, 1);
  }

  recordUsageEventMetric({ tenantId = 'tenant-default', eventType = 'UNKNOWN' }) {
    this.usageEventsTotal.inc({ tenant_id: tenantId, event_type: eventType }, 1);
  }

  setActivePreviews(count) {
    this.activePreviewsGauge.set({}, Number(count || 0));
  }

  setConcurrentJobs(tenantId, count) {
    this.activeConcurrentJobsGauge.set({ tenant_id: tenantId || 'tenant-default' }, Number(count || 0));
  }

  /**
   * Format all collected metrics into standard Prometheus text format
   */
  toPrometheusFormat() {
    const lines = [];

    const formatInstrument = (instrument) => {
      lines.push(`# HELP ${instrument.name} ${instrument.help}`);
      lines.push(`# TYPE ${instrument.name} ${instrument.type}`);

      if (instrument.type === 'counter' || instrument.type === 'gauge') {
        if (instrument.values.size === 0) {
          lines.push(`${instrument.name} 0`);
        } else {
          for (const item of instrument.values.values()) {
            const labelStr = Object.keys(item.labels).length > 0
              ? `{${Object.entries(item.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}`
              : '';
            lines.push(`${instrument.name}${labelStr} ${item.val}`);
          }
        }
      } else if (instrument.type === 'histogram') {
        if (instrument.series.size === 0) {
          lines.push(`${instrument.name}_count 0`);
          lines.push(`${instrument.name}_sum 0`);
        } else {
          for (const s of instrument.series.values()) {
            const baseLabels = Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`);
            for (let i = 0; i < instrument.buckets.length; i++) {
              const b = instrument.buckets[i];
              const bLabels = [...baseLabels, `le="${b}"`].join(',');
              lines.push(`${instrument.name}_bucket{${bLabels}} ${s.bucketCounts[i]}`);
            }
            const infLabels = [...baseLabels, `le="+Inf"`].join(',');
            lines.push(`${instrument.name}_bucket{${infLabels}} ${s.count}`);
            const countLabels = baseLabels.length > 0 ? `{${baseLabels.join(',')}}` : '';
            lines.push(`${instrument.name}_count${countLabels} ${s.count}`);
            lines.push(`${instrument.name}_sum${countLabels} ${s.sum.toFixed(4)}`);
          }
        }
      }
    };

    [
      this.httpRequestsTotal,
      this.httpRequestDuration,
      this.llmTokensTotal,
      this.llmGenerationDuration,
      this.queueJobsTotal,
      this.queueJobDuration,
      this.sandboxRunsTotal,
      this.sandboxDuration,
      this.deploymentsTotal,
      this.usageEventsTotal,
      this.activePreviewsGauge,
      this.activeWorkersGauge,
      this.activeConcurrentJobsGauge
    ].forEach(formatInstrument);

    return lines.join('\n') + '\n';
  }

  /**
   * Return metrics as JSON data for internal dashboards and APIs
   */
  toJSON() {
    const serializeMetric = (inst) => {
      if (inst.type === 'counter' || inst.type === 'gauge') {
        const items = [];
        for (const item of inst.values.values()) {
          items.push({ labels: item.labels, value: item.val });
        }
        return { name: inst.name, help: inst.help, type: inst.type, items };
      }
      if (inst.type === 'histogram') {
        const series = [];
        for (const s of inst.series.values()) {
          series.push({
            labels: s.labels,
            count: s.count,
            sum: s.sum,
            avg: s.count > 0 ? s.sum / s.count : 0,
            min: s.min === Infinity ? 0 : s.min,
            max: s.max === -Infinity ? 0 : s.max
          });
        }
        return { name: inst.name, help: inst.help, type: inst.type, series };
      }
    };

    return {
      service: this.serviceName,
      timestamp: new Date().toISOString(),
      metrics: {
        httpRequests: serializeMetric(this.httpRequestsTotal),
        httpRequestDuration: serializeMetric(this.httpRequestDuration),
        llmTokens: serializeMetric(this.llmTokensTotal),
        llmGenerationDuration: serializeMetric(this.llmGenerationDuration),
        queueJobs: serializeMetric(this.queueJobsTotal),
        queueJobDuration: serializeMetric(this.queueJobDuration),
        sandboxRuns: serializeMetric(this.sandboxRunsTotal),
        deployments: serializeMetric(this.deploymentsTotal),
        usageEvents: serializeMetric(this.usageEventsTotal),
        activePreviews: serializeMetric(this.activePreviewsGauge),
        activeConcurrentJobs: serializeMetric(this.activeConcurrentJobsGauge)
      },
      recentSpansCount: this.recentSpans.length
    };
  }
}

// Global default telemetry singleton
export const telemetry = new TelemetryManager();
