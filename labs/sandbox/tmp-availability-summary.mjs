import fs from 'node:fs';
const path = process.argv[2];
const t = fs.readFileSync(path, 'utf8');
const i = t.indexOf('{');
const j = JSON.parse(t.slice(i));
const days = j.days || j.partitions || (Array.isArray(j) ? j : null);
if (Array.isArray(days)) {
  const ok = days.filter((d) => ['valid', 'accepted', 'ok', 'ready'].includes(d.status));
  console.log('total dias:', days.length, 'usable:', ok.length);
  const dts = ok.map((d) => d.dt || d.date).sort();
  console.log('primeiro:', dts[0], 'ultimo:', dts[dts.length - 1]);
  const missing = days.filter((d) => !['valid', 'accepted', 'ok', 'ready'].includes(d.status));
  console.log('nao-usable:', missing.slice(0, 20).map((d) => `${d.dt || d.date}:${d.status}`).join(', '));
} else {
  console.log(Object.keys(j));
  console.log(JSON.stringify(j).slice(0, 3000));
}
