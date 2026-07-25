import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(__dirname, 'canvas-rows.json'), 'utf8'));

const ALL_ROWS = JSON.stringify(data.all, null, 2);
const MISSING_ROWS = JSON.stringify(
  data.all.filter((r) => r[12] === 'missing'),
  null,
  2,
);
const OVERLAP_ROWS = JSON.stringify(
  data.all.filter((r) => r[12] !== 'missing'),
  null,
  2,
);

const src = `import {
  BarChart,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Grid,
  H1,
  H2,
  H3,
  Pill,
  Row,
  Stack,
  Stat,
  Table,
  Text,
} from 'cursor/canvas';

const HEADERS = ['UTC', 'Market', 'L side', 'L entry', 'Qty', 'L PnL', 'L exit', 'BT side', 'BT entry', 'BT PnL', 'BT exit', 'ΔPnL', 'Class'];
const ALL_ROWS = ${ALL_ROWS};
const OVERLAP_ROWS = ${OVERLAP_ROWS};
const MISSING_ROWS = ${MISSING_ROWS};

export default function MidasRelatorioCompleto() {
  return (
    <Stack gap={24}>
      <Stack gap={8}>
        <H1>Relatório MIDAS — live × backtest</H1>
        <Text tone="secondary">
          midas-carry-v1 · btc-micro-aggressive-v1 ($2/$4) · 2026-07-24→25 UTC · gerado 2026-07-25T17:05Z
        </Text>
        <Row gap={8} wrap>
          <Pill tone="success">40 trades live</Pill>
          <Pill tone="warning">23 no lake / 17 missing</Pill>
          <Pill tone="neutral">WR 80% ≈ BT 79%</Pill>
          <Pill tone="deleted">Late-flip gap</Pill>
        </Row>
      </Stack>

      <Callout tone="warning" title="Veredito executivo">
        O edge direcional está confirmado (WR live 80% ≈ BT 79%). O gap de PnL (+$2,67 live vs
        +$24,22 BT no dia) vem de três frentes: (1) cobertura — live fez 40 entradas vs 125 no BT;
        (2) path de saída — em losses o BT reverte e o live segura até expiry; (3) execução —
        FAK miss, fill/price drift e 1 caso de winner divergente live×lake. Nos 23 eventos
        presentes no lake, live +$1,03 vs BT +$4,01 (mesmo universo).
      </Callout>

      <H2>1. Comparativo agregado</H2>
      <Grid columns={4} gap={12}>
        <Stat label="PnL live journal" value="+$2.67" tone="success" />
        <Stat label="PnL BT dia cheio" value="+$24.22" tone="success" />
        <Stat label="PnL BT nos 23 overlap" value="+$4.01" />
        <Stat label="Live nos 23 overlap" value="+$1.03" tone="warning" />
      </Grid>
      <Grid columns={4} gap={12}>
        <Stat label="Entradas live / BT" value="40 / 125" />
        <Stat label="WR live / BT" value="80% / 79.2%" />
        <Stat label="PF live / BT" value="1.19 / 1.68" tone="warning" />
        <Stat label="Avg win / loss live" value="$0.53 / −$1.80" tone="danger" />
      </Grid>

      <BarChart
        categories={['Dia cheio', 'Só overlap lake (23)']}
        series={[
          { name: 'Live', data: [2.67, 1.03] },
          { name: 'Backtest', data: [24.22, 4.01] },
        ]}
        height={200}
      />
      <Text tone="secondary" size="small">
        Source: GET /trades Giovanna · lab preset Brutus · replay onEventFinalized nos 40 eventStarts live
      </Text>

      <H2>2. Classificação dos 40 trades</H2>
      <Grid columns={2} gap={16}>
        <Card>
          <CardHeader>Distribuição de paridade</CardHeader>
          <CardBody>
            <Table
              headers={['Classe', 'N', 'Significado']}
              rows={[
                ['≈ near_parity', '13', '|ΔPnL| < $0.15, mesmo lado'],
                ['pnlΔ pnl_gap', '7', 'mesmo lado, PnL diverge'],
                ['exitΔ exit_path', '2', 'BT reverteu; live hold/settle'],
                ['noENT bt_no_entry', '1', 'live entrou; BT sem entry'],
                ['missing', '17', 'evento ausente no lake (omit/atraso)'],
              ]}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader>Breakdown do gap overlap (23)</CardHeader>
          <CardBody>
            <Stack gap={8}>
              <Text>Live +$1,03 vs BT +$4,01 → gap −$2,98 nos mesmos mercados.</Text>
              <Text>
                Principais vilões: exit_path em losses (1784933100 −$0,70; 1784951400 −$1,27) e
                winner divergente 1784963700 (live −$1,35 / BT +$0,66 = −$2,01).
              </Text>
              <Text tone="secondary" size="small">
                Caso 1784953500: live reverse “ganhou” +$0,63; BT reverse perdeu −$1,52 (reverse
                live incompleto / hold no lado original que venceu).
              </Text>
            </Stack>
          </CardBody>
        </Card>
      </Grid>

      <H2>3. Achados (catálogo)</H2>
      <Table
        headers={['ID', 'Sev', 'Achado', 'Evidência', 'Impacto']}
        rows={[
          ['A1', 'P0', 'Late-flip reverse não protege losses live', '8/8 losses sem lateFlip no audit; 2 exitΔ onde BT reverteu', 'PF 1.19 vs 1.68'],
          ['A2', 'P0', 'Saga REVERSE frágil (SELL incompleto)', '1784953500 REVERSE_EXIT_INCOMPLETE; oppAsk 0.07', 'Sinal sem hedge'],
          ['A3', 'P0', 'Winner live ≠ winner lake (1 caso)', '1784963700 DOWN: live Up/−1.35 · BT Down/+0.66', 'Paridade quebrada'],
          ['A4', 'P1', 'Cobertura operacional baixa', '40 vs 125 entradas; FAK miss×23; engine_started×35', 'PnL absoluto'],
          ['A5', 'P1', 'Fill/price drift vs BT', 'vários pnlΔ por entry 0.62 vs 0.89, 0.77 vs 0.84', 'PnL por trade'],
          ['A6', 'P1', 'PnL journal sem fee + settlement 0.995', 'fee est. ~$1.02; 47 settles @0.995', 'métrica otimista'],
          ['A7', 'P1', 'Journal multi-ENTER / multi-SETTLEMENT', '8+9 trades; audit 68 settles vs 40 trades', 'equity confusa'],
          ['A8', 'P2', 'Lake incompleto para paridade', '17/40 missing (omit stale + partição tarde)', 'BT undercount overlap'],
          ['A9', 'P2', 'Janela late-flip 4–8s estreita', 'cruzamento <4s não gera ação', 'loss cheia'],
          ['A10', 'P2', 'BT entry quando live não (e vice-versa)', '1 bt_no_entry; universo BT 125', 'seleção ≠ execução'],
        ]}
      />

      <H2>4. Deep-dive — divergências materiais</H2>
      <Table
        headers={['Market', 'Live', 'BT', 'Δ', 'Causa']}
        rows={[
          ['1784933100', 'DOWN hold −1.59', 'DOWN→UP reverse −0.89', '−0.70', 'exit path: live não reverteu'],
          ['1784951400', 'DOWN hold −1.61', 'DOWN→UP reverse −0.34', '−1.27', 'exit path: live não reverteu'],
          ['1784963700', 'DOWN settle Up −1.35', 'DOWN settle Down +0.66', '−2.01', 'WINNER DIVERGENTE live×lake'],
          ['1784953500', 'UP rev? +0.63', 'UP→DOWN reverse −1.52', '+2.15', 'reverse live incompleto; lado original venceu'],
          ['1784965200', 'DOWN @0.89 +0.35', 'DOWN @0.62 +1.14', '−0.80', 'fill bem pior no live'],
          ['1784947200', 'UP @0.77 +1.07', 'UP @0.84 +0.64', '+0.43', 'live fill melhor (FAK)'],
          ['1784958000', 'UP @0.94 +0.41', 'no_entry 0', '+0.41', 'live passou gate; BT não entrou'],
        ]}
      />

      <H2>5. Tabela trade-a-trade — overlap lake (23)</H2>
      <Text tone="secondary" size="small">
        Class: ≈ near · pnlΔ gap · exitΔ path · noENT BT sem entry · L/BT = live/backtest · REV = reverse_exit
      </Text>
      <Table headers={HEADERS} rows={OVERLAP_ROWS} />

      <H2>6. Tabela trade-a-trade — missing no lake (17)</H2>
      <Text tone="secondary" size="small">
        Eventos live sem callback no lake (omit stale flat ou partição ainda não consolidada). PnL live nesta fatia: +$1,64.
      </Text>
      <Table headers={HEADERS} rows={MISSING_ROWS} />

      <H2>7. Tabela completa (40)</H2>
      <Table headers={HEADERS} rows={ALL_ROWS} />

      <Divider />

      <H2>8. Propostas de solução</H2>

      <H3>P0 — recuperar proteção de loss (antes de subir budget)</H3>
      <Table
        headers={['#', 'Ação', 'Onde', 'Aceite']}
        rows={[
          ['S1', 'Replay PG dos 8 losses + 2 exitΔ: classificar cross timing / bid / inPosition / feed', 'scratch/live-vs-backtest', 'causa raiz por marketId'],
          ['S2', 'Robustecer reverseSaga: retry SELL FAK, timeout, fallback EXIT puro', 'data-robot reverseSaga.js', '0 REVERSE_EXIT_INCOMPLETE em fixture'],
          ['S3', 'Audit breadcrumb: lateFlip.active + reason a cada tick em posição', 'midasV1 + executionAudit', 'losses com trilha completa'],
          ['S4', 'Avaliar lateFlipExitSec↑ ou earlyWarnOnlyIfLosing no canário (holdout lab)', 'preset-midas + BT', 'lab PF ok; losses live ↓'],
          ['S5', 'Investigar 1784963700 winner live×Gamma vs lake PTB/oracle', 'settlement + lake', 'regra canônica de winner'],
        ]}
      />

      <H3>P1 — execução, métricas e harness</H3>
      <Table
        headers={['#', 'Ação', 'Onde', 'Aceite']}
        rows={[
          ['S6', 'Modelar FAK miss/partial no lab (taxa empírica ~23/59 submits)', 'data-backtest fill model', 'BT reporta expected live drag'],
          ['S7', 'Deduplicar ENTER/SETTLEMENT; PnL líquido de fee', 'tradeJournal.js + fees', '1 settle/trade; net≈wallet'],
          ['S8', 'Harness diário: /trades → compare-all-live.js → parity JSON', 'scratch + ops', 'alerta se exitΔ ou winnerΔ'],
          ['S9', 'Congelar deploys com POSITION_OPEN / reduzir restarts', 'Coolify Giovanna', 'engine_started/dia ↓'],
          ['S10', 'Normalizar ΔPnL por notional (qty BT vs live)', 'compare-all-live.js', 'gap justo por $'],
        ]}
      />

      <H3>P2 — dados e paridade de longo prazo</H3>
      <Table
        headers={['#', 'Ação', 'Onde', 'Aceite']}
        rows={[
          ['S11', 'Não omitir do lake eventos que o live operou; flag omit no parity', 'lake quality / PG replay', 'missing → 0 em D+1'],
          ['S12', 'Settlement journal 0/1 após Gamma final (não 0.995 early)', 'settlement path', 'preço canônico'],
          ['S13', 'Shadow fill-sim paralelo (mesmo snapshot → GLS)', 'data-robot shadow', 'ΔPnL esperado vs real'],
        ]}
      />

      <Callout tone="info" title="Ordem sugerida">
        S1 → S2 → S3 (P0) · depois S8 harness · S6/S7 métricas · só então reavaliar budget.
        Não promover capital enquanto exitΔ em losses continuar.
      </Callout>

      <H2>9. Apêndice — métricas operacionais live</H2>
      <Grid columns={3} gap={12}>
        <Stat label="FAK rejects" value="23" tone="warning" />
        <Stat label="REVERSE aceitos" value="2" />
        <Stat label="Protective halts" value="3" />
      </Grid>
      <Text tone="secondary" size="small">
        Artefatos: data-backtest/scratch/live-vs-backtest/full-parity-report.json,
        live-markets.json, compare-all-live.js, prod-trades.json, prod-audit-*.jsonl
      </Text>
    </Stack>
  );
}
`;

const out = join(
  'C:/Users/lamar/.cursor/projects/d-Projetos-projeto-goldenlens-data-colector/canvases',
  'midas-relatorio-completo.canvas.tsx',
);
writeFileSync(out, src);
console.log('wrote', out);
