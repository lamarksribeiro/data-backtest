import { downloadBinanceDailyZip } from './download-binance-1s.js';
import { existsSync, createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';

const CACHE_DIR = path.resolve('data/binance-1s');
const EXTRACTED_DIR = path.resolve('data/binance-1s/extracted');

if (!existsSync(EXTRACTED_DIR)) {
  mkdirSync(EXTRACTED_DIR, { recursive: true });
}

const sampleEthDates = [
  '2026-05-24', '2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08',
  '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'
];

async function main() {
  console.log('=== BAIXANDO E PROCESSANDO DADOS BINANCE 1S PARA ETHUSDT ===\n');

  for (const dateStr of sampleEthDates) {
    const zipPath = await downloadBinanceDailyZip('ETHUSDT', dateStr);
    if (!zipPath) continue;
  }

  console.log('\n[binance-eth] Download de dados de 1s para ETH concluído!');
}

main().catch(console.error);
