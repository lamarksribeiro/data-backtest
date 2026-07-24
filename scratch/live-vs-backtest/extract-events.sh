#!/bin/bash
set -euo pipefail
CID=le4sptof36h14ry6s5zet5v0-213817333649
REPORT=/app/reports/labs/midas-carry-v1/2026-07-24T23-12-16-890Z-preset-btc-micro-aggressive-v1
docker exec "$CID" node --input-type=module -e "
import fs from 'fs';
const ids = new Set([
  '0x146a2fba5a334afede478638aa55eba82f6d313fc87f6fa590ad60590bdce533',
  '0x28477124fba87d3db9f8a59b1d398eba765dd234b6de5d5c7288f645df7979c5',
]);
const results = JSON.parse(fs.readFileSync('$REPORT/results.json','utf8'));
const top = JSON.parse(fs.readFileSync('$REPORT/top-results.json','utf8'));
console.log('resultsType', Array.isArray(results) ? 'array:'+results.length : typeof results, Object.keys(results).slice(0,20));
console.log('topType', Array.isArray(top) ? 'array:'+top.length : typeof top, Object.keys(top).slice(0,20));

function findHits(obj, path='') {
  const hits = [];
  if (!obj || typeof obj !== 'object') return hits;
  if (Array.isArray(obj)) {
    for (let i=0;i<obj.length;i++) hits.push(...findHits(obj[i], path+'['+i+']'));
    return hits;
  }
  const cid = obj.condition_id || obj.conditionId || obj.eventId;
  if (cid && ids.has(String(cid).toLowerCase()) || (cid && [...ids].some(id => String(cid).toLowerCase() === id.toLowerCase()))) {
    hits.push({path, obj});
  }
  // also match by event_start
  const es = obj.event_start || obj.eventStart;
  if (es && (String(es).includes('22:15:00') || String(es).includes('22:45:00'))) {
    hits.push({path: path+':byStart', obj});
  }
  for (const k of Object.keys(obj)) {
    if (k === 'ticks' || k === 'series') continue;
    hits.push(...findHits(obj[k], path+'.'+k));
  }
  return hits;
}

const hits = [...findHits(results), ...findHits(top)];
console.log('hits', hits.length);
for (const h of hits.slice(0, 10)) {
  console.log('---', h.path);
  console.log(JSON.stringify(h.obj, null, 2).slice(0, 2500));
}
"
