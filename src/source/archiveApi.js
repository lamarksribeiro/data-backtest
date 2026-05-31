export function canPublishArchiveStatus(config) {
  return Boolean(config.dataCollectorApiUrl && config.dataCollectorArchiveApiKey);
}

export async function publishEventArchiveStatus(config, payload) {
  if (!canPublishArchiveStatus(config)) return { skipped: true, reason: 'archive_api_not_configured' };
  const baseUrl = String(config.dataCollectorApiUrl).replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/api/archive/status`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.dataCollectorArchiveApiKey,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`archive status publish failed: HTTP ${response.status} ${text}`);
  }
  return response.json();
}

export async function publishPartitionArchiveStatus({ config, partition, events, exportResult }) {
  if (!canPublishArchiveStatus(config)) return { skipped: true, reason: 'archive_api_not_configured', published: 0 };
  if (exportResult.status !== 'valid') return { skipped: true, reason: `partition_status_${exportResult.status}`, published: 0 };

  let published = 0;
  for (const event of events) {
    await publishEventArchiveStatus(config, {
      market_id: partition.marketId,
      condition_id: event.conditionId,
      event_start: event.eventStart,
      event_end: event.eventEnd,
      status: 'valid',
      datasets: {
        backtest_ticks: {
          status: 'valid',
          rows: exportResult.rows,
          expected_rows: exportResult.expectedRows,
          book_depth: partition.bookDepth,
          dt: partition.dt,
        },
      },
      active_paths: {
        backtest_ticks: exportResult.activePath,
      },
      source_fingerprint: exportResult.sourceFingerprint,
    });
    published += 1;
  }
  return { skipped: false, published };
}
