export function createTraceCollector({ limits = {} } = {}) {
  const maxLogs = limits.maxLogsPerEvent ?? 200;
  const maxMarks = limits.maxMarksPerEvent ?? 200;
  const logs = [];
  const marks = [];
  const metrics = {};

  return {
    log(name, value, ts) {
      if (logs.length >= maxLogs) return;
      logs.push({
        ts: typeof ts === 'string' ? ts : new Date(ts).toISOString(),
        level: 'info',
        name: String(name),
        value,
      });
    },
    mark(name, data, ts) {
      if (marks.length >= maxMarks) return;
      marks.push({
        ts: typeof ts === 'string' ? ts : new Date(ts).toISOString(),
        name: String(name),
        data: data ?? {},
      });
    },
    metric(name, value, ts) {
      const key = String(name);
      if (!metrics[key]) metrics[key] = [];
      metrics[key].push({
        ts: typeof ts === 'string' ? ts : new Date(ts).toISOString(),
        value: Number(value)
      });
    },
    snapshot() {
      return {
        logs,
        marks,
        metrics,
      };
    },
    reset() {
      logs.length = 0;
      marks.length = 0;
      for (const key of Object.keys(metrics)) delete metrics[key];
    },
  };
}
