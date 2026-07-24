import fs from 'fs';

const reportDir = process.argv[2];
const ids = new Set([
  '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
  '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
].map((s) => s.toLowerCase()));

const starts = new Set([
  '2026-07-24T22:15:00.000Z',
  '2026-07-24T22:45:00.000Z',
]);

const results = JSON.parse(fs.readFileSync(`${reportDir}/results.json`, 'utf8'));
const top = JSON.parse(fs.readFileSync(`${reportDir}/top-results.json`, 'utf8'));

console.log('resultsKeys', Array.isArray(results) ? `array:${results.length}` : Object.keys(results));
console.log('topKeys', Array.isArray(top) ? `array:${top.length}` : Object.keys(top));

const hits = [];
function walk(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    return;
  }
  const cid = String(obj.condition_id || obj.conditionId || obj.eventId || '').toLowerCase();
  const es = obj.event_start || obj.eventStart;
  const esIso = es ? new Date(es).toISOString() : null;
  if ((cid && ids.has(cid)) || (esIso && starts.has(esIso))) {
    hits.push({ path, obj });
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'ticks' || k === 'series' || k === 'columnSets') continue;
    walk(v, `${path}.${k}`);
  }
}

walk(results, 'results');
walk(top, 'top');
console.log('hits', hits.length);
for (const h of hits) {
  console.log('---', h.path);
  console.log(JSON.stringify(h.obj, null, 2).slice(0, 4000));
}

// also dump sample event shape from first variant
const sample = Array.isArray(results)
  ? results[0]
  : results.variants?.[0] || results.results?.[0] || results;
console.log('sampleTopLevel', JSON.stringify(sample, null, 2).slice(0, 2000));
