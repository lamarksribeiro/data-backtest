# Shotandgo V1 (Phil Escada Dupla)

**Status:** `research` (reaberta)  
**ID:** `shotandgo-v1`  
**Family:** `carry`  
**Runner:** `shotandgo-runner@1` · [`labs/legacy/strategy-runners/portable/shotandgo-runner.js`](../../../labs/legacy/strategy-runners/portable/shotandgo-runner.js)  
**Lab:** [`labs/strategies/carry/shotandgo-v1/`](../../../labs/strategies/carry/shotandgo-v1/)  
**Fonte live:** [`polymarket-fm/Phil_Hopper_Real.py`](../../../../polymarket-fm/Phil_Hopper_Real.py)

---

## Por que existe (e por que o post-mortem não mata)

O post-mortem de [`escada-dupla-v1`](../../rejeitadas/escada-dupla-v1.md) rejeitou o perfil **`ascent_hedge`** (`rearmMode=off`, `sideMultiplier=1`) — um carry simplificado cujo edge otimista era preço fantasma.

O Python live é **outra máquina**:

| | Lab rejeitado | Shotandgo Python |
|---|---|---|
| Re-arme | off | full (par complementar) |
| Multiplicador | 1 | `MULT=[2,3,4,5,6,6]` + contagio |
| Controles | freio avgSum | STOP, PISO, MAX_VIRADAS, DESC_MODO |
| Equalização | taker simples | EQ limite maker antecipada |
| Execução live | — | FOK + slip + DESC pendente |

Live com falhas ainda lucrou em n≈2 — insuficiente como prova, suficiente para **reabrir research** com runner fiel + lab honesto.

## Mecânica

1. Grade dual UP/DOWN: SUB 55…90¢ e DESC 45…10¢.
2. Disparo SUB quando ask sobe até o nível; DESC quando cai.
3. Ao disparar, desarma o nível e **re-arma o par** (mesmo idx, tipo oposto).
4. Fator SUB via `MULT[viradas_do_idx]` + contagio (`off|piso|lado|global`).
5. Virada = compra SUB-1 (conta os dois lados). Congela em `MAX_VIRADAS`.
6. Após `DESC_VIRADA`: `gatilho` (rearma sem comprar) | `congela` | `comprar`.
7. PISO eleva SUB-1 nas viradas configuradas.
8. STOP mark-to-bid a partir de `STOP_VIRADA`.
9. EQ limite: posta @5¢ quando lado menor ≤10¢; cancela ≥40¢.

## Superfície de realidade

| Modo | SUB / EQ taker | DESC / EQ maker |
|---|---|---|
| `honest` (default lab) | walk + `taker_limit` + FOK + latência opcional | resting (fill só por atravessamento) + timeout |
| `optimistic` (controle) | fill no ask/nível | fill imediato no nível |

Telemetria por evento: `takerMisses`, `descTimeouts`, `eqPosts`/`eqCancels`, `blockReasons`, `viradas`.

Fees: **somente** via `applyPolymarketFees` no pós-processador do lab (`0.07·p·(1−p)` crypto). O runner **não** embute fee no `cost` — a 1ª rodada (pré-2026-07-26 tarde) cobrava em dobro com fórmula errada e está invalidada.

## Protocolo shadow → replay (gate antes de lab em massa)

Ordem obrigatória: **1 evento live shadow → replay no runner → diff fill-a-fill**. Só depois disso sweeps mai–jun.

### 1. Captura (Phil)

Em [`polymarket-fm/Phil_Hopper_Real.py`](../../../../polymarket-fm/Phil_Hopper_Real.py):

- `MODO_REAL=True`, `DRY_RUN=True`, `SHADOW_CAPTURE=True`, `SHADOW_EXIT_AFTER=1`
- Gravador: [`shotandgo_shadow.py`](../../../../polymarket-fm/shotandgo_shadow.py) → `polymarket-fm/logs/shadow/<slug>.json`
- Pacote: `config` (snapshot) + `ticks[]` (ask/bid/book/btc/ptb/tau) + `intents[]`/`fills[]`/`blocks[]` + `end`

DRY_RUN: vê book/WS, decide, **não envia ordem**. Com `DESC_DRY_RESTING=True` (default):

| Perna | Dry Phil | Replay |
|---|---|---|
| SUB / EQ taker | walk-the-book | `honest` (walk + FOK) |
| DESC | resting + atravessamento + timeout 45s | `honest` |

Pacotes antigos (sem `desc_dry_resting` no config) ainda mapeiam dry → `optimistic`.

### 2. Replay + diff

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node labs/sandbox/shotandgo-shadow-replay.mjs --shadow ..\polymarket-fm\logs\shadow\<slug>.json
# plumbing / lake bootstrap (não substitui Phil):
node labs/sandbox/shotandgo-shadow-replay.mjs --from-lake --day 2026-06-01 --strict
node labs/sandbox/shotandgo-shadow-replay.mjs --synth --strict
```

Critério “bateu”: mesma sequência `(lado, tipo)` (±1 tick de latência aceitável em live); |ΔPnL| &lt; $0,50 ou 5% do notional.

Relatório: [`labs/strategies/carry/shotandgo-v1/shadow/PARITY-REPORT.md`](../../../labs/strategies/carry/shotandgo-v1/shadow/PARITY-REPORT.md).

**Status 2026-07-26:**
- `btc-updown-5m-1785096300` (DESC dry otimista legado) → `optimistic` PASS; `honest` FAIL (DESC).
- Após `DESC_DRY_RESTING`: novo evento deve replay em `honest` — ver PARITY-REPORT.

### 3. Próximos gates

1. ≥1 evento shadow com DESC resting → PASS em `honest`
2. Micro-real (`DRY_RUN=False`, teto baixo) se o conector estiver disponível
3. Só então lab mai–jun em `honest`

## Experimentos

| Experimento | Janela | Objetivo |
|---|---|---|
| `parity-smoke.json` | 2 dias jul | Plumbing |
| `live-honest-may-june.json` | mai–jun limpa | **Decisivo** — baseline Python + ablações (só após shadow live PASS) |
| `ablation-sizing-may-june.json` | mai–jun | sizeScale × execução × latência |

**Gate candidatura robô (pré-declarado):** PF ≥ 1,2 e PnL > 0 em `executionMode=honest` na janela limpa. Julho congelado até existir candidato.

## Comandos

```powershell
cd d:\Projetos\projeto-goldenlens\data-backtest
node --test tests/shotandgoParity.test.js
node labs/sandbox/shotandgo-shadow-replay.mjs --synth --strict
npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/parity-smoke.json --variant-workers 2
# mai–jun só após shadow Phil live PASS:
# npm run lab:run -- --experiment labs/strategies/carry/shotandgo-v1/experiments/live-honest-may-june.json --variant-workers 4
```

Após editar o portable:

```powershell
npm run package:strategy-library -- --source labs/legacy/strategy-runners/portable/shotandgo-runner.js --slug shotandgo-runner --name "Shotandgo Runner" --version 1
npm run embed:strategy-libraries
```

## Fora de escopo (ainda)

- Port `data-robot` / Giovanna
- Studio promotion
- Reabrir presets v5/v6 da Escada Dupla ascent_hedge
