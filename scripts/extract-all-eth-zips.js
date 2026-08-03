import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const CACHE_DIR = path.resolve('data/binance-1s');
const EXTRACTED_DIR = path.resolve('data/binance-1s/extracted');

const zipFiles = readdirSync(CACHE_DIR).filter((f) => f.startsWith('ETHUSDT-1s-') && f.endsWith('.zip'));

console.log(`[extract] Encontrados ${zipFiles.length} arquivos ZIP de ETHUSDT em ${CACHE_DIR}`);

for (const zipFile of zipFiles) {
  const zipPath = path.join(CACHE_DIR, zipFile);
  const csvName = zipFile.replace('.zip', '.csv');
  const csvPath = path.join(EXTRACTED_DIR, csvName);

  if (existsSync(csvPath)) {
    console.log(`[extract] ${csvName} já extraído.`);
    continue;
  }

  console.log(`[extract] Extraindo ${zipFile}...`);
  try {
    execSync(`tar -xf "${zipPath}" -C "${EXTRACTED_DIR}"`);
  } catch (err) {
    console.error(`[extract] Erro ao extrair ${zipFile}:`, err.message);
  }
}

console.log('[extract] Extração dos CSVs da Binance ETH concluída com sucesso!');
