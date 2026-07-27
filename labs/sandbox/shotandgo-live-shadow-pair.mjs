/**
 * Live shadow pareado (sem parquet) — lê book ao vivo e roda Lego v4 vs classic.
 *
 * Poll REST CLOB/Gamma (~2Hz). Não envia ordem. Ctrl+C encerra e imprime diff.
 *
 *   node labs/sandbox/shotandgo-live-shadow-pair.mjs
 *   node labs/sandbox/shotandgo-live-shadow-pair.mjs --seconds 120
 *   node labs/sandbox/shotandgo-live-shadow-pair.mjs --full-event
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

/** Freios espelhados do Phil / shotandgo-runner (peça Lego). */
const BRAKES = {
  stopAtivo: true,
  stopVirada: 4,
  stopLimiar: 1.0,
  pisoAtivo: true,
  pisoViradas: [4, 5],
  pisoMargem: 0.20,
  maxViradasAtivo: true,
  maxViradas: 6,
  equalizaIgnoraTeto: true,
  eqPreco: 0.05,
};

/** Gates herdados da RE Doggy (não estão no Phil live). */
const DOGGY_GATES = {
  refuseAvgSum: 1.02,       // bloquear compra se projected avgSum > isto E não melhora
  multOnlyUnderweight: true, // MULT/contagio só no lado com menos shares
  lateVacuumAsk: 0.15,       // scoop residual ≤15¢ se melhora avgSum
  lateVacuumAtivo: true,
  descMode: 'optimistic',    // fill DESC no nível (proxy maker live)
  makerFillEpsilon: 0.01,
  makerTimeoutSec: 45,
};

const CLASSIC = {
  id: 'classic',
  sub: [55, 60, 65, 70, 75, 80, 85, 90],
  desc: [45, 40, 35, 30, 25, 20, 15, 10],
  sharesSub: [20, 15, 10, 10, 5, 5, 1, 1],
  sharesDesc: [5, 5, 5, 5, 5, 5, 5, 5],
  mult: [2, 3, 4, 5, 6, 6],
  maxEventNotional: 500,
  ...BRAKES,
  refuseAvgSum: null,
  multOnlyUnderweight: false,
  lateVacuumAtivo: false,
  descMode: 'optimistic',
};
const V4 = {
  id: 'v4',
  sub: CLASSIC.sub,
  desc: CLASSIC.desc,
  sharesSub: [4, 4, 4, 5, 5, 6, 8, 11],
  sharesDesc: [3, 3, 3, 4, 4, 5, 7, 10],
  mult: [2, 3, 4, 5, 6, 6],
  maxEventNotional: 250,
  ...BRAKES,
  refuseAvgSum: null,
  multOnlyUnderweight: false,
  lateVacuumAtivo: false,
  descMode: 'optimistic',
};
const V4_GATES = {
  ...V4,
  id: 'v4-gates',
  ...DOGGY_GATES,
};
const V4_GATES_HONEST = {
  ...V4_GATES,
  id: 'v4-gates-honest',
  descMode: 'honest', // DESC só preenche se ask atravessar o nível (lab honest)
};

function argNum(flag, fb) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? Number(process.argv[i + 1]) : fb;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function buildLadder(cfg) {
  const mk = (tipo, prices, shares) => prices.map((p, i) => ({
    tipo, idx: i + 1, preco: p, shares: shares[i], armado: true,
  }));
  const levels = [...mk('SUB', cfg.sub, cfg.sharesSub), ...mk('DESC', cfg.desc, cfg.sharesDesc)];
  return { UP: levels.map((n) => ({ ...n })), DOWN: levels.map((n) => ({ ...n })) };
}

function shouldFillRestingBuy(prevAsk, currAsk, limitPrice, epsilon = 0.01) {
  if (prevAsk == null || currAsk == null || limitPrice == null) return false;
  const thr = limitPrice - epsilon;
  return prevAsk > thr + 1e-12 && currAsk <= thr + 1e-12;
}

function createEngine(cfg) {
  const ladder = buildLadder(cfg);
  const histSub = [];
  const ativo = { UP: 1, DOWN: 1, G: 1 };
  let shares = { UP: 0, DOWN: 0 };
  let cost = { UP: 0, DOWN: 0 };
  const fills = [];
  const blocks = [];
  const blockCountsInline = {};
  const resting = []; // DESC honest
  let viradas = 0;
  let equalized = false;
  let encerrado = false;
  let exitReason = null;
  let realizedPnl = null;
  let escadaArmada = false;
  let congeladaLogged = false;
  const ticks = [];
  let lastAsks = { UP: null, DOWN: null };

  function invested() {
    return cost.UP + cost.DOWN;
  }

  function avgOf(lado) {
    return shares[lado] > 0 ? cost[lado] / shares[lado] : 0;
  }

  function avgSumNow() {
    if (shares.UP <= 0 || shares.DOWN <= 0) return null;
    return avgOf('UP') + avgOf('DOWN');
  }

  function projectedAvgSum(lado, px, sh) {
    if (sh <= 0) return avgSumNow();
    const newSh = shares[lado] + sh;
    const newAvg = (cost[lado] + sh * px) / newSh;
    const other = lado === 'UP' ? 'DOWN' : 'UP';
    if (shares[other] <= 0) return null;
    return newAvg + avgOf(other);
  }

  function isUnderweight(lado) {
    const other = lado === 'UP' ? 'DOWN' : 'UP';
    return shares[lado] <= shares[other] + 1e-9;
  }

  function fator(idx, lado) {
    const n = histSub.filter((h) => h.idx === idx).length;
    let f = n === 0 ? 1 : cfg.mult[Math.min(n, cfg.mult.length) - 1];
    if (cfg.contagio !== 'off' && ativo.G >= (cfg.contagioMin ?? 5)) {
      f = Math.max(f, ativo.G);
    }
    if (cfg.multOnlyUnderweight && !isUnderweight(lado) && f > 1) {
      blockCountsInline.MULT_OVERWEIGHT = (blockCountsInline.MULT_OVERWEIGHT || 0) + 1;
      f = 1;
    }
    if (f > 1) {
      ativo[lado] = Math.max(ativo[lado], f);
      ativo.G = Math.max(ativo.G, f);
    }
    return f;
  }

  function buy(lado, tipo, idx, px, sh, f, { ignoraTeto = false, ignoraRefuse = false } = {}) {
    if (sh <= 0 || encerrado) return 0;
    const add = sh * px;
    if (!ignoraTeto && invested() + add > cfg.maxEventNotional) {
      blocks.push({ ts: new Date().toISOString(), reason: 'TETO_EXPOSICAO', lado, tipo, sh, px });
      return 0;
    }
    if (!ignoraRefuse && cfg.refuseAvgSum != null) {
      const proj = projectedAvgSum(lado, px, sh);
      const cur = avgSumNow();
      if (proj != null && proj > cfg.refuseAvgSum && (cur == null || proj >= cur - 1e-9)) {
        blockCountsInline.REFUSE_AVGSUM = (blockCountsInline.REFUSE_AVGSUM || 0) + 1;
        if ((blockCountsInline.REFUSE_AVGSUM || 0) <= 8) {
          blocks.push({
            ts: new Date().toISOString(),
            reason: 'REFUSE_AVGSUM',
            lado,
            tipo,
            sh,
            px,
            proj: Math.round(proj * 1000) / 1000,
            cur,
          });
        }
        return 0;
      }
    }
    shares[lado] += sh;
    cost[lado] += add;
    fills.push({
      ts: new Date().toISOString(),
      lado,
      tipo: idx ? `${tipo}-${idx}` : tipo,
      sh,
      px,
      f,
    });
    return sh;
  }

  function sellBoth(bidUp, bidDn, reason) {
    const bu = bidUp ?? 0;
    const bd = bidDn ?? 0;
    const proceeds = shares.UP * bu + shares.DOWN * bd;
    realizedPnl = proceeds - invested();
    fills.push({
      ts: new Date().toISOString(),
      lado: 'BOTH',
      tipo: reason.toUpperCase(),
      sh: shares.UP + shares.DOWN,
      px: null,
      f: 1,
      proceeds,
      pnl: realizedPnl,
    });
    shares = { UP: 0, DOWN: 0 };
    resting.length = 0;
    encerrado = true;
    exitReason = reason;
  }

  function rearmPair(lado, tipo, idx) {
    const comp = tipo === 'SUB' ? 'DESC' : 'SUB';
    for (const c of ladder[lado]) {
      if (c.tipo === comp && c.idx === idx) c.armado = true;
    }
  }

  function placeDescResting(lado, n, sh) {
    const key = `${lado}|DESC-${n.idx}`;
    if (resting.some((o) => o.key === key)) return;
    resting.push({
      key,
      lado,
      idx: n.idx,
      price: n.preco / 100,
      sh,
      placedAt: Date.now(),
      lastAsk: lastAsks[lado],
    });
    blockCountsInline.DESC_RESTING_PLACED = (blockCountsInline.DESC_RESTING_PLACED || 0) + 1;
    n.armado = false;
    rearmPair(lado, 'DESC', n.idx);
  }

  function checkResting(asks) {
    const now = Date.now();
    const timeoutMs = (cfg.makerTimeoutSec ?? 45) * 1000;
    const eps = cfg.makerFillEpsilon ?? 0.01;
    for (let i = resting.length - 1; i >= 0; i--) {
      const o = resting[i];
      if (now - o.placedAt >= timeoutMs) {
        blockCountsInline.DESC_TIMEOUT = (blockCountsInline.DESC_TIMEOUT || 0) + 1;
        resting.splice(i, 1);
        continue;
      }
      const currAsk = asks[o.lado];
      if (currAsk == null) continue;
      const crossed = shouldFillRestingBuy(o.lastAsk, currAsk, o.price, eps);
      o.lastAsk = currAsk;
      if (!crossed) continue;
      const filled = buy(o.lado, 'DESC', o.idx, o.price, o.sh, 1);
      if (filled > 0) {
        blockCountsInline.DESC_HONEST_FILL = (blockCountsInline.DESC_HONEST_FILL || 0) + 1;
      } else {
        blockCountsInline.DESC_HONEST_MISS = (blockCountsInline.DESC_HONEST_MISS || 0) + 1;
      }
      resting.splice(i, 1);
    }
  }

  function tryLateVacuum(asks) {
    if (!cfg.lateVacuumAtivo || encerrado) return;
    if (shares.UP <= 0 || shares.DOWN <= 0) return;
    const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
    if (Math.abs(shares.UP - shares.DOWN) < 1e-9) return;
    const ask = asks[menor];
    if (ask == null || ask > (cfg.lateVacuumAsk ?? 0.15) + 1e-9) return;
    const dif = Math.abs(shares.UP - shares.DOWN);
    const sh = Math.min(dif, 20);
    const before = avgSumNow();
    const proj = projectedAvgSum(menor, ask, sh);
    if (proj == null || before == null || proj >= before - 1e-9) return;
    buy(menor, 'VACUUM', 0, ask, sh, 1, { ignoraRefuse: true });
  }

  function onTick(askUp, askDn, meta = {}) {
    const bidUp = meta.bidUp ?? askUp;
    const bidDn = meta.bidDn ?? askDn;
    ticks.push({
      ts: new Date().toISOString(), askUp, askDn, bidUp, bidDn, tau: meta.tau,
    });
    if (encerrado) return;
    if (askUp == null || askDn == null) return;
    const soma = (askUp + askDn) * 100;
    if (soma <= 85 || soma >= 115) return;
    if (!escadaArmada) {
      if (askUp >= 0.10 && askUp <= 0.90) escadaArmada = true;
      else return;
    }

    const asks = { UP: askUp, DOWN: askDn };

    // DESC honest: processar resting antes de novos níveis
    if (cfg.descMode === 'honest') checkResting(asks);

    if (cfg.stopAtivo && viradas >= cfg.stopVirada && shares.UP + shares.DOWN > 0) {
      const saldo = shares.UP * (bidUp ?? 0) + shares.DOWN * (bidDn ?? 0) - invested();
      if (saldo >= cfg.stopLimiar) {
        sellBoth(bidUp, bidDn, 'stop');
        return;
      }
    }

    const congelado = cfg.maxViradasAtivo && viradas >= cfg.maxViradas;
    if (congelado && !congeladaLogged) {
      blocks.push({ ts: new Date().toISOString(), reason: 'CONGELADA', viradas });
      congeladaLogged = true;
      exitReason = exitReason ?? 'max_viradas';
    }

    if (!congelado) {
      for (const lado of ['UP', 'DOWN']) {
        const askC = asks[lado] * 100;
        for (const n of ladder[lado]) {
          if (!n.armado || encerrado) continue;
          const hitSub = n.tipo === 'SUB' && askC >= n.preco;
          const hitDesc = n.tipo === 'DESC' && askC <= n.preco;
          if (!hitSub && !hitDesc) continue;

          let sh = n.shares;
          let f = 1;
          if (hitSub) {
            f = fator(n.idx, lado);
            sh = Math.round(n.shares * f * 100) / 100;
            if (cfg.pisoAtivo && n.idx === 1 && (!cfg.multOnlyUnderweight || isUnderweight(lado))) {
              const prox = viradas + 1;
              if (cfg.pisoViradas.includes(prox)) {
                const oposto = lado === 'UP' ? shares.DOWN : shares.UP;
                const meu = lado === 'UP' ? shares.UP : shares.DOWN;
                const dif = oposto - meu;
                if (dif > 0) {
                  const piso = Math.round(dif * (1 + cfg.pisoMargem) * 100) / 100;
                  if (piso > sh) sh = piso;
                }
              }
            }
          }

          if (hitDesc && cfg.descMode === 'honest') {
            placeDescResting(lado, n, sh);
            continue;
          }

          const px = hitDesc ? n.preco / 100 : asks[lado];
          const filled = buy(lado, n.tipo, n.idx, px, sh, f);
          if (filled <= 0) continue;
          if (hitSub) {
            histSub.push({ lado, idx: n.idx });
            if (n.idx === 1) viradas += 1;
          }
          n.armado = false;
          rearmPair(lado, n.tipo, n.idx);
        }
      }
    }

    lastAsks = { ...asks };
    tryLateVacuum(asks);

    if (!equalized && Math.abs(shares.UP - shares.DOWN) > 1e-9) {
      const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
      if (asks[menor] <= cfg.eqPreco + 1e-9) {
        const dif = Math.abs(shares.UP - shares.DOWN);
        const got = buy(menor, 'EQUALIZA', 0, asks[menor], dif, 1, {
          ignoraTeto: cfg.equalizaIgnoraTeto,
          ignoraRefuse: true,
        });
        if (got > 0) {
          equalized = true;
          encerrado = true;
          exitReason = 'equalized';
          realizedPnl = Math.min(shares.UP, shares.DOWN) - invested();
          resting.length = 0;
        }
      }
    }

    if (congelado && !encerrado && shares.UP + shares.DOWN > 0) {
      exitReason = exitReason ?? 'max_viradas';
    }
  }

  function snapshot() {
    const avgUp = avgOf('UP');
    const avgDn = avgOf('DOWN');
    const inv = invested();
    const sh = Math.min(shares.UP, shares.DOWN);
    const pnlEq = equalized ? sh - inv : null;
    const blockCounts = { ...blockCountsInline };
    for (const b of blocks) {
      if (b.reason === 'REFUSE_AVGSUM') continue;
      blockCounts[b.reason] = (blockCounts[b.reason] || 0) + 1;
    }
    return {
      cfg: cfg.id,
      maxEventNotional: cfg.maxEventNotional,
      gates: {
        refuseAvgSum: cfg.refuseAvgSum,
        multOnlyUnderweight: !!cfg.multOnlyUnderweight,
        lateVacuumAtivo: !!cfg.lateVacuumAtivo,
        descMode: cfg.descMode ?? 'optimistic',
      },
      ticks: ticks.length,
      fills: fills.length,
      restingOpen: resting.length,
      shares: { ...shares },
      invested: inv,
      avgUp,
      avgDn,
      sum: avgUp + avgDn,
      equalized,
      encerrado,
      exitReason,
      viradas,
      pnlEq,
      realizedPnl,
      blockCounts,
      lastFills: fills.slice(-8),
    };
  }

  return { onTick, snapshot, fills: () => fills, ticks: () => ticks, blocks: () => blocks };
}

async function resolveMarket(slugHint = null) {
  const now = Math.floor(Date.now() / 1000);
  const slot = Math.floor(now / 300) * 300;
  const candidates = slugHint
    ? [slugHint]
    : [
      `btc-updown-5m-${slot}`,
      `btc-updown-5m-${slot + 300}`,
      `btc-updown-5m-${slot - 300}`,
    ];
  for (const slug of candidates) {
    const r = await fetch(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`);
    if (!r.ok) continue;
    const data = await r.json();
    if (!Array.isArray(data) || !data[0]?.markets?.[0]) continue;
    const m = data[0].markets[0];
    let tokenIds = m.clobTokenIds;
    if (typeof tokenIds === 'string') {
      try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
    }
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;
    const end = m.endDate || data[0].endDate;
    const endMs = end ? Date.parse(end) : null;
    const startMs = endMs != null ? endMs - 300_000 : Number(slug.split('-').pop()) * 1000;
    return {
      slug,
      tokenUp: tokenIds[0],
      tokenDown: tokenIds[1],
      startMs,
      endMs: endMs ?? startMs + 300_000,
      title: data[0].title || slug,
    };
  }
  return null;
}

/** Espera o próximo evento com tau restante >= minTauSec (evento "inteiro"). */
async function waitFullEvent(minTauSec = 270) {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    const slot = Math.floor(now / 300) * 300;
    const nextStart = (slot + 300) * 1000;
    const cur = await resolveMarket(`btc-updown-5m-${slot}`);
    if (cur) {
      const tau = (cur.endMs - Date.now()) / 1000;
      if (tau >= minTauSec) {
        console.log(`Usando evento corrente (tau=${tau.toFixed(0)}s >= ${minTauSec}s)`);
        return cur;
      }
      console.log(`Evento corrente tarde (tau=${tau.toFixed(0)}s) — aguardando próximo…`);
    }
    const waitMs = Math.max(1000, nextStart - Date.now() + 1500);
    console.log(`Espera ${Math.ceil(waitMs / 1000)}s até slot ${new Date(nextStart).toISOString()}`);
    await new Promise((r) => setTimeout(r, Math.min(waitMs, 15_000)));
    if (Date.now() >= nextStart) {
      const m = await resolveMarket(`btc-updown-5m-${slot + 300}`);
      if (m) return m;
    }
  }
}

async function bestBook(tokenId) {
  const r = await fetch(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!r.ok) return { ask: null, bid: null };
  const book = await r.json();
  let ask = null;
  for (const a of book.asks || []) {
    const p = Number(a.price);
    if (!Number.isFinite(p)) continue;
    if (ask == null || p < ask) ask = p;
  }
  let bid = null;
  for (const b of book.bids || []) {
    const p = Number(b.price);
    if (!Number.isFinite(p)) continue;
    if (bid == null || p > bid) bid = p;
  }
  return { ask, bid };
}

function printSnap(label, s, askUp, askDn, tau) {
  const soma = askUp != null && askDn != null ? ((askUp + askDn) * 100).toFixed(0) : '?';
  const exit = s.exitReason ? ` exit=${s.exitReason}` : '';
  process.stdout.write(
    `\r[${label}] τ=${tau.toFixed(0)}s UP ${(askUp * 100)?.toFixed?.(0) ?? '?'}c DN ${(askDn * 100)?.toFixed?.(0) ?? '?'}c (${soma}c) | `
    + `hon f=${s.fills} r=${s.restingOpen ?? 0} ${s.shares.UP.toFixed(0)}/${s.shares.DOWN.toFixed(0)} `
    + `vir=${s.viradas} $${s.invested.toFixed(0)} sum=${(s.sum * 100).toFixed(0)}c${exit}   `,
  );
}

function finalizePnl(snap, askUp, askDn) {
  if (snap.exitReason === 'stop' && snap.realizedPnl != null) {
    return { pnl: snap.realizedPnl, winner: null, reason: 'stop' };
  }
  if (snap.equalized) {
    return { pnl: snap.pnlEq ?? snap.realizedPnl, winner: null, reason: 'equalized' };
  }
  if (askUp == null || askDn == null) {
    return { pnl: snap.realizedPnl, winner: null, reason: snap.exitReason ?? 'no_odds' };
  }
  const winner = askUp >= askDn ? 'UP' : 'DOWN';
  const payout = snap.shares[winner];
  return { pnl: payout - snap.invested, winner, reason: snap.exitReason ?? 'odds' };
}

async function main() {
  const fullEvent = hasFlag('--full-event');
  const maxSec = argNum('--seconds', fullEvent ? 320 : 280);
  const janela = argNum('--janela', 280);
  console.log('Live shadow pair — classic | v4 | v4-gates | v4-gates-honest');
  console.log(fullEvent
    ? 'Modo: EVENTO INTEIRO (espera tau alto + opera ≤ janela)'
    : `Modo: até ${maxSec}s / fim do evento\n`);
  console.log(`Freios: teto $500/$250 | MAX_VIR=${BRAKES.maxViradas} | STOP@${BRAKES.stopVirada} | PISO@${BRAKES.pisoViradas.join(',')}`);
  console.log(`Gates: refuseAvgSum=${DOGGY_GATES.refuseAvgSum} (só se piora) | multOnlyUW | lateVacuum≤${DOGGY_GATES.lateVacuumAsk}`);
  console.log('DESC: optimistic vs honest (atravessamento ask)');

  const minTau = argNum('--min-tau', 240);
  const mkt = fullEvent
    ? await waitFullEvent(minTau)
    : await resolveMarket();
  if (!mkt) {
    console.error('Nenhum mercado BTC 5m ativo encontrado na Gamma.');
    process.exit(2);
  }
  console.log(`\nMercado: ${mkt.title}`);
  console.log(`slug: ${mkt.slug}`);
  console.log(`janela: ${new Date(mkt.startMs).toISOString()} → ${new Date(mkt.endMs).toISOString()}\n`);

  const classic = createEngine(CLASSIC);
  const v4 = createEngine(V4);
  const v4g = createEngine(V4_GATES);
  const v4h = createEngine(V4_GATES_HONEST);
  const engines = [classic, v4, v4g, v4h];
  const started = Date.now();
  let stopped = false;
  let lastAsk = { up: null, dn: null };

  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);

  while (!stopped) {
    if (Date.now() - started > maxSec * 1000) break;
    if (Date.now() > mkt.endMs + 2000) break;

    const tau = Math.max(0, (mkt.endMs - Date.now()) / 1000);
    const [bookUp, bookDn] = await Promise.all([
      bestBook(mkt.tokenUp),
      bestBook(mkt.tokenDown),
    ]);
    lastAsk = { up: bookUp.ask, dn: bookDn.ask };

    if (tau <= janela && tau > 0) {
      const meta = { tau, bidUp: bookUp.bid, bidDn: bookDn.bid };
      for (const eng of engines) eng.onTick(bookUp.ask, bookDn.ask, meta);
    }
    printSnap(new Date().toISOString().slice(11, 19), v4h.snapshot(), bookUp.ask, bookDn.ask, tau);

    if (engines.every((e) => e.snapshot().encerrado) && !fullEvent) {
      console.log('\n\nTodos encerraram — early exit.');
      break;
    }
    if (tau <= 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  await new Promise((r) => setTimeout(r, 800));
  const [finalUp, finalDn] = await Promise.all([
    bestBook(mkt.tokenUp),
    bestBook(mkt.tokenDown),
  ]);
  if (finalUp.ask != null) lastAsk.up = finalUp.ask;
  if (finalDn.ask != null) lastAsk.dn = finalDn.ask;

  console.log('\n\n=== RESULTADO (refuse refinado + DESC honest) ===');
  const results = {};
  for (const eng of engines) {
    const s = eng.snapshot();
    const fin = finalizePnl(s, lastAsk.up, lastAsk.dn);
    results[s.cfg] = { ...s, final: fin, finalAsk: lastAsk };
    console.log(`\n${s.cfg}:`);
    console.log(`  gates=${JSON.stringify(s.gates)}`);
    console.log(`  ticks=${s.ticks} fills=${s.fills} resting=${s.restingOpen} viradas=${s.viradas} exit=${s.exitReason ?? '—'}`);
    console.log(`  shares UP/DN=${s.shares.UP}/${s.shares.DOWN} investido=$${s.invested.toFixed(2)} (teto $${s.maxEventNotional})`);
    console.log(`  médias ${(s.avgUp * 100).toFixed(1)}c + ${(s.avgDn * 100).toFixed(1)}c = ${(s.sum * 100).toFixed(1)}c`);
    console.log(`  blocks=${JSON.stringify(s.blockCounts)}`);
    console.log(`  final odds UP/DN=${((lastAsk.up ?? 0) * 100).toFixed(0)}/${((lastAsk.dn ?? 0) * 100).toFixed(0)}c | ${fin.reason} winner=${fin.winner ?? '—'}`);
    if (fin.pnl != null) console.log(`  PnL $${fin.pnl.toFixed(2)}`);
    console.log('  últimos fills:');
    for (const f of s.lastFills) {
      const extra = f.pnl != null ? ` pnl=$${f.pnl.toFixed(2)}` : '';
      console.log(`    ${f.lado} ${f.tipo} ${f.sh}sh @ ${f.px != null ? `${(f.px * 100).toFixed(1)}c` : '—'}${extra}`);
    }
  }

  const dGates = (results['v4-gates'].final.pnl ?? 0) - (results.v4.final.pnl ?? 0);
  const dHonest = (results['v4-gates-honest'].final.pnl ?? 0) - (results['v4-gates'].final.pnl ?? 0);
  const dV4 = (results.v4.final.pnl ?? 0) - (results.classic.final.pnl ?? 0);
  console.log(`\nΔ PnL (v4 − classic) = $${dV4.toFixed(2)}`);
  console.log(`Δ PnL (v4-gates − v4) = $${dGates.toFixed(2)}`);
  console.log(`Δ PnL (honest − optimistic gates) = $${dHonest.toFixed(2)}`);

  const outDir = path.resolve(ROOT, 'labs/strategies/carry/shotandgo-v1/shadow');
  fs.mkdirSync(outDir, { recursive: true });
  const out = {
    kind: 'shotandgo-live-shadow-pair',
    brakes: true,
    doggyGates: true,
    refuseRefined: true,
    descHonestAblation: true,
    fullEvent,
    slug: mkt.slug,
    capturedAt: new Date().toISOString(),
    classic: results.classic,
    v4: results.v4,
    'v4-gates': results['v4-gates'],
    'v4-gates-honest': results['v4-gates-honest'],
    deltaPnlV4MinusClassic: dV4,
    deltaPnlGatesMinusV4: dGates,
    deltaPnlHonestMinusOptimistic: dHonest,
    classicFills: classic.fills(),
    v4Fills: v4.fills(),
    v4GatesFills: v4g.fills(),
    v4HonestFills: v4h.fills(),
    ticksSample: v4h.ticks().filter((_, i, a) => i % 5 === 0 || i > a.length - 20),
  };
  const outPath = path.join(outDir, `${mkt.slug}.live-pair-desc.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\nsalvo: ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
