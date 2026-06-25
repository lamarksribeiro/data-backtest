import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function sync(version) {
  const suffix = version === 1 ? '' : `-v${version}`;
  const fileSuffix = version === 1 ? 'v1' : 'v2';
  const JS_SOURCE = path.resolve(`labs/legacy/strategy-runners/portable/gamma-ladder-runner${suffix}.js`);
  const JSON_TARGET = path.resolve(`data/strategy-libraries/gamma-ladder-engine.${fileSuffix}.json`);

  try {
    console.log(`\n--- Sincronizando V${version} ---`);
    console.log(`Lendo código fonte de: ${JS_SOURCE}`);
    const sourceCode = readFileSync(JS_SOURCE, 'utf8');

    console.log(`Lendo arquivo JSON de: ${JSON_TARGET}`);
    const jsonContent = JSON.parse(readFileSync(JSON_TARGET, 'utf8'));

    // Atualiza metadados básicos
    jsonContent.slug = `gamma-ladder-engine-v${version}`;
    jsonContent.name = `Gamma Ladder Engine V${version}`;
    jsonContent.source_code = sourceCode;

    console.log(`Escrevendo arquivo JSON atualizado...`);
    writeFileSync(JSON_TARGET, `${JSON.stringify(jsonContent, null, 2)}\n`, 'utf8');

    console.log(`Sincronização da V${version} concluída com sucesso!`);
  } catch (err) {
    console.error(`Erro na sincronização da V${version}:`, err.message);
    process.exit(1);
  }
}

// Sincroniza V1 e V2
sync(1);
sync(2);
