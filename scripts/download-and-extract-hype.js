import { downloadBinanceDailyZip } from './download-binance-1s.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const EXTRACTED_DIR = path.resolve('data/binance-1s/extracted');

const sampleHypeDates = [
  '2026-05-24', '2026-05-25', '2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29', '2026-05-30', '2026-05-31',
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-06', '2026-06-07', '2026-06-08',
  '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'
];

async function main() {
  console.log('=== BAIXANDO E EXTRAINDO DADOS BINANCE 1S PARA HYPEUSDT ===\n');

  for (const dateStr of sampleHypeDates) {
    const zipPath = await downloadBinanceDailyZip('HYPEUSDT', dateStr);
    if (!zipPath) continue;

    const csvName = `HYPEUSDT-1s-${dateStr}.csv`;
    const csvPath = path.join(EXTRACTED_DIR, csvName);

    if (!existsSync(csvPath)) {
      try {
        execSync(`tar -xf "${zipPath}" -C "${EXTRACTED_DIR}"`);
        console.log(`[extract] ${csvName} extraído.`);
      } catch (err) {
        console.error(`[extract] Erro ao extrair ${csvName}:`, err.message);
      }
    }
  }

  console.log('\n[binance-hype] Processamento de dados 1s da Binance para HYPE concluído com sucesso!');
}

main().catch(console.error);
