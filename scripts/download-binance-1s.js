import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { get } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../data/binance-1s');

if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

export function getBinanceKlinesZipUrl(symbol, dateStr) {
  // Binance Vision public historical archive URL
  return `https://data.binance.vision/data/spot/daily/klines/${symbol}/1s/${symbol}-1s-${dateStr}.zip`;
}

export function downloadBinanceDailyZip(symbol = 'BTCUSDT', dateStr = '2026-05-04') {
  const url = getBinanceKlinesZipUrl(symbol, dateStr);
  const targetFile = path.join(CACHE_DIR, `${symbol}-1s-${dateStr}.zip`);

  if (existsSync(targetFile)) {
    console.log(`[binance] ${dateStr} já existe em cache: ${targetFile}`);
    return Promise.resolve(targetFile);
  }

  console.log(`[binance] Baixando klines 1s da Binance para ${dateStr} de ${url}...`);
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[binance] ${dateStr} HTTP ${res.statusCode} (arquivo pode não existir na data.binance.vision ainda).`);
        resolve(null);
        return;
      }
      const fileStream = createWriteStream(targetFile);
      res.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`[binance] ${dateStr} concluído: ${targetFile}`);
        resolve(targetFile);
      });
    }).on('error', (err) => {
      console.error(`[binance] Erro no download de ${dateStr}:`, err.message);
      resolve(null);
    });
  });
}

// Se executado diretamente como CLI script
if (process.argv[1] && process.argv[1].endsWith('download-binance-1s.js')) {
  const dateStr = process.argv[2] || '2026-05-04';
  downloadBinanceDailyZip('BTCUSDT', dateStr);
}
