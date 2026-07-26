# Escada Dupla V1 — Post-mortem (REJEITADA)

Data do veredito: **2026-07-26**
Estratégia: `escada-dupla-v1` (family `carry`, library-runner `escada-dupla-runner@1`)
Mercado: Polymarket BTC Up/Down 5 minutos
Auditoria de origem: [`../estrategias/auditoria-escada-dupla-realismo-2026-07-25.md`](../estrategias/auditoria-escada-dupla-realismo-2026-07-25.md)
Experimento decisivo: `labs/strategies/carry/escada-dupla-v1/experiments/taker-limit-may-june.json`
Relatório: `reports/labs/escada-dupla-v1/2026-07-26T00-26-13-517Z-escada-dupla-taker-limit-may-june/`

> **Escopo do veredito (2026-07-26, adendo):** este post-mortem invalida apenas o perfil **`ascent_hedge`** (`rearmMode=off`, `sideMultiplier=1`) e variantes honestas testadas nessa família. **Não cobre** a Escada Dupla live do `Phil_Hopper_Real.py` (Shotandgo: re-arme + MULT[] + contagio + STOP/PISO + EQ-limite). Essa variante foi reaberta como research em [`../estrategias/nao-implementadas/shotandgo-v1.md`](../estrategias/nao-implementadas/shotandgo-v1.md) / lab `labs/strategies/carry/shotandgo-v1/`.

> **Bug de taxa no port Shotandgo (2026-07-26):** a 1ª rodada de lab do `shotandgo-runner` embutia fee no `cost` **e** o lab aplicava `applyPolymarketFeesToBacktestResult` de novo — taxa em dobro, com fórmula interna errada (`0.25·(p(1−p))²` em vez de `0.07·p·(1−p)`). Corrigido: runner só contabiliza notional; fees ficam no pós-processador (padrão `escada-dupla`). Relatórios anteriores a essa correção estão **invalidados**.

---

## 1. Veredito

**REJEITADA pelo critério pré-declarado da auditoria** (gate Etapa 1: PF ≥ 1,2 e PnL > 0 em config honesta, janela limpa). Resultado real: **todas as 7 configs honestas perderam dinheiro em todos os cortes**, com PF entre 0,60 e 0,84 em 61 dias limpos (mai–jun/2026, nunca usados em seleção). A validação em julho congelado tornou-se desnecessária: nenhuma config se qualificou.

O edge do campeão (+US$ 38,8k, PF 1,87 em julho) era **integralmente artefato de execução** — compras taker a preços que não existiam no book no momento do disparo (gap médio de 1,9¢, p90 5¢; ver sonda 2 da auditoria).

## 2. O experimento decisivo (Etapa 1 da auditoria)

Implementado no runner (2026-07-26):

- **`takerPriceMode=taker_limit`**: marketable-limit honesto — fill só se o walk real do book ≤ fórmula+cap; senão MISS sem inventário (política `skip` perde o nível; `rearm` reaponta, equivalendo a limit resting no nível+cap).
- **`takerLatencyTicks`**: decide no tick t, executa contra o book do tick t+1 (~0,5s de latência de envio).
- Maker pessimista: `resting_maker` (fill só por atravessamento), `makerFillProb=1` (lab10 provou que p<1 é otimista — adverse selection).
- Janela limpa: 2026-05-01 → 2026-06-30 (61 dias, 10,97M ticks, ~16,5–16,9k entradas/variante, fees crypto on).
- Testes: `tests/escadaDuplaTakerLimit.test.js` (7 casos, miss/fill/latência/regressão dos modos antigos).

### Resultado (61 dias, ordenado por PnL)

| Variante | PnL | PF | WR | Dias+ | Leitura |
|---|---:|---:|---:|---:|---|
| `tl-cap1-skip-lat1` | −27.476 | 0,60 | 31,7% | 0/61 | "Melhor" = a que menos compra |
| `tl-cap1-rearm-lat0` | −28.232 | 0,72 | 41,4% | 4/61 | Sem latência, ainda perde |
| `control-walk-lat0` | −31.314 | 0,84 | 66,9% | 9/61 | Honesto antigo (lab09) confirmado fora da janela queimada |
| `control-walk-lat1` | −33.844 | 0,82 | 66,8% | 7/61 | Latência custa ~US$ 2,5k extras |
| `tl-cap2-rearm-lat1` | −36.407 | 0,69 | 42,2% | 4/61 | Cap maior = paga mais gap |
| `tl-cap1-rearm-lat1` | −37.592 | 0,68 | 40,9% | 2/61 | Config de referência da Etapa 1 |
| `tl-cap0-rearm-lat1` | −42.994 | 0,64 | 39,0% | 2/61 | Cap zero = só retries adversos |

## 3. Por que morreu (causas encadeadas)

1. **O lucro morava no preço fantasma.** Removida a fantasia (`taker_limit`), o win rate desaba de ~67% para 32–41%: os eventos "vencidos" eram os em que o backtest comprava o líder a preço velho durante o momentum.
2. **O miss não salva — só reduz o prejuízo.** `skip` perde menos (−27,5k vs −43k) por comprar menos, não por comprar melhor. A expectativa por fill é negativa; nenhuma política de miss/cap/latência muda o sinal.
3. **Retry é seleção adversa.** `rearm` com latência piora vs sem latência (−37,6k vs −28,2k): os fills recuperados no retry são os em que o preço voltou — exatamente quando o lado líder está enfraquecendo.
4. **O hedge maker é estruturalmente tóxico** (lab10 + §7.2 da auditoria): fill garantido quando continua caindo, miss quando reboteia.
5. Mesmo o controle honesto antigo (`walk`) com WR 66,9% fica com PF 0,84 — ganhos pequenos e frequentes, perdas raras e grandes (chicote + gap). Consistente com ANOM-01…04 e com o colapso da Hopper 3.

## 4. Lições permanentes

- **Modo de execução decide o sinal do PnL** neste mercado. Qualquer edge que só existe em `formula`/`capped`/`optimistic_maker`/`touch` com fill garantido é presumidamente falso até provado em `taker_limit`/`resting` + latência.
- O gap de cruzamento (sonda 2: média 1,9¢, 53% dos cruzamentos > 1¢) é uma propriedade do mercado BTC 5m, não da estratégia — afeta qualquer gatilho "compra quando o preço cruza X" executado a taker.
- Book profundo ≠ execução barata: profundidade nunca foi o problema (sonda 1); o problema é o preço no instante do disparo.
- Janela queimada engana: o holdout de julho estava contaminado por seleção múltipla; a janela limpa mai–jun confirmou o mesmo veredito com folga.

## 4b. Segunda matriz — mecânicas alternativas (2026-07-26, pós-veredito)

A pedido do operador, foram testadas 10 variações de mecânica mantendo a dinâmica de par, todas com execução honesta (experimento `mechanics-honest-may-june.json`, mesma janela limpa; runner ganhou `maxCrossGapCents` — gate de gap no gatilho — e `gapShareScaleCents` — shares dinâmicas por gap; testes em `tests/escadaDuplaGapGate.test.js`). Relatório: `reports/labs/escada-dupla-v1/…-escada-dupla-mechanics-honest-may-june/`.

| Variante | PnL | PF | WR | Dias+ |
|---|---:|---:|---:|---:|
| shares dinâmicas (dyn5) | −17.427 | 0,71 | 59,5% | 3/61 |
| gate2 + dyn5 | −21.164 | 0,73 | 60,9% | 4/61 |
| gate 2¢ | −24.746 | 0,71 | 57,7% | 4/61 |
| gate 1¢ | −26.909 | 0,75 | 61,8% | 4/61 |
| base taker_limit skip | −27.476 | 0,60 | 31,7% | 0/61 |
| SUB esparsa decrescente | −29.777 | 0,67 | 35,8% | 0/61 |
| esparsa + hedge fundo + gate2 | −30.685 | 0,66 | 47,2% | 0/61 |
| hedge só profundo (≤35¢) | −31.730 | 0,64 | 44,1% | 1/61 |
| **tudo maker** | **−54.084** | 0,66 | 44,4% | 3/61 |
| tudo maker + esparsa/fundo | −56.212 | 0,65 | 41,1% | 1/61 |

Conclusões adicionais:

1. **Shares dinâmicas e gates reduzem o prejuízo (−17,4k vs −27,5k) mas não mudam o sinal.** O mecanismo é o mesmo do skip: comprar menos nos piores momentos. O limite dessa família de melhorias é comprar zero.
2. **Tudo-maker é o PIOR cenário (−$54k/−$56k), não a salvação.** Sem pagar gap e sem fee, perde o dobro: fills maker nos dois lados são seleção adversa pura — o preço só vem até a ordem quando vai continuar contra ela. Isso fecha a rota de fuga "vira maker" para esta família de gatilhos.
3. Geometria (grade esparsa, hedge profundo) não altera a natureza do fluxo; piora levemente.
4. Padrão unificador das 17 configs honestas testadas nos dois experimentos: **PnL melhora monotonicamente à medida que a config negocia menos**. Expectativa por fill honesto é negativa em toda a família — não há parametrização vencedora.

## 5. Estado final

- Runner mantém os modos honestos (`taker_limit`, latência) — reutilizáveis por qualquer estratégia futura da família.
- Presets v5/v6 ("realistas") **não devem ser citados como realistas** — contêm preço fantasma.
- Studio: manter apenas para estudo histórico; **proibido testar em conta real / data-robot**.
- Experimento de julho congelado (`taker-limit-july-frozen.json`) fica no repo como referência, não executado por falta de candidato.
