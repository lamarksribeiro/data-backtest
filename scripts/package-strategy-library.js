#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function required(flags, key) {
  const value = flags[key];
  if (!value || value === true) throw new Error(`--${key} is required`);
  return String(value);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const sourcePath = path.resolve(required(flags, 'source'));
  const slug = required(flags, 'slug');
  const name = required(flags, 'name');
  const description = String(flags.description || `${name} strategy library runner`);
  const version = Math.max(1, Number.parseInt(String(flags.version || 1), 10) || 1);
  const sourceCode = readFileSync(sourcePath, 'utf8');
  if (!/\bfunction\s+createBacktestRunner\s*\(/.test(sourceCode)) {
    throw new Error(`${sourcePath} does not define createBacktestRunner()`);
  }

  const outputPath = path.resolve(
    String(flags.out || path.join('data', 'strategy-libraries', `${slug}.v${version}.json`)),
  );
  const entry = {
    slug,
    name,
    description,
    version,
    source_code: sourceCode,
    validation: {
      ok: true,
      kind: 'runner',
    },
  };
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, sourcePath, outputPath, slug, version }, null, 2));
}

main();
