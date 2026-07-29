import { createMarketState } from './src/feeds/marketState.js';
import { createClobFeed } from './src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from './src/markets/btc5m.js';

const s = createMarketState();
const f = createClobFeed(s);
const e = await findActiveBtc5mEvent();
console.log('event', e?.slug);
if (!e) process.exit(1);
f.subscribe(e.upTokenId, e.downTokenId);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 250));
  console.log(
    i,
    'ws=',
    s.wsClobConnected,
    'up=',
    s.up.bestAsk,
    'dn=',
    s.down.bestAsk,
    'ageMs=',
    s.clobLastAt ? Date.now() - s.clobLastAt : null,
  );
  if (s.up.bestAsk != null && s.down.bestAsk != null && i >= 4) break;
}
f.stop();
