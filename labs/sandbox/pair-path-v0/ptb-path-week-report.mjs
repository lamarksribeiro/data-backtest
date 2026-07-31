/**
 * Fast daily PTB-Path report — one DuckDB pass per day, ~3s/day.
 *
 *   node labs/sandbox/pair-path-v0/ptb-path-week-report.mjs
 *   node labs/sandbox/pair-path-v0/ptb-path-week-report.mjs --from=2026-07-22 --to=2026-07-29 --openLeaveUsd=28 --clip=tight2
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../..');

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

const FROM = arg('from', '2026-07-22');
const TO = arg('to', '2026-07-29');
const OPEN_LEAVE = arg('openLeaveUsd', '28');
const CLIP = arg('clip', 'tight2');
const SHARES = arg('shares', '10');
const EMFLIP = arg('emergencyFlip', '0');
const ARM = arg('arm', 'hedge-asap');

function listDays(from, to) {
  const out = [];
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function parseArmLine(stdout, armPrefix) {
  const line = stdout
    .split('\n')
    .find((l) => l.includes(armPrefix) && l.includes(`leave${OPEN_LEAVE}`));
  if (!line) return null;
  const m = line.match(
    /(\d+\/\d+)\s+([\d.]+|-)\s+([-\d.]+|-)\s+([-\d.]+|-)\s+([\d.]+|Infinity|-)/,
  );
  if (!m) return { raw: line.trim() };
  return {
    opens: m[1],
    eqPct: m[2] === '-' ? null : Number(m[2]),
    realized: m[3] === '-' ? null : Number(m[3]),
    worst: m[4] === '-' ? null : Number(m[4]),
    pf: m[5] === '-' || m[5] === 'Infinity' ? m[5] : Number(m[5]),
  };
}

async function main() {
  const days = listDays(FROM, TO);
  const rows = [];
  let sumRealized = 0;
  let resolvedDays = 0;

  console.log(
    `PTB-Path daily · leave=${OPEN_LEAVE} clip=${CLIP} arm=${ARM} sh=${SHARES}`,
  );
  console.log('day       opens     eq%   realized  worst    PF');
  console.log('--------  --------  ----  --------  -------  ------');

  for (const day of days) {
    const args = [
      'labs/sandbox/pair-path-v0/ptb-protect-ab.mjs',
      `--from=${day}`,
      `--to=${day}`,
      `--shares=${SHARES}`,
      `--openLeaveUsd=${OPEN_LEAVE}`,
      `--clip=${CLIP}`,
    ];
    if (EMFLIP === '1') args.push('--emergencyFlip=1');

    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd: ROOT,
      maxBuffer: 8 * 1024 * 1024,
    });
    const r = parseArmLine(stdout, ARM);
    if (!r) {
      console.log(`${day}  — no data`);
      continue;
    }
    rows.push({ day, ...r });
    if (r.realized != null && Number.isFinite(r.realized)) {
      sumRealized += r.realized;
      resolvedDays += 1;
    }
    const opens = r.opens ?? r.raw ?? '—';
    console.log(
      `${day}  ${String(opens).padEnd(8)}  ${String(r.eqPct ?? '—').padStart(4)}  ${String(r.realized ?? '—').padStart(8)}  ${String(r.worst ?? '—').padStart(7)}  ${r.pf ?? '—'}`,
    );
  }

  console.log('--------');
  console.log(
    `TOTAL     ${rows.length} days · sum realized=${sumRealized.toFixed(2)} · avg/day=${(sumRealized / resolvedDays).toFixed(2)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
