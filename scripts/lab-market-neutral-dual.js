import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { closeDatabasePool, getTicksForBacktestBatches } from '../src/database.js';

// ============================================================================
// FEE & SLIPPAGE MODELS (Polymarket Official Fee Spec)
// ============================================================================
export function calculatePolymarketFee(price, qty, isTaker = true, scenario = 'base', feeOverride = null) {
  if (!isTaker) return 0; // Maker fee is 0% on Polymarket
  
  if (feeOverride != null) {
    return price * qty * feeOverride;
  }

  if (scenario === 'optimistic') {
    return price * qty * 0.005; // 0.5% fixed taker fee
  } else if (scenario === 'pessimistic') {
    // Dynamic fee curve: 3% * p * (1 - p) + 0.5% base fee
    const dynamicRate = 0.03 * (price * (1 - price)) + 0.005;
    return price * qty * Math.max(dynamicRate, 0.01);
  } else {
    // Base scenario: standard 1.5% fixed taker fee or dynamic ~1.5%
    const dynamicRate = 0.02 * (price * (1 - price)) + 0.005;
    return price * qty * Math.max(dynamicRate, 0.008);
  }
}

// Fill simulator against level 2 order book
export function simulateBookFill(book, targetQty, maxSlippage = 0.02, side = 'buy') {
  if (!book || !Array.isArray(book) || book.length === 0) {
    return { filledQty: 0, avgPrice: 0, totalCost: 0, slippage: 0 };
  }

  let remaining = targetQty;
  let totalCost = 0;
  let filledQty = 0;
  const bestPrice = Number(book[0].price || book[0][0]);
  
  if (isNaN(bestPrice) || bestPrice <= 0) {
    return { filledQty: 0, avgPrice: 0, totalCost: 0, slippage: 0 };
  }

  const limitPrice = side === 'buy' ? bestPrice * (1 + maxSlippage) : bestPrice * (1 - maxSlippage);

  for (const level of book) {
    const p = Number(level.price || level[0]);
    const size = Number(level.size || level.amount || level[1] || 100);

    if (isNaN(p) || size <= 0) continue;
    if (side === 'buy' && p > limitPrice) break;
    if (side === 'sell' && p < limitPrice) break;

    const fillNow = Math.min(remaining, size);
    totalCost += fillNow * p;
    filledQty += fillNow;
    remaining -= fillNow;

    if (remaining <= 0) break;
  }

  if (filledQty <= 0) {
    return { filledQty: 0, avgPrice: 0, totalCost: 0, slippage: 0 };
  }

  const avgPrice = totalCost / filledQty;
  const slippage = side === 'buy' ? (avgPrice - bestPrice) : (bestPrice - avgPrice);

  return { filledQty, avgPrice, totalCost, slippage };
}

// ============================================================================
// MARKET-NEUTRAL DUAL-SIDE STRATEGY ENGINE
// ============================================================================
export class MarketNeutralLabEngine {
  constructor(options = {}) {
    this.variant = options.variant || 'atfr-v1'; // 'atfr-v1', 'dlsl-v1', 'dsr-v1', 'dual-random', 'single-up', 'single-down'
    this.feeScenario = options.feeScenario || 'base';
    this.maxOrderValue = options.maxOrderValue || 10; // $10 per leg
    this.maxSlippage = options.maxSlippage || 0.02;
    this.feeOverride = options.feeOverride != null ? options.feeOverride : null;

    // Operational statistics
    this.eventsProcessed = 0;
    this.trades = [];
    this.equityCurve = [0];
    this.currentEquity = 0;
    this.peakEquity = 0;
    this.maxDrawdown = 0;

    // Strategy counters
    this.totalUpEntries = 0;
    this.totalDownEntries = 0;
    this.freeRollCount = 0;
    this.profitLockCount = 0;
    this.tieCount = 0; // PnL close to 0 (-$0.05 to +$0.05)
    this.nearTieCount = 0; // PnL (-$0.20 to +$0.20)
  }

  processEvent(eventTicks) {
    if (!eventTicks || eventTicks.length < 5) return;
    this.eventsProcessed++;

    const firstTick = eventTicks[0];
    const lastTick = eventTicks[eventTicks.length - 1];
    const ptb = firstTick.price_to_beat || firstTick.btc_price;
    const finalBtc = lastTick.btc_price;

    if (!ptb || !finalBtc) return;

    // Outcome: UP wins if finalBtc >= ptb, else DOWN wins
    const upWins = finalBtc >= ptb;

    // Run specific strategy variant
    if (this.variant === 'atfr-v1') {
      this.runATFR(eventTicks, upWins);
    } else if (this.variant === 'dlsl-v1') {
      this.runDLSL(eventTicks, upWins);
    } else if (this.variant === 'dlsl-v2') {
      this.runDLSLv2(eventTicks, upWins);
    } else if (this.variant === 'dsr-v1') {
      this.runDSR(eventTicks, upWins);
    } else if (this.variant === 'dual-random') {
      this.runDualRandom(eventTicks, upWins);
    } else if (this.variant === 'single-up') {
      this.runSingleUp(eventTicks, upWins);
    } else if (this.variant === 'single-down') {
      this.runSingleDown(eventTicks, upWins);
    }
  }

  // --------------------------------------------------------------------------
  // Variant 1: Asymmetric Temporal Free-Roll (ATFR-V1) [Primary Market Neutral]
  // --------------------------------------------------------------------------
  runATFR(eventTicks, upWins) {
    // Condition: Entry in the first 90s (secondsRemaining >= 210s) when combined ask <= 0.985
    let entryTick = null;
    let upFill = null;
    let downFill = null;

    for (const tick of eventTicks) {
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining > 270 || secRemaining < 180) continue;

      const upAsk = tick.up_best_ask;
      const downAsk = tick.down_best_ask;

      if (!upAsk || !downAsk || upAsk <= 0 || downAsk <= 0) continue;
      const sumAsk = upAsk + downAsk;

      // Enter straddle when combined price is reasonable (<= 0.985)
      if (sumAsk <= 0.985) {
        // Try filling UP leg
        const upRes = simulateBookFill(tick.up_book_asks, this.maxOrderValue / upAsk, this.maxSlippage, 'buy');
        const downRes = simulateBookFill(tick.down_book_asks, this.maxOrderValue / downAsk, this.maxSlippage, 'buy');

        if (upRes.filledQty > 0 && downRes.filledQty > 0) {
          entryTick = tick;
          upFill = upRes;
          downFill = downRes;
          break;
        }
      }
    }

    if (!entryTick || !upFill || !downFill) return;

    this.totalUpEntries++;
    this.totalDownEntries++;

    const feeUpEntry = calculatePolymarketFee(upFill.avgPrice, upFill.filledQty, true, this.feeScenario, this.feeOverride);
    const feeDownEntry = calculatePolymarketFee(downFill.avgPrice, downFill.filledQty, true, this.feeScenario, this.feeOverride);
    const totalEntryCost = upFill.totalCost + feeUpEntry + downFill.totalCost + feeDownEntry;
    const totalQty = Math.min(upFill.filledQty, downFill.filledQty);

    // Active Management: Look for Free-Roll exit on appreciated leg before expiration
    let exitOccurred = false;
    let exitLeg = null; // 'UP' or 'DOWN'
    let exitProceeds = 0;
    let exitFee = 0;
    let freeRollAchieved = false;
    let profitLocked = false;

    const entryIdx = eventTicks.indexOf(entryTick);
    for (let i = entryIdx + 1; i < eventTicks.length; i++) {
      const tick = eventTicks[i];
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining < 5) break; // Hold to settlement near end

      const upBid = tick.up_best_bid;
      const downBid = tick.down_best_bid;

      // Check if UP leg bid appreciates enough to cover entire dual entry cost
      if (upBid && upBid > 0) {
        const potentialUpExit = simulateBookFill(tick.up_book_bids, totalQty, this.maxSlippage, 'sell');
        const feeEst = calculatePolymarketFee(potentialUpExit.avgPrice, potentialUpExit.filledQty, true, this.feeScenario, this.feeOverride);
        const netProceeds = potentialUpExit.totalCost - feeEst;

        if (netProceeds >= totalEntryCost * 0.98) {
          // Free-Roll triggered! Sell UP leg to cover 100% of outlay
          exitOccurred = true;
          exitLeg = 'UP';
          exitProceeds = netProceeds;
          exitFee = feeEst;
          freeRollAchieved = true;
          this.freeRollCount++;
          if (netProceeds > totalEntryCost * 1.02) {
            profitLocked = true;
            this.profitLockCount++;
          }
          break;
        }
      }

      // Check if DOWN leg bid appreciates enough to cover entire dual entry cost
      if (downBid && downBid > 0) {
        const potentialDownExit = simulateBookFill(tick.down_book_bids, totalQty, this.maxSlippage, 'sell');
        const feeEst = calculatePolymarketFee(potentialDownExit.avgPrice, potentialDownExit.filledQty, true, this.feeScenario, this.feeOverride);
        const netProceeds = potentialDownExit.totalCost - feeEst;

        if (netProceeds >= totalEntryCost * 0.98) {
          // Free-Roll triggered! Sell DOWN leg to cover 100% of outlay
          exitOccurred = true;
          exitLeg = 'DOWN';
          exitProceeds = netProceeds;
          exitFee = feeEst;
          freeRollAchieved = true;
          this.freeRollCount++;
          if (netProceeds > totalEntryCost * 1.02) {
            profitLocked = true;
            this.profitLockCount++;
          }
          break;
        }
      }
    }

    // Settlement Outcome Calculation
    let pnlIfUpWins = 0;
    let pnlIfDownWins = 0;
    let grossPnL = 0;
    let netPnL = 0;

    if (exitOccurred) {
      if (exitLeg === 'UP') {
        // UP leg was sold early. Residual DOWN leg held to settlement.
        pnlIfUpWins = exitProceeds - totalEntryCost; // DOWN pays $0 if UP wins
        pnlIfDownWins = exitProceeds + (totalQty * 1.00) - totalEntryCost; // DOWN pays $1.00 if DOWN wins!
      } else {
        // DOWN leg was sold early. Residual UP leg held to settlement.
        pnlIfUpWins = exitProceeds + (totalQty * 1.00) - totalEntryCost; // UP pays $1.00 if UP wins!
        pnlIfDownWins = exitProceeds - totalEntryCost; // UP pays $0 if DOWN wins
      }
    } else {
      // No exit occurred -> hold both legs to settlement
      // One side pays 1.00 * totalQty, the other pays 0
      pnlIfUpWins = (totalQty * 1.00) - totalEntryCost;
      pnlIfDownWins = (totalQty * 1.00) - totalEntryCost;
    }

    netPnL = upWins ? pnlIfUpWins : pnlIfDownWins;
    grossPnL = netPnL + feeUpEntry + feeDownEntry + exitFee;

    const worstCase = Math.min(pnlIfUpWins, pnlIfDownWins);
    const bestCase = Math.max(pnlIfUpWins, pnlIfDownWins);

    this.recordTrade({
      eventStart: entryTick.event_start,
      variant: 'atfr-v1',
      totalCost: totalEntryCost,
      feesPaid: feeUpEntry + feeDownEntry + exitFee,
      slippage: upFill.slippage + downFill.slippage,
      grossPnL,
      netPnL,
      pnlIfUpWins,
      pnlIfDownWins,
      worstCase,
      bestCase,
      upWins,
      freeRollAchieved,
      profitLocked,
      exitOccurred,
    });
  }

  // --------------------------------------------------------------------------
  // Variant 2: Dual-Leg Sequential Lock & Spread Recycling (DLSL-V1)
  // --------------------------------------------------------------------------
  runDLSL(eventTicks, upWins) {
    let legA = null; // { side: 'UP'|'DOWN', fill, cost, tick }
    let legB = null; // { side: 'UP'|'DOWN', fill, cost, tick }

    // Phase 1: Look for first leg underpricing (ask <= 0.44) between 240s and 120s
    for (const tick of eventTicks) {
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining > 240 || secRemaining < 120) continue;

      const upAsk = tick.up_best_ask;
      const downAsk = tick.down_best_ask;

      if (upAsk && upAsk > 0 && upAsk <= 0.44) {
        const fill = simulateBookFill(tick.up_book_asks, this.maxOrderValue / upAsk, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legA = { side: 'UP', fill, cost: fill.totalCost, tick };
          this.totalUpEntries++;
          break;
        }
      } else if (downAsk && downAsk > 0 && downAsk <= 0.44) {
        const fill = simulateBookFill(tick.down_book_asks, this.maxOrderValue / downAsk, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legA = { side: 'DOWN', fill, cost: fill.totalCost, tick };
          this.totalDownEntries++;
          break;
        }
      }
    }

    if (!legA) return;

    // Phase 2: Look for opposite leg B entry to lock combined cost <= 0.94
    const legAIdx = eventTicks.indexOf(legA.tick);
    const targetOppositeSide = legA.side === 'UP' ? 'DOWN' : 'UP';
    const maxAllowedAskB = 0.94 - legA.fill.avgPrice;

    for (let i = legAIdx + 1; i < eventTicks.length; i++) {
      const tick = eventTicks[i];
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining < 15) break;

      const askB = targetOppositeSide === 'DOWN' ? tick.down_best_ask : tick.up_best_ask;
      const bookB = targetOppositeSide === 'DOWN' ? tick.down_book_asks : tick.up_book_asks;

      if (askB && askB > 0 && askB <= maxAllowedAskB) {
        const fill = simulateBookFill(bookB, legA.fill.filledQty, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legB = { side: targetOppositeSide, fill, cost: fill.totalCost, tick };
          if (targetOppositeSide === 'DOWN') this.totalDownEntries++;
          else this.totalUpEntries++;
          this.profitLockCount++;
          break;
        }
      }
    }

    // Fees calculation
    const feeA = calculatePolymarketFee(legA.fill.avgPrice, legA.fill.filledQty, true, this.feeScenario, this.feeOverride);
    const feeB = legB ? calculatePolymarketFee(legB.fill.avgPrice, legB.fill.filledQty, true, this.feeScenario, this.feeOverride) : 0;
    const totalCost = legA.cost + feeA + (legB ? legB.cost + feeB : 0);
    const qty = legB ? Math.min(legA.fill.filledQty, legB.fill.filledQty) : legA.fill.filledQty;

    let pnlIfUpWins = 0;
    let pnlIfDownWins = 0;

    if (legB) {
      // Both legs locked! Payoff is guaranteed 1.00 * qty - totalCost
      pnlIfUpWins = (qty * 1.00) - totalCost;
      pnlIfDownWins = (qty * 1.00) - totalCost;
    } else {
      // Only leg A locked. Directional exposure on leg A.
      if (legA.side === 'UP') {
        pnlIfUpWins = (qty * 1.00) - totalCost;
        pnlIfDownWins = -totalCost;
      } else {
        pnlIfUpWins = -totalCost;
        pnlIfDownWins = (qty * 1.00) - totalCost;
      }
    }

    const netPnL = upWins ? pnlIfUpWins : pnlIfDownWins;
    const grossPnL = netPnL + feeA + feeB;
    const worstCase = Math.min(pnlIfUpWins, pnlIfDownWins);
    const bestCase = Math.max(pnlIfUpWins, pnlIfDownWins);

    this.recordTrade({
      eventStart: legA.tick.event_start,
      variant: 'dlsl-v1',
      totalCost,
      feesPaid: feeA + feeB,
      slippage: legA.fill.slippage + (legB ? legB.fill.slippage : 0),
      grossPnL,
      netPnL,
      pnlIfUpWins,
      pnlIfDownWins,
      worstCase,
      bestCase,
      upWins,
      freeRollAchieved: false,
      profitLocked: Boolean(legB),
      exitOccurred: false,
    });
  }

  // --------------------------------------------------------------------------
  // Variant 2.2: Dual-Leg Sequential Lock V2 (DLSL-V2 with Stop on Unhedged Leg)
  // --------------------------------------------------------------------------
  runDLSLv2(eventTicks, upWins) {
    let legA = null;
    let legB = null;

    // Phase 1: Enter leg A underpriced (ask <= 0.44) between 240s and 120s
    for (const tick of eventTicks) {
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining > 240 || secRemaining < 120) continue;

      const upAsk = tick.up_best_ask;
      const downAsk = tick.down_best_ask;

      if (upAsk && upAsk > 0 && upAsk <= 0.44) {
        const fill = simulateBookFill(tick.up_book_asks, this.maxOrderValue / upAsk, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legA = { side: 'UP', fill, cost: fill.totalCost, tick };
          this.totalUpEntries++;
          break;
        }
      } else if (downAsk && downAsk > 0 && downAsk <= 0.44) {
        const fill = simulateBookFill(tick.down_book_asks, this.maxOrderValue / downAsk, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legA = { side: 'DOWN', fill, cost: fill.totalCost, tick };
          this.totalDownEntries++;
          break;
        }
      }
    }

    if (!legA) return;

    // Phase 2: Look for leg B lock or exit leg A if unhedged after 45 seconds
    const legAIdx = eventTicks.indexOf(legA.tick);
    const legATime = new Date(legA.tick.ts).getTime();
    const targetOppositeSide = legA.side === 'UP' ? 'DOWN' : 'UP';
    const maxAllowedAskB = 0.94 - legA.fill.avgPrice;

    let earlyExitA = false;
    let exitAPrice = 0;
    let exitAFee = 0;

    for (let i = legAIdx + 1; i < eventTicks.length; i++) {
      const tick = eventTicks[i];
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining < 15) break;

      const currentTime = new Date(tick.ts).getTime();
      const elapsedSec = (currentTime - legATime) / 1000;

      const askB = targetOppositeSide === 'DOWN' ? tick.down_best_ask : tick.up_best_ask;
      const bookB = targetOppositeSide === 'DOWN' ? tick.down_book_asks : tick.up_book_asks;

      // Check if leg B can be locked
      if (askB && askB > 0 && askB <= maxAllowedAskB) {
        const fill = simulateBookFill(bookB, legA.fill.filledQty, this.maxSlippage, 'buy');
        if (fill.filledQty > 0) {
          legB = { side: targetOppositeSide, fill, cost: fill.totalCost, tick };
          if (targetOppositeSide === 'DOWN') this.totalDownEntries++;
          else this.totalUpEntries++;
          this.profitLockCount++;
          break;
        }
      }

      // If leg B not locked after 45s, exit unhedged leg A to stop directional risk!
      if (!legB && elapsedSec >= 45) {
        const bookBidA = legA.side === 'UP' ? tick.up_book_bids : tick.down_book_bids;
        const exitRes = simulateBookFill(bookBidA, legA.fill.filledQty, this.maxSlippage, 'sell');
        if (exitRes.filledQty > 0) {
          earlyExitA = true;
          exitAPrice = exitRes.avgPrice;
          exitAFee = calculatePolymarketFee(exitRes.avgPrice, exitRes.filledQty, true, this.feeScenario, this.feeOverride);
          break;
        }
      }
    }

    // Fees calculation
    const feeA = calculatePolymarketFee(legA.fill.avgPrice, legA.fill.filledQty, true, this.feeScenario, this.feeOverride);
    const feeB = legB ? calculatePolymarketFee(legB.fill.avgPrice, legB.fill.filledQty, true, this.feeScenario, this.feeOverride) : 0;

    let totalCost = legA.cost + feeA + (legB ? legB.cost + feeB : 0);
    const qty = legB ? Math.min(legA.fill.filledQty, legB.fill.filledQty) : legA.fill.filledQty;

    let pnlIfUpWins = 0;
    let pnlIfDownWins = 0;

    if (legB) {
      // Dual legs locked!
      pnlIfUpWins = (qty * 1.00) - totalCost;
      pnlIfDownWins = (qty * 1.00) - totalCost;
    } else if (earlyExitA) {
      // Exit early on leg A
      const netProceedsA = (qty * exitAPrice) - exitAFee;
      const lossA = netProceedsA - (legA.cost + feeA);
      pnlIfUpWins = lossA;
      pnlIfDownWins = lossA;
    } else {
      // Unhedged hold to settlement
      if (legA.side === 'UP') {
        pnlIfUpWins = (qty * 1.00) - totalCost;
        pnlIfDownWins = -totalCost;
      } else {
        pnlIfUpWins = -totalCost;
        pnlIfDownWins = (qty * 1.00) - totalCost;
      }
    }

    const netPnL = upWins ? pnlIfUpWins : pnlIfDownWins;
    const grossPnL = netPnL + feeA + feeB + exitAFee;

    this.recordTrade({
      eventStart: legA.tick.event_start,
      variant: 'dlsl-v2',
      totalCost,
      feesPaid: feeA + feeB + exitAFee,
      slippage: legA.fill.slippage + (legB ? legB.fill.slippage : 0),
      grossPnL,
      netPnL,
      pnlIfUpWins,
      pnlIfDownWins,
      worstCase: Math.min(pnlIfUpWins, pnlIfDownWins),
      bestCase: Math.max(pnlIfUpWins, pnlIfDownWins),
      upWins,
      freeRollAchieved: false,
      profitLocked: Boolean(legB),
      exitOccurred: earlyExitA,
    });
  }

  // --------------------------------------------------------------------------
  // Variant 3: Dynamic Straddle Rebalancing & Payout Floor (DSR-V1)
  // --------------------------------------------------------------------------
  runDSR(eventTicks, upWins) {
    // Enter dual position at t-180s if ask_sum <= 0.99
    let entryTick = null;
    let upFill = null;
    let downFill = null;

    for (const tick of eventTicks) {
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining > 210 || secRemaining < 150) continue;

      const upAsk = tick.up_best_ask;
      const downAsk = tick.down_best_ask;
      if (!upAsk || !downAsk || upAsk <= 0 || downAsk <= 0) continue;

      if (upAsk + downAsk <= 0.99) {
        upFill = simulateBookFill(tick.up_book_asks, this.maxOrderValue / upAsk, this.maxSlippage, 'buy');
        downFill = simulateBookFill(tick.down_book_asks, this.maxOrderValue / downAsk, this.maxSlippage, 'buy');
        if (upFill.filledQty > 0 && downFill.filledQty > 0) {
          entryTick = tick;
          break;
        }
      }
    }

    if (!entryTick || !upFill || !downFill) return;

    this.totalUpEntries++;
    this.totalDownEntries++;

    const feeUp = calculatePolymarketFee(upFill.avgPrice, upFill.filledQty, true, this.feeScenario, this.feeOverride);
    const feeDown = calculatePolymarketFee(downFill.avgPrice, downFill.filledQty, true, this.feeScenario, this.feeOverride);
    const totalCost = upFill.totalCost + feeUp + downFill.totalCost + feeDown;
    const qty = Math.min(upFill.filledQty, downFill.filledQty);

    let lockedExit = false;
    let exitNetProceeds = 0;
    let exitFeeTotal = 0;

    const entryIdx = eventTicks.indexOf(entryTick);
    for (let i = entryIdx + 1; i < eventTicks.length; i++) {
      const tick = eventTicks[i];
      const secRemaining = this.getSecRemaining(tick);
      if (secRemaining < 10) break;

      const upBid = tick.up_best_bid;
      const downBid = tick.down_best_bid;
      if (upBid && downBid && upBid > 0 && downBid > 0) {
        // If sum of bids allows closing BOTH sides above cost + 2% profit
        if (upBid + downBid >= 1.02) {
          const upExit = simulateBookFill(tick.up_book_bids, qty, this.maxSlippage, 'sell');
          const downExit = simulateBookFill(tick.down_book_bids, qty, this.maxSlippage, 'sell');

          if (upExit.filledQty > 0 && downExit.filledQty > 0) {
            const fUp = calculatePolymarketFee(upExit.avgPrice, upExit.filledQty, true, this.feeScenario, this.feeOverride);
            const fDown = calculatePolymarketFee(downExit.avgPrice, downExit.filledQty, true, this.feeScenario, this.feeOverride);
            exitNetProceeds = upExit.totalCost - fUp + downExit.totalCost - fDown;
            exitFeeTotal = fUp + fDown;
            lockedExit = true;
            this.profitLockCount++;
            break;
          }
        }
      }
    }

    let pnlIfUpWins = 0;
    let pnlIfDownWins = 0;

    if (lockedExit) {
      pnlIfUpWins = exitNetProceeds - totalCost;
      pnlIfDownWins = exitNetProceeds - totalCost;
    } else {
      pnlIfUpWins = (qty * 1.00) - totalCost;
      pnlIfDownWins = (qty * 1.00) - totalCost;
    }

    const netPnL = upWins ? pnlIfUpWins : pnlIfDownWins;
    const grossPnL = netPnL + feeUp + feeDown + exitFeeTotal;

    this.recordTrade({
      eventStart: entryTick.event_start,
      variant: 'dsr-v1',
      totalCost,
      feesPaid: feeUp + feeDown + exitFeeTotal,
      slippage: upFill.slippage + downFill.slippage,
      grossPnL,
      netPnL,
      pnlIfUpWins,
      pnlIfDownWins,
      worstCase: Math.min(pnlIfUpWins, pnlIfDownWins),
      bestCase: Math.max(pnlIfUpWins, pnlIfDownWins),
      upWins,
      freeRollAchieved: false,
      profitLocked: lockedExit,
      exitOccurred: lockedExit,
    });
  }

  // --------------------------------------------------------------------------
  // Baselines: Dual Random / Single UP / Single DOWN
  // --------------------------------------------------------------------------
  runDualRandom(eventTicks, upWins) {
    const tick = eventTicks[Math.floor(eventTicks.length * 0.3)];
    if (!tick || !tick.up_best_ask || !tick.down_best_ask) return;

    const upFill = simulateBookFill(tick.up_book_asks, this.maxOrderValue / tick.up_best_ask, this.maxSlippage, 'buy');
    const downFill = simulateBookFill(tick.down_book_asks, this.maxOrderValue / tick.down_best_ask, this.maxSlippage, 'buy');

    if (upFill.filledQty <= 0 || downFill.filledQty <= 0) return;
    this.totalUpEntries++;
    this.totalDownEntries++;

    const feeUp = calculatePolymarketFee(upFill.avgPrice, upFill.filledQty, true, this.feeScenario, this.feeOverride);
    const feeDown = calculatePolymarketFee(downFill.avgPrice, downFill.filledQty, true, this.feeScenario, this.feeOverride);
    const totalCost = upFill.totalCost + feeUp + downFill.totalCost + feeDown;
    const qty = Math.min(upFill.filledQty, downFill.filledQty);

    const pnlIfUpWins = (qty * 1.00) - totalCost;
    const pnlIfDownWins = (qty * 1.00) - totalCost;
    const netPnL = upWins ? pnlIfUpWins : pnlIfDownWins;

    this.recordTrade({
      eventStart: tick.event_start,
      variant: 'dual-random',
      totalCost,
      feesPaid: feeUp + feeDown,
      slippage: upFill.slippage + downFill.slippage,
      grossPnL: netPnL + feeUp + feeDown,
      netPnL,
      pnlIfUpWins,
      pnlIfDownWins,
      worstCase: Math.min(pnlIfUpWins, pnlIfDownWins),
      bestCase: Math.max(pnlIfUpWins, pnlIfDownWins),
      upWins,
      freeRollAchieved: false,
      profitLocked: false,
      exitOccurred: false,
    });
  }

  runSingleUp(eventTicks, upWins) {
    const tick = eventTicks[Math.floor(eventTicks.length * 0.3)];
    if (!tick || !tick.up_best_ask) return;

    const fill = simulateBookFill(tick.up_book_asks, this.maxOrderValue / tick.up_best_ask, this.maxSlippage, 'buy');
    if (fill.filledQty <= 0) return;
    this.totalUpEntries++;

    const fee = calculatePolymarketFee(fill.avgPrice, fill.filledQty, true, this.feeScenario, this.feeOverride);
    const totalCost = fill.totalCost + fee;
    const netPnL = upWins ? (fill.filledQty * 1.00) - totalCost : -totalCost;

    this.recordTrade({
      eventStart: tick.event_start,
      variant: 'single-up',
      totalCost,
      feesPaid: fee,
      slippage: fill.slippage,
      grossPnL: netPnL + fee,
      netPnL,
      pnlIfUpWins: (fill.filledQty * 1.00) - totalCost,
      pnlIfDownWins: -totalCost,
      worstCase: -totalCost,
      bestCase: (fill.filledQty * 1.00) - totalCost,
      upWins,
      freeRollAchieved: false,
      profitLocked: false,
      exitOccurred: false,
    });
  }

  runSingleDown(eventTicks, upWins) {
    const tick = eventTicks[Math.floor(eventTicks.length * 0.3)];
    if (!tick || !tick.down_best_ask) return;

    const fill = simulateBookFill(tick.down_book_asks, this.maxOrderValue / tick.down_best_ask, this.maxSlippage, 'buy');
    if (fill.filledQty <= 0) return;
    this.totalDownEntries++;

    const fee = calculatePolymarketFee(fill.avgPrice, fill.filledQty, true, this.feeScenario, this.feeOverride);
    const totalCost = fill.totalCost + fee;
    const netPnL = !upWins ? (fill.filledQty * 1.00) - totalCost : -totalCost;

    this.recordTrade({
      eventStart: tick.event_start,
      variant: 'single-down',
      totalCost,
      feesPaid: fee,
      slippage: fill.slippage,
      grossPnL: netPnL + fee,
      netPnL,
      pnlIfUpWins: -totalCost,
      pnlIfDownWins: (fill.filledQty * 1.00) - totalCost,
      worstCase: -totalCost,
      bestCase: (fill.filledQty * 1.00) - totalCost,
      upWins,
      freeRollAchieved: false,
      profitLocked: false,
      exitOccurred: false,
    });
  }

  recordTrade(trade) {
    this.trades.push(trade);
    this.currentEquity += trade.netPnL;
    this.equityCurve.push(this.currentEquity);

    if (this.currentEquity > this.peakEquity) {
      this.peakEquity = this.currentEquity;
    }
    const dd = this.peakEquity - this.currentEquity;
    if (dd > this.maxDrawdown) {
      this.maxDrawdown = dd;
    }

    if (Math.abs(trade.netPnL) <= 0.05) {
      this.tieCount++;
    }
    if (Math.abs(trade.netPnL) <= 0.20) {
      this.nearTieCount++;
    }
  }

  getSecRemaining(tick) {
    if (!tick.event_start || !tick.ts) return 150;
    const startMs = new Date(tick.event_start).getTime();
    const endMs = startMs + 300000; // 5 minutes
    const tickMs = new Date(tick.ts).getTime();
    return Math.max(0, Math.round((endMs - tickMs) / 1000));
  }

  getMetrics() {
    const totalTrades = this.trades.length;
    if (totalTrades === 0) {
      return {
        variant: this.variant,
        trades: 0,
        winRate: '0.0%',
        pnlGross: 0,
        pnlNet: 0,
        pf: 0,
        maxDD: 0,
        expectancy: 0,
        expectancyPerDollar: 0,
        totalFees: 0,
        feeDragPct: '0.0%',
        worstCaseAvg: 0,
        bestCaseAvg: 0,
        tieFreq: '0.0%',
        nearTieFreq: '0.0%',
        freeRollFreq: '0.0%',
        profitLockFreq: '0.0%',
      };
    }

    const wins = this.trades.filter(t => t.netPnL > 0);
    const losses = this.trades.filter(t => t.netPnL < 0);
    const totalWinPnL = wins.reduce((a, b) => a + b.netPnL, 0);
    const totalLossPnL = Math.abs(losses.reduce((a, b) => a + b.netPnL, 0));

    const pnlNet = this.trades.reduce((a, b) => a + b.netPnL, 0);
    const pnlGross = this.trades.reduce((a, b) => a + b.grossPnL, 0);
    const totalFees = this.trades.reduce((a, b) => a + b.feesPaid, 0);
    const totalCostSum = this.trades.reduce((a, b) => a + b.totalCost, 0);

    const pf = totalLossPnL > 0 ? (totalWinPnL / totalLossPnL) : (totalWinPnL > 0 ? 99.9 : 0);
    const expectancy = pnlNet / totalTrades;
    const expectancyPerDollar = totalCostSum > 0 ? (pnlNet / totalCostSum) : 0;
    const feeDragPct = pnlGross !== 0 ? (totalFees / Math.abs(pnlGross)) * 100 : 0;

    const worstCaseAvg = this.trades.reduce((a, b) => a + b.worstCase, 0) / totalTrades;
    const bestCaseAvg = this.trades.reduce((a, b) => a + b.bestCase, 0) / totalTrades;

    return {
      variant: this.variant,
      trades: totalTrades,
      winRate: ((wins.length / totalTrades) * 100).toFixed(1) + '%',
      pnlGross: Number(pnlGross.toFixed(2)),
      pnlNet: Number(pnlNet.toFixed(2)),
      pf: Number(pf.toFixed(2)),
      maxDD: Number(this.maxDrawdown.toFixed(2)),
      expectancy: Number(expectancy.toFixed(2)),
      expectancyPerDollar: Number((expectancyPerDollar * 100).toFixed(2)) + '%',
      totalFees: Number(totalFees.toFixed(2)),
      feeDragPct: feeDragPct.toFixed(1) + '%',
      worstCaseAvg: Number(worstCaseAvg.toFixed(2)),
      bestCaseAvg: Number(bestCaseAvg.toFixed(2)),
      tieFreq: ((this.tieCount / totalTrades) * 100).toFixed(1) + '%',
      nearTieFreq: ((this.nearTieCount / totalTrades) * 100).toFixed(1) + '%',
      freeRollFreq: ((this.freeRollCount / totalTrades) * 100).toFixed(1) + '%',
      profitLockFreq: ((this.profitLockCount / totalTrades) * 100).toFixed(1) + '%',
    };
  }
}

// ============================================================================
// MAIN CLI BACKTEST RUNNER
// ============================================================================
export async function runLab(argFrom, argTo, argMode, argBatchSize) {
  const args = process.argv.slice(2);
  const from = argFrom || args[0] || '2026-05-04T15:00:00.000Z';
  const rawTo = argTo !== undefined ? argTo : args[1];
  const to = (rawTo && rawTo !== 'null') ? rawTo : null;
  const mode = argMode || args[2] || 'full'; // 'full', 'train', 'val', 'holdout', '72h', '24h'
  const batchSize = Number(argBatchSize || args[3]) || 10000;

  console.log(`\n================================================================`);
  console.log(` LAB: MARKET-NEUTRAL DUAL-SIDE STRATEGY EXPERIMENT`);
  console.log(` From: ${from} | To: ${to || 'Max Local'} | Mode: ${mode}`);
  console.log(`================================================================\n`);

  // Initialize strategy variants
  const variants = ['atfr-v1', 'dlsl-v1', 'dlsl-v2', 'dsr-v1', 'dual-random', 'single-up', 'single-down'];
  const engines = new Map(variants.map(v => [v, new MarketNeutralLabEngine({ variant: v, feeScenario: 'base' })]));

  let currentEventStart = null;
  let currentEventTicks = [];
  let totalTicksRead = 0;

  let batchCount = 0;
  for await (const batch of getTicksForBacktestBatches(from, to, batchSize)) {
    batchCount++;
    totalTicksRead += batch.length;
    for (const tick of batch) {
      if (tick.event_start !== currentEventStart) {
        if (currentEventTicks.length > 0) {
          // Process event across all engine variants
          for (const engine of engines.values()) {
            engine.processEvent(currentEventTicks);
          }
        }
        currentEventStart = tick.event_start;
        currentEventTicks = [tick];
      } else {
        currentEventTicks.push(tick);
      }
    }

    if (batchCount % 10 === 0) {
      console.log(`[Progress] Batches: ${batchCount} | Ticks: ${totalTicksRead} | Events: ${engines.get('atfr-v1').eventsProcessed} | Last TS: ${batch[batch.length - 1].ts}`);
    }
  }

  if (currentEventTicks.length > 0) {
    for (const engine of engines.values()) {
      engine.processEvent(currentEventTicks);
    }
  }

  console.log(`Processed ${totalTicksRead} ticks across ${engines.get('atfr-v1').eventsProcessed} events.\n`);

  console.log(`=== RESUMO COMPARATIVO DE RENTABILIDADE E RISCO ===`);
  const summaryTable = [];
  for (const variant of variants) {
    summaryTable.push(engines.get(variant).getMetrics());
  }
  console.table(summaryTable);

  const reportDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'market-neutral-dual-v1');
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportDir, `lab-full-${stamp}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    from,
    to,
    mode,
    ticksRead: totalTicksRead,
    eventsProcessed: engines.get('atfr-v1').eventsProcessed,
    variants: summaryTable,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);

  await closeDatabasePool();
  return report;
}

// Run main if called directly (Windows-safe: argv may be relative)
const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref && import.meta.url === entryHref) {
  runLab().catch((err) => {
    console.error(err);
    closeDatabasePool().finally(() => process.exit(1));
  });
}
