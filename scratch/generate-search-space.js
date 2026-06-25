import { writeFileSync } from 'node:fs';
import path from 'node:path';

const searchSpace = {
  name: "qem-hybrid-sweeps",
  description: "Varredura de parâmetros entrópicos, quânticos e termodinâmicos para otimização do preset híbrido.",
  variants: []
};

// Definição das faixas de varredura
const caps = [0.88, 0.94, 0.98];
const obiFactors = [0.70, 0.85, 1.10];
const stopScales = [0.08, 0.12, 0.18];

let count = 1;
for (const cap of caps) {
  for (const obi of obiFactors) {
    for (const stop of stopScales) {
      searchSpace.variants.push({
        id: `qem_cap${cap.toFixed(2)}_obi${obi.toFixed(2)}_stop${stop.toFixed(2)}`,
        params: {
          entropyCompressionCap: cap,
          quantumObiFactor: obi,
          temperatureStopScale: stop,
          minEdge: 0.08,
          minDirectionalProb: 0.62,
          minDistanceAbs: 45,
          cooldownSec: 8,
          maxEntriesPerEvent: 5,
          maxEntryValue: 8,
          maxEventExposure: 32,
          modelWeight: 0.75,
          kellyFraction: 0.18
        }
      });
      count++;
    }
  }
}

const targetPath = path.resolve('labs/strategies/gamma/gamma-ladder-v1/search-spaces/qem-hybrid-sweeps.json');
writeFileSync(targetPath, JSON.stringify(searchSpace, null, 2), 'utf8');
console.log(`Espaço de busca com ${searchSpace.variants.length} variantes gerado em: ${targetPath}`);
