import { runHyperionScalper } from '../src/strategies/hyperionScalper.js';
import { runBacktest } from '../src/backtest/engine.js';
import { openStateDatabase } from '../src/state/sqlite.js';
import { loadConfig } from '../src/config.js';

console.log('================================================================');
console.log('  LABORATÓRIO DE SCALPE INTRA-EVENTO MULTI-ENTRADA (HYPERION V5)');
console.log('================================================================\n');

console.log('Mecânica do Scalpe:');
console.log('• Compra Taker ao detectar impulso de preço no spot (Binance/Oracle).');
console.log('• Aguarda a reprecificação do contrato (retencao de 5s a 25s).');
console.log('• Realiza Lucro Taker agredindo o Bid (+10¢ a +20% no Bid).');
console.log('• Permite de 1 a 4 scalpes dentro da MESMA vela de 5 minutos!\n');

const config = loadConfig();
const db = openStateDatabase(config.stateDbPath, { readOnly: true });

console.log('Pronto para simulação no Lakehouse e execução ao vivo no data-robot.');
