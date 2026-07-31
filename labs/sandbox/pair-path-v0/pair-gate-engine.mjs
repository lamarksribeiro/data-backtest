/**
 * Pair-Gate V1 — pure event engine (no I/O).
 * Contrato: MACHINE-PAIR-GATE-V1.md
 *
 * idle → open (C2∧C4) → hedged|aborted → done
 * MULT=1 · máx 1 perna nua · abort por timeout/SL · sem escada/clips
 */

export const DEFAULT_PARAMS = {
  openShares: 5,
  openAskLo: 0.52,
  openAskHi: 0.62,
  openTriggerCents: 55,
  openCapCents: 2,
  maxOpenAttempts: 3,
  tauOpenMin: 40,
  tauOpenMax: 240,

  hedgeAskMax: 0.42,
  hedgeCapCents: 2,

  /** Folga além das fees explícitas no gate I1 (centavos). */
  epsCents: 2,
  /** Slip/latência embutida no proj (centavos). */
  bufferCents: 1,
  /** Pós-fill alvo (telemetria); o gate de entrada usa ε+fees. */
  avgSumMax: 0.96,

  T_hedge_sec: 8,
  SL_usd: 0.4,
  abortPreferSell: true,
  holdOnlyIfDust: true,
  dustShares: 5,
  dustNotional: 1,

  eqAskMax: 0.08,
  feeRate: 0.07,
  maxEventNotional: 5.75,
  legChoice: 'chase', // chase | fade

  esperaLimiteC: 70,
  esperaGatilhoC: 55,
  antiGlitchSumLo: 0.85,
  antiGlitchSumHi: 1.15,

  /** Decisão no tick t; execução usa book do tick t+latencyTicks. */
  latencyTicks: 1,
};

export function mergeParams(raw = {}) {
  return { ...DEFAULT_PARAMS, ...raw };
}

function clamp01(x) {
  return Math.min(0.99, Math.max(0.01, Number(x)));
}

export function feePerShare(price, rate = DEFAULT_PARAMS.feeRate) {
  const p = clamp01(price);
  return rate * p * (1 - p);
}

/**
 * I1 — custo projetado de um par completo (por share).
 * @returns {{ proj: number, ok: boolean, fee1: number, fee2: number }}
 */
export function projectPairCost(p1, p2, params = {}) {
  const p = mergeParams(params);
  const fee1 = feePerShare(p1, p.feeRate);
  const fee2 = feePerShare(p2, p.feeRate);
  const buffer = p.bufferCents / 100;
  const eps = p.epsCents / 100;
  const proj = p1 + p2 + fee1 + fee2 + buffer;
  return { proj, ok: proj <= 1 - eps, fee1, fee2, eps, buffer };
}

function opposite(side) {
  return side === 'UP' ? 'DOWN' : 'UP';
}

export function createPairGateEngine(paramsRaw = {}, meta = {}) {
  const p = mergeParams(paramsRaw);
  const state = {
    meta,
    mode: 'idle', // idle | open | hedged | aborted | done | blocked
    sideOpen: null,
    inv: {
      UP: { shares: 0, cost: 0, fees: 0 },
      DOWN: { shares: 0, cost: 0, fees: 0 },
    },
    openAttempts: 0,
    openedAtTs: null,
    openedAtTau: null,
    projAtOpen: null,
    esperaAtiva: false,
    esperaAvaliada: false,
    esperaLado: null,
    fills: [],
    blocks: [],
    events: [],
    pending: null, // { kind, side, limit, decidedAtTick, shares, meta }
    tickIndex: 0,
    lastAsks: { UP: null, DOWN: null },
    lastTs: null,
    abortReason: null,
    realizedPnl: 0, // abort sells / realized cash
  };

  function invested() {
    return state.inv.UP.cost + state.inv.DOWN.cost;
  }

  function avg(side) {
    const x = state.inv[side];
    return x.shares > 0 ? x.cost / x.shares : null;
  }

  function avgSum() {
    const a = avg('UP');
    const b = avg('DOWN');
    if (a == null || b == null) return null;
    return a + b;
  }

  function residual() {
    const d = state.inv.UP.shares - state.inv.DOWN.shares;
    if (Math.abs(d) < 1e-9) return { side: null, shares: 0 };
    return d > 0
      ? { side: 'UP', shares: d }
      : { side: 'DOWN', shares: -d };
  }

  function pushBlock(code, detail = {}) {
    state.blocks.push({ code, ...detail, tick: state.tickIndex });
    state.events.push({ kind: 'BLOCK', code, ...detail, tick: state.tickIndex });
  }

  function pushSkip(code, detail = {}) {
    state.events.push({ kind: code, ...detail, tick: state.tickIndex });
  }

  function recordFill(kind, side, price, shares, liquidity = 'taker') {
    const fees = feePerShare(price, p.feeRate) * shares;
    state.inv[side].shares += shares;
    state.inv[side].cost += price * shares;
    state.inv[side].fees += fees;
    const fill = {
      kind,
      side,
      price,
      shares,
      fees,
      liquidity,
      tick: state.tickIndex,
      ts: state.lastTs,
    };
    state.fills.push(fill);
    state.events.push({ kind: `${kind.toUpperCase()}_FILL`, ...fill });
    return fill;
  }

  function markToBid(bids) {
    const r = residual();
    if (!r.side || r.shares <= 0) return 0;
    const bid = bids?.[r.side];
    if (bid == null) return null;
    const cost = state.inv[r.side].cost;
    // valor mark do residual (aproximação: custo total do lado − valor bid das shares)
    // PnL mark do evento aberto ≈ (UP+DOWN) mark − invested
    const markUp = (bids?.UP ?? 0) * state.inv.UP.shares;
    const markDn = (bids?.DOWN ?? 0) * state.inv.DOWN.shares;
    return markUp + markDn - invested() - state.inv.UP.fees - state.inv.DOWN.fees;
  }

  function pickOpenSide(upAsk, downAsk) {
    if (p.legChoice === 'fade') {
      return upAsk <= downAsk ? 'UP' : 'DOWN';
    }
    // chase: favorito = maior ask
    return upAsk >= downAsk ? 'UP' : 'DOWN';
  }

  function c1Ok(upAsk, downAsk, tau) {
    if (upAsk == null || downAsk == null) {
      pushSkip('SKIP_C1', { reason: 'no_odds' });
      return false;
    }
    const sum = upAsk + downAsk;
    if (sum < p.antiGlitchSumLo || sum > p.antiGlitchSumHi) {
      pushSkip('SKIP_C1', { reason: 'glitch', sum });
      return false;
    }
    if (tau < p.tauOpenMin || tau > p.tauOpenMax) {
      if (state.mode === 'idle') {
        pushSkip('SKIP_C1', { reason: 'tau', tau });
        return false;
      }
    }
    return true;
  }

  function applyEspera(upAsk, downAsk) {
    if (state.esperaAvaliada) {
      if (!state.esperaAtiva) return true;
      const vig =
        state.esperaLado === 'UP' ? upAsk * 100 : downAsk * 100;
      if (vig >= p.esperaGatilhoC) {
        state.esperaAtiva = false;
        state.events.push({
          kind: 'ESPERA_LIBERADA',
          lado: state.esperaLado,
          askC: vig,
          tick: state.tickIndex,
        });
        return true;
      }
      pushSkip('SKIP_C1', {
        reason: 'espera',
        lado: state.esperaLado,
        askC: vig,
      });
      return false;
    }
    state.esperaAvaliada = true;
    const upC = upAsk * 100;
    const dnC = downAsk * 100;
    if (Math.max(upC, dnC) > p.esperaLimiteC) {
      state.esperaAtiva = true;
      state.esperaLado = upC >= dnC ? 'DOWN' : 'UP';
      pushSkip('SKIP_C1', {
        reason: 'espera_abertura',
        lado: state.esperaLado,
        caroC: Math.max(upC, dnC),
      });
      return false;
    }
    return true;
  }

  function tryDecideOpen(upAsk, downAsk, tau) {
    if (state.mode !== 'idle') return;
    if (state.pending) return;
    if (!applyEspera(upAsk, downAsk)) return;
    if (tau < p.tauOpenMin || tau > p.tauOpenMax) {
      pushSkip('SKIP_C1', { reason: 'tau', tau });
      return;
    }

    const side = pickOpenSide(upAsk, downAsk);
    const ask = side === 'UP' ? upAsk : downAsk;
    const askOpp = side === 'UP' ? downAsk : upAsk;
    const trigger = p.openTriggerCents / 100;

    if (ask < p.openAskLo || ask > p.openAskHi) {
      pushSkip('SKIP_C2', { reason: 'banda', side, ask });
      return;
    }
    if (ask < trigger - 1e-12) {
      pushSkip('SKIP_C2', { reason: 'trigger', side, ask, trigger });
      return;
    }

    const cap = p.openCapCents / 100;
    const limit = Math.min(ask + cap, trigger + cap);
    // proj usa o pior preço aceito na 1ª + teto do hedge
    const p1 = Math.min(ask, limit);
    const p2 = Math.min(askOpp, p.hedgeAskMax);
    const gate = projectPairCost(p1, p.hedgeAskMax, p);
    if (!gate.ok) {
      pushSkip('SKIP_C2', {
        reason: 'proj',
        side,
        p1,
        p2: p.hedgeAskMax,
        proj: gate.proj,
        eps: gate.eps,
      });
      return;
    }
    if (invested() + p1 * p.openShares > p.maxEventNotional + 1e-9) {
      pushBlock('TETO_NOTIONAL', { invested: invested(), p1 });
      return;
    }

    state.pending = {
      kind: 'open',
      side,
      limit,
      shares: p.openShares,
      decidedAtTick: state.tickIndex,
      meta: { askAtDecision: ask, askOpp, proj: gate.proj, tau },
    };
    // Conta a tentativa ao armar pending; OPEN_MISS devolve o crédito (não gasta).
    state.openAttempts += 1;
    state.events.push({
      kind: 'OPEN_ATTEMPT',
      side,
      limit,
      shares: p.openShares,
      proj: gate.proj,
      tick: state.tickIndex,
    });
  }

  function tryDecideHedge(upAsk, downAsk) {
    if (state.mode !== 'open') return;
    if (state.pending) return;
    const side = opposite(state.sideOpen);
    const ask = side === 'UP' ? upAsk : downAsk;
    if (ask == null) return;
    if (ask > p.hedgeAskMax + 1e-12) {
      pushSkip('SKIP_C2', { reason: 'hedge_ask', side, ask, max: p.hedgeAskMax });
      return;
    }

    const avgOpen = avg(state.sideOpen);
    const limit = ask + p.hedgeCapCents / 100;
    const p2 = Math.min(ask, limit);
    const gate = projectPairCost(avgOpen, p2, p);
    if (!gate.ok) {
      pushSkip('SKIP_C2', {
        reason: 'hedge_proj',
        avgOpen,
        p2,
        proj: gate.proj,
      });
      return;
    }

    const need = residual().shares;
    if (need <= 0) return;
    if (invested() + p2 * need > p.maxEventNotional + 1e-9) {
      pushBlock('TETO_NOTIONAL', { phase: 'hedge' });
      return;
    }

    state.pending = {
      kind: 'hedge',
      side,
      limit,
      shares: need,
      decidedAtTick: state.tickIndex,
      meta: { askAtDecision: ask, proj: gate.proj },
    };
    state.events.push({
      kind: 'HEDGE_ATTEMPT',
      side,
      limit,
      shares: need,
      proj: gate.proj,
      tick: state.tickIndex,
    });
  }

  function executePending(upAsk, downAsk) {
    const pend = state.pending;
    if (!pend) return;
    if (state.tickIndex < pend.decidedAtTick + p.latencyTicks) return;

    const ask = pend.side === 'UP' ? upAsk : downAsk;
    state.pending = null;

    if (ask == null || ask > pend.limit + 1e-12) {
      if (pend.kind === 'open') {
        // OPEN_MISS por cap NÃO gasta attempt (contrato §4 C3 / bug Clip)
        state.openAttempts = Math.max(0, state.openAttempts - 1);
        state.events.push({
          kind: 'OPEN_MISS',
          side: pend.side,
          ask,
          limit: pend.limit,
          tick: state.tickIndex,
        });
      } else {
        state.events.push({
          kind: 'HEDGE_MISS',
          side: pend.side,
          ask,
          limit: pend.limit,
          tick: state.tickIndex,
        });
      }
      return;
    }

    if (pend.kind === 'open') {
      recordFill('open', pend.side, ask, pend.shares);
      state.mode = 'open';
      state.sideOpen = pend.side;
      state.openedAtTs = state.lastTs;
      state.openedAtTau = pend.meta.tau;
      state.projAtOpen = pend.meta.proj;
      return;
    }

    if (pend.kind === 'hedge') {
      recordFill('hedge', pend.side, ask, pend.shares);
      state.mode = 'hedged';
      // complete-set
      const r = residual();
      if (r.shares <= 1e-9) {
        state.mode = 'done';
        state.events.push({ kind: 'DONE_PAIRED', avgSum: avgSum(), tick: state.tickIndex });
      }
      return;
    }

    if (pend.kind === 'abort_sell') {
      // legado — executeAbortIfReady cuida disso
      return;
    }
  }

  function maybeAbort(upAsk, downAsk, bids) {
    if (state.mode !== 'open') return;
    if (state.pending) return;

    const ts = state.lastTs;
    const timedOut =
      state.openedAtTs != null &&
      ts != null &&
      ts - state.openedAtTs >= p.T_hedge_sec;

    const mark = markToBid(
      bids || {
        UP: upAsk != null ? Math.max(0.01, upAsk - 0.01) : null,
        DOWN: downAsk != null ? Math.max(0.01, downAsk - 0.01) : null,
      },
    );
    const stopHit = mark != null && mark <= -p.SL_usd;

    if (!timedOut && !stopHit) return;

    state.abortReason = stopHit ? 'sl' : 'timeout';
    const r = residual();
    if (!r.side || r.shares <= 0) {
      state.mode = 'aborted';
      return;
    }

    const bid =
      (bids && bids[r.side]) ??
      (r.side === 'UP'
        ? Math.max(0.01, upAsk - 0.01)
        : Math.max(0.01, downAsk - 0.01));

    const notional = bid * r.shares;
    const isDust =
      r.shares < p.dustShares || notional < p.dustNotional;

    if (p.holdOnlyIfDust && isDust) {
      state.mode = 'aborted';
      state.events.push({
        kind: 'ABORT',
        reason: `${state.abortReason}_hold_dust`,
        side: r.side,
        shares: r.shares,
        tick: state.tickIndex,
      });
      return;
    }

    if (!p.abortPreferSell) {
      state.mode = 'aborted';
      state.events.push({
        kind: 'ABORT',
        reason: `${state.abortReason}_hold`,
        side: r.side,
        shares: r.shares,
        tick: state.tickIndex,
      });
      return;
    }

    // abort sell com latency (mesma fila pending)
    state.pending = {
      kind: 'abort_sell',
      side: r.side,
      limit: 1, // venda a mercado: qualquer bid aceita no modelo simples
      shares: r.shares,
      decidedAtTick: state.tickIndex,
      meta: { bid },
    };
    // execução imediata no mesmo modelo: usa bid como "ask" do pending
    // reprocessado no execute com bid forçado abaixo
    state.pending._execPrice = bid;
  }

  function executeAbortIfReady() {
    const pend = state.pending;
    if (!pend || pend.kind !== 'abort_sell') return;
    if (state.tickIndex < pend.decidedAtTick + p.latencyTicks) return;
    const bid = pend._execPrice ?? pend.meta?.bid;
    state.pending = null;
    if (bid == null) {
      state.mode = 'aborted';
      return;
    }
    const side = pend.side;
    const sh = Math.min(pend.shares, state.inv[side].shares);
    if (sh <= 0) {
      state.mode = 'aborted';
      return;
    }
    const frac = sh / state.inv[side].shares;
    const proceeds = bid * sh;
    const costRemoved = state.inv[side].cost * frac;
    const feesRemoved = state.inv[side].fees * frac;
    state.inv[side].shares -= sh;
    state.inv[side].cost -= costRemoved;
    state.inv[side].fees -= feesRemoved;
    // PnL realizado da venda: proceeds − custo − fees da parcela
    const realized = proceeds - costRemoved - feesRemoved;
    state.realizedPnl += realized;
    state.fills.push({
      kind: 'abort_sell',
      side,
      price: bid,
      shares: sh,
      fees: feesRemoved,
      proceeds,
      costRemoved,
      realized,
      liquidity: 'taker',
      tick: state.tickIndex,
      ts: state.lastTs,
    });
    state.mode = 'aborted';
    state.events.push({
      kind: 'ABORT',
      reason: state.abortReason,
      side,
      shares: sh,
      price: bid,
      realized,
      tick: state.tickIndex,
    });
  }

  /**
   * @param {{ tau: number, upAsk: number|null, downAsk: number|null, ts?: number,
   *           upBid?: number|null, downBid?: number|null }} tick
   */
  function onTick(tick) {
    if (state.mode === 'done' || state.mode === 'aborted' || state.mode === 'blocked') {
      return;
    }

    const {
      tau,
      upAsk,
      downAsk,
      ts = state.tickIndex,
      upBid = null,
      downBid = null,
    } = tick;

    state.tickIndex += 1;
    state.lastAsks = { UP: upAsk, DOWN: downAsk };
    state.lastTs = ts;

    if (!c1Ok(upAsk, downAsk, tau) && state.mode === 'idle') {
      return;
    }

    // 1) executar pending com latência
    executeAbortIfReady();
    if (state.pending && state.pending.kind !== 'abort_sell') {
      executePending(upAsk, downAsk);
    }

    if (state.mode === 'done' || state.mode === 'aborted') return;

    // 2) abort check
    maybeAbort(upAsk, downAsk, {
      UP: upBid,
      DOWN: downBid,
    });
    executeAbortIfReady();
    if (state.mode === 'aborted') return;

    // 3) decisões novas
    if (state.mode === 'idle') {
      if (state.openAttempts >= p.maxOpenAttempts) {
        pushBlock('OPEN_ATTEMPTS_ESGOTADOS', { n: state.openAttempts });
        state.mode = 'blocked';
        return;
      }
      tryDecideOpen(upAsk, downAsk, tau);
    } else if (state.mode === 'open') {
      tryDecideHedge(upAsk, downAsk);
    }
  }

  /**
   * Settlement: se ainda residual, marca o lado nua a 0 ou 1 conforme winner.
   * @param {'UP'|'DOWN'|null} winner
   */
  function finish(winner = null) {
    // cancela pending sem fill
    if (state.pending) {
      state.events.push({
        kind: 'PENDING_CANCEL_EOF',
        pending: state.pending.kind,
        tick: state.tickIndex,
      });
      state.pending = null;
    }

    const r = residual();
    let settlementPnl = 0;
    const fees = state.inv.UP.fees + state.inv.DOWN.fees;
    const cost = invested();

    // paired shares redeem $1 each pair
    const paired = Math.min(state.inv.UP.shares, state.inv.DOWN.shares);
    settlementPnl += paired * 1;

    if (r.shares > 0 && r.side) {
      if (winner === r.side) settlementPnl += r.shares * 1;
      // loser residual → 0
      state.events.push({
        kind: 'RESIDUAL_SETTLEMENT',
        side: r.side,
        shares: r.shares,
        winner,
        tick: state.tickIndex,
      });
    }

    let abortProceeds = 0;
    let abortRealized = 0;
    for (const f of state.fills) {
      if (f.kind === 'abort_sell') {
        abortProceeds += f.proceeds || 0;
        abortRealized += f.realized || 0;
      }
    }

    // remaining inventory cost/fees + already-realized abort PnL
    const pnl = settlementPnl + state.realizedPnl - cost - fees;

    if (state.mode === 'open' || state.mode === 'idle') {
      state.mode = r.shares > 0 ? 'aborted' : state.mode === 'idle' ? 'done' : 'aborted';
    }
    if (state.mode === 'hedged') state.mode = 'done';

    const blockCounts = {};
    for (const b of state.blocks) {
      blockCounts[b.code] = (blockCounts[b.code] || 0) + 1;
    }
    const skipCounts = {};
    for (const e of state.events) {
      if (String(e.kind).startsWith('SKIP_')) {
        const k = `${e.kind}:${e.reason || ''}`;
        skipCounts[k] = (skipCounts[k] || 0) + 1;
      }
    }

    return {
      mode: state.mode,
      sideOpen: state.sideOpen,
      inv: structuredClone(state.inv),
      fills: state.fills.slice(),
      events: state.events.slice(),
      residual: r,
      avgSum: avgSum(),
      projAtOpen: state.projAtOpen,
      invested: cost,
      fees,
      abortProceeds,
      abortRealized,
      paired,
      pnl,
      blockCounts,
      skipCounts,
      openAttempts: state.openAttempts,
      params: { ...p },
      meta: state.meta,
    };
  }

  return {
    state,
    params: p,
    onTick,
    finish,
    projectPairCost: (p1, p2) => projectPairCost(p1, p2, p),
  };
}
