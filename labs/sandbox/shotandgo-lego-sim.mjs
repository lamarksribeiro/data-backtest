/**
 * Shotandgo Lego — simulador limpo, peça a peça (sem lab SOA / sem parquet).
 *
 * Essência (Phil_Hopper_Real_v4.py):
 *   1) Inventário: SUB[i] > DESC[i] em todo degrau (lado que SOBE fica maior).
 *   2) Equalização compra o lado com MENOS shares (= barato) a ~5c.
 *   3) PnL se equalizou: shares * (1 - media_UP - media_DOWN).
 *   Se DESC >= SUB no fundo, EQ compra o CARO e o edge morre.
 *
 * Uso:
 *   node labs/sandbox/shotandgo-lego-sim.mjs
 *   node labs/sandbox/shotandgo-lego-sim.mjs --piece eq
 *   node labs/sandbox/shotandgo-lego-sim.mjs --piece sizing
 *   node labs/sandbox/shotandgo-lego-sim.mjs --piece path
 *   node labs/sandbox/shotandgo-lego-sim.mjs --piece all
 */

// ─── configs ─────────────────────────────────────────────────
const CLASSIC = {
  id: 'classic-lab',
  sub: [55, 60, 65, 70, 75, 80, 85, 90],
  desc: [45, 40, 35, 30, 25, 20, 15, 10],
  sharesSub: [20, 15, 10, 10, 5, 5, 1, 1],
  sharesDesc: [5, 5, 5, 5, 5, 5, 5, 5],
  mult: [2, 3, 4, 5, 6, 6],
};

const V4 = {
  id: 'v4-live-min',
  sub: [55, 60, 65, 70, 75, 80, 85, 90],
  desc: [45, 40, 35, 30, 25, 20, 15, 10],
  // Phil_Hopper_Real_v4.py — SUB > DESC em todo idx; min $1/nível
  sharesSub: [4, 4, 4, 5, 5, 6, 8, 11],
  sharesDesc: [3, 3, 3, 4, 4, 5, 7, 10],
  mult: [2, 3, 4, 5, 6, 6],
};

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Peça 1: matemática da equalização ───────────────────────
function pieceEqEconomics() {
  console.log('\n=== PEÇA 1: Equalização (edge) ===');
  console.log('Tese: após EQ, PnL = shares * (1 - avgUp - avgDown)');
  console.log('EQ deve comprar o lado BARATO (menos shares).\n');

  const cases = [
    {
      name: 'bom: mais shares no caro, EQ compra barato',
      up: { sh: 40, cost: 40 * 0.70 },
      dn: { sh: 30, cost: 30 * 0.25 },
      // menor=DOWN@25c → EQ +10sh @5c
      eqSide: 'DOWN',
      eqSh: 10,
      eqPx: 0.05,
    },
    {
      name: 'ruim: mais shares no barato, EQ compra caro',
      up: { sh: 30, cost: 30 * 0.70 },
      dn: { sh: 40, cost: 40 * 0.25 },
      // menor=UP@70c → EQ +10sh @5c ainda no UP? na prática ask UP alto;
      // se força EQ no menor (UP), paga 70c+ — destruímos edge
      eqSide: 'UP',
      eqSh: 10,
      eqPx: 0.70,
    },
  ];

  for (const c of cases) {
    const up = { ...c.up };
    const dn = { ...c.dn };
    if (c.eqSide === 'UP') {
      up.sh += c.eqSh;
      up.cost += c.eqSh * c.eqPx;
    } else {
      dn.sh += c.eqSh;
      dn.cost += c.eqSh * c.eqPx;
    }
    const sh = Math.min(up.sh, dn.sh);
    const avgUp = up.cost / up.sh;
    const avgDn = dn.cost / dn.sh;
    const sum = avgUp + avgDn;
    const pnl = sh * (1 - sum);
    console.log(`  ${c.name}`);
    console.log(`    avgUp=${(avgUp * 100).toFixed(1)}c avgDn=${(avgDn * 100).toFixed(1)}c soma=${(sum * 100).toFixed(1)}c`);
    console.log(`    shares=${sh} PnL=$${pnl.toFixed(2)} ${pnl > 0 ? 'OK' : 'DESTRÓI EDGE'}`);
  }
}

// ─── Peça 2: invariante de sizing ────────────────────────────
function pieceSizingInvariant() {
  console.log('\n=== PEÇA 2: Invariante SUB[i] > DESC[i] ===');
  for (const cfg of [CLASSIC, V4]) {
    console.log(`\n  Config ${cfg.id}:`);
    let violations = 0;
    for (let i = 0; i < cfg.sub.length; i++) {
      const ok = cfg.sharesSub[i] > cfg.sharesDesc[i];
      if (!ok) violations += 1;
      const mark = ok ? '  ' : '!!';
      console.log(`  ${mark} idx ${i + 1}: SUB@${cfg.sub[i]}c=${cfg.sharesSub[i]}sh  DESC@${cfg.desc[i]}c=${cfg.sharesDesc[i]}sh`
        + (ok ? '' : '  ← EQ tende a comprar o CARO neste degrau'));
    }
    console.log(violations
      ? `  FALHA: ${violations} degrau(s) quebram a tese`
      : '  PASS: todos os degraus respeitam SUB > DESC');
  }
}

// ─── Peça 3: escada mínima num path sintético ────────────────
function buildLadder(cfg) {
  const levels = [];
  for (let i = 0; i < cfg.sub.length; i++) {
    levels.push({ tipo: 'SUB', idx: i + 1, preco: cfg.sub[i], shares: cfg.sharesSub[i], armado: true });
  }
  for (let i = 0; i < cfg.desc.length; i++) {
    levels.push({ tipo: 'DESC', idx: i + 1, preco: cfg.desc[i], shares: cfg.sharesDesc[i], armado: true });
  }
  return {
    UP: levels.map((n) => ({ ...n })),
    DOWN: levels.map((n) => ({ ...n })),
  };
}

/**
 * Simulador Lego minimalista (optimistic fills, sem fees, 1 lado path).
 * Path = série de asks UP em centavos; DOWN = 100 - UP.
 * Re-arme complementar; MULT só em SUB; sem contagio/piso/stop (peça isolada).
 */
function simulatePathMinimal(cfg, pathCents, opts = {}) {
  const contagio = opts.contagio ?? 'off';
  const eqPreco = opts.eqPreco ?? 0.05;
  const ladder = buildLadder(cfg);
  const histSub = [];
  const ativo = { UP: 1, DOWN: 1, G: 1 };
  let shares = { UP: 0, DOWN: 0 };
  let cost = { UP: 0, DOWN: 0 };
  const fills = [];
  let viradas = 0;
  let equalized = false;

  function fator(idx, lado) {
    const n = histSub.filter((h) => h.idx === idx).length;
    let f = n === 0 ? 1 : cfg.mult[Math.min(n, cfg.mult.length) - 1];
    if (contagio === 'global' && ativo.G >= 5) f = Math.max(f, ativo.G);
    if (f > 1) {
      ativo[lado] = Math.max(ativo[lado], f);
      ativo.G = Math.max(ativo.G, f);
    }
    return f;
  }

  function buy(lado, tipo, idx, px, baseSh, f) {
    const sh = Math.round(baseSh * f * 100) / 100;
    shares[lado] += sh;
    cost[lado] += sh * px;
    fills.push({ lado, tipo: `${tipo}-${idx}`, sh, px, f });
  }

  for (const upC of pathCents) {
    if (equalized) break;
    const asks = { UP: upC / 100, DOWN: Math.max(1, Math.min(99, 100 - upC)) / 100 };
    for (const lado of ['UP', 'DOWN']) {
      const askC = asks[lado] * 100;
      for (const n of ladder[lado]) {
        if (!n.armado || equalized) continue;
        const hitSub = n.tipo === 'SUB' && askC >= n.preco;
        const hitDesc = n.tipo === 'DESC' && askC <= n.preco;
        if (!hitSub && !hitDesc) continue;
        const f = hitSub ? fator(n.idx, lado) : 1;
        buy(lado, n.tipo, n.idx, asks[lado], n.shares, f);
        if (hitSub) {
          histSub.push({ lado, idx: n.idx });
          if (n.idx === 1) viradas += 1;
        }
        n.armado = false;
        const comp = n.tipo === 'SUB' ? 'DESC' : 'SUB';
        for (const c of ladder[lado]) {
          if (c.tipo === comp && c.idx === n.idx) c.armado = true;
        }
      }
    }
    // EQ taker simples
    if (Math.abs(shares.UP - shares.DOWN) > 1e-9) {
      const menor = shares.UP < shares.DOWN ? 'UP' : 'DOWN';
      if (asks[menor] <= eqPreco + 1e-9) {
        const dif = Math.abs(shares.UP - shares.DOWN);
        buy(menor, 'EQUALIZA', 0, asks[menor], dif, 1);
        equalized = true;
      }
    }
  }

  const sh = Math.min(shares.UP, shares.DOWN);
  const avgUp = shares.UP > 0 ? cost.UP / shares.UP : 0;
  const avgDn = shares.DOWN > 0 ? cost.DOWN / shares.DOWN : 0;
  const sum = avgUp + avgDn;
  // se equalizou, payout = sh; senão exposto: assume UP venceu se path final >50
  let pnl;
  if (equalized) {
    pnl = sh - (cost.UP + cost.DOWN);
  } else {
    const winner = pathCents[pathCents.length - 1] >= 50 ? 'UP' : 'DOWN';
    const payout = shares[winner];
    pnl = payout - (cost.UP + cost.DOWN);
  }
  return {
    cfg: cfg.id,
    fills,
    shares,
    cost,
    avgUp,
    avgDn,
    sum,
    equalized,
    viradas,
    pnl,
    eqBought: fills.filter((f) => f.tipo.startsWith('EQUALIZA')).map((f) => ({
      lado: f.lado,
      px: f.px,
      expensive: f.px > 0.20,
    })),
  };
}

function piecePathCompare() {
  console.log('\n=== PEÇA 3: Path sintético classic vs v4 ===');
  // path sobe UP (SUB) depois cai (DESC) e vai a 5c no DOWN → EQ
  const path = (() => {
    // inline expand to avoid loading runner as module incorrectly
    const targets = [50, 55, 60, 70, 80, 90, 70, 50, 30, 10, 5];
    const out = [50];
    let cur = 50;
    for (const a of targets.slice(1)) {
      const st = a > cur ? 1 : -1;
      for (let p = cur + st; st > 0 ? p <= a : p >= a; p += st) out.push(p);
      cur = a;
    }
    return out;
  })();

  for (const cfg of [CLASSIC, V4]) {
    const r = simulatePathMinimal(cfg, path, { contagio: 'off' });
    console.log(`\n  ${cfg.id}:`);
    console.log(`    fills=${r.fills.length} viradas=${r.viradas} equalizou=${r.equalized}`);
    console.log(`    sh UP/DN=${r.shares.UP}/${r.shares.DOWN}`);
    console.log(`    médias ${(r.avgUp * 100).toFixed(1)}c + ${(r.avgDn * 100).toFixed(1)}c = ${(r.sum * 100).toFixed(1)}c`);
    console.log(`    PnL $${r.pnl.toFixed(2)}`);
    if (r.eqBought.length) {
      for (const e of r.eqBought) {
        console.log(`    EQ comprou ${e.lado} @ ${(e.px * 100).toFixed(0)}c ${e.expensive ? '← CARO (tese quebrada)' : '← barato OK'}`);
      }
    }
  }
}

// ─── Peça 4: prova de que classic fundo inverte ──────────────
function pieceDeepInversion() {
  console.log('\n=== PEÇA 4: Degrau fundo 90/10 — quem fica maior? ===');
  for (const cfg of [CLASSIC, V4]) {
    const i = 7; // 90 / 10
    const sub = cfg.sharesSub[i];
    const desc = cfg.sharesDesc[i];
    console.log(`  ${cfg.id}: SUB-8=${sub} DESC-8=${desc} → inventário após par:`);
    console.log(`    Se UP sobe a 90: +${sub} UP @90c`);
    console.log(`    Se depois DOWN sobe... ou UP cai a 10 DESC: +${desc} UP @10c`);
    // cenário: UP vai a 90 (SUB), re-arma DESC, UP cai a 10 (DESC no UP)
    // inventário UP: sub@90 + desc@10
    const costUp = sub * 0.9 + desc * 0.1;
    const shUp = sub + desc;
    // DOWN ainda 0 → EQ compraria DOWN (barato) se DOWN ask=5 — bom
    // cenário ruim classic: muitos DESC em níveis rasos no lado que caiu
    console.log(`    Após SUB-8+DESC-8 no mesmo lado: ${shUp}sh custo $${costUp.toFixed(2)} med ${(costUp / shUp * 100).toFixed(1)}c`);
  }

  console.log('\n  Cenário crítico classic: path que enche DESC no lado barato');
  // UP oscila pouco; DOWN sobe 55..90 com SUB e depois DESC no DOWN enche barato?
  // Simplificado: só compra DESC-8 no DOWN (10c, 5sh classic) e SUB-1 no UP (55c, 20sh)
  // → UP 20 @55, DOWN 5 @10 → EQ compra DOWN — bom
  // Mas se várias DESC no DOWN: 5*8=40sh @ avg ~27c e SUB UP só 20+15... 
  const classicDescHeavy = {
    up: { sh: 20 + 15, cost: 20 * 0.55 + 15 * 0.60 }, // 35sh
    dn: { sh: 5 * 8, cost: 5 * (0.45 + 0.40 + 0.35 + 0.30 + 0.25 + 0.20 + 0.15 + 0.10) }, // 40sh
  };
  console.log(`  classic se DOWN coleciona todos DESC e UP só SUB1+2:`);
  console.log(`    UP ${classicDescHeavy.up.sh}sh vs DOWN ${classicDescHeavy.dn.sh}sh`);
  console.log(`    menor=UP (caro!) → EQ compra UP → ${classicDescHeavy.up.sh < classicDescHeavy.dn.sh ? 'DESTRÓI' : 'ok'}`);
}

function main() {
  const piece = process.argv.includes('--piece')
    ? process.argv[process.argv.indexOf('--piece') + 1]
    : 'all';

  console.log('Shotandgo Lego — simulação limpa (sem parquet / sem SOA lab)');
  console.log('Referência viva: Phil_Hopper_Real_v4.py (sizing min + SUB>DESC)');

  if (piece === 'eq' || piece === 'all') pieceEqEconomics();
  if (piece === 'sizing' || piece === 'all') pieceSizingInvariant();
  if (piece === 'deep' || piece === 'all') pieceDeepInversion();
  if (piece === 'path' || piece === 'all') piecePathCompare();

  console.log('\n=== Próximo Lego ===');
  console.log('  5) Live shadow WS pareado (sem parquet)');
  console.log('  6) Reintroduzir MULT/contagio/STOP um a um no sizing v4');
  console.log('  7) Só então lab mai–jun com shares v4\n');
}

main();
