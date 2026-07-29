#!/usr/bin/env node
/**
 * Dump recent open orders + trades for pair-path analysis (no secrets logged).
 */
import 'dotenv/config';
import { createSigner } from './src/clob/wallet.js';
import { buildClobClient } from './src/clob/buildClient.js';

const after = Math.floor(Date.now() / 1000) - 3 * 3600; // last 3h

async function main() {
  const wallet = createSigner(process.env.POLYMARKET_PRIVATE_KEY);
  const client = buildClobClient({ wallet, throwOnError: true });
  console.log('signer', wallet.address);

  let open = [];
  try {
    open = await client.getOpenOrders();
  } catch (e) {
    console.log('getOpenOrders error', e.message);
  }
  console.log('openOrders', Array.isArray(open) ? open.length : open);

  let trades = [];
  try {
    trades = await client.getTrades({ after: String(after) });
  } catch (e) {
    console.log('getTrades error', e.message);
  }
  const list = Array.isArray(trades) ? trades : trades?.trades || [];
  console.log('trades_n', list.length);

  // Compact view
  const rows = list.slice(0, 40).map((t) => ({
    id: t.id || t.trade_id,
    side: t.side,
    asset: String(t.asset_id || '').slice(0, 10) + '…',
    price: t.price,
    size: t.size,
    status: t.status,
    match_time: t.match_time || t.created_at || t.timestamp,
    taker_order_id: t.taker_order_id,
    maker_orders: (t.maker_orders || []).map((m) => ({
      order_id: m.order_id,
      matched: m.matched_amount,
      price: m.price,
    })),
  }));
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
