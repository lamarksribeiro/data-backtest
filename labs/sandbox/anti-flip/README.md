# Anti-Flip — detecção de reversões no fim do evento (BTC 5m)

**Data:** 2026-07-27 · **Dados:** 91 dias (2026-04-23 → 2026-07-26), 23.829 eventos BTC 5m, book depth 25
**Splits:** train `< 2026-06-25` · holdout `>= 2026-06-25`
**Labels:** vencedor por `spot > PTB` no último tick, validado contra o mid do book final (descarta feed stale)

## Pergunta

Detectar, com antecedência, os *flips* — eventos em que o líder (spot vs PTB) perde a
liderança antes do settlement — para não entrar, sair antes, ou minimizar o prejuízo.

## Resposta curta

1. **Pré-entrada não existe alfa de previsão de flip.** O preço do book *é* o preditor, e é
   bem calibrado. Nenhuma feature de microestrutura acrescenta poder discriminante sobre ele.
2. **Dentro do trade existe, e é grande.** Uma regra de saída tick-a-tick — *perdeu a
   liderança do spot **E** o bid do nosso lado caiu abaixo de 0,45* — **mais que dobra o PnL
   e corta o drawdown em 65%**, com liquidez real confirmada.

---

## 1. Taxa-base de flip e calibração

Probabilidade de o líder em τ segundos do fim **não** ser o vencedor:

| τ | 120s | 90s | 60s | 45s | 30s | 20s | 10s |
|---|---|---|---|---|---|---|---|
| flip | 22,0% | 18,6% | 15,6% | 13,6% | **11,1%** | **9,1%** | **6,9%** |

O modelo de difusão (browniano, σ realizada em 60s, `z = |dist| / (σ·√τ)`) **subestima
sistematicamente** o flip fora da região central — em τ=30s, `z ∈ [3,5)` tem flip empírico de
6,0% contra 0,0% teórico. A cauda é gorda: existe um regime de *salto* que o browniano não vê.

| z (τ=30s) | [0; 0,25) | [0,5; 0,75) | [1; 1,5) | [2; 3) | [3; 5) | ≥5 |
|---|---|---|---|---|---|---|
| flip empírico | 46,1% | 28,3% | 18,3% | 10,7% | 6,0% | 3,2% |
| flip browniano | 50,0% | 49,3% | 21,4% | 1,7% | 0,0% | 0,0% |

## 2. O preço do mercado domina qualquer feature

AUC no holdout para prever flip:

| τ | modelo completo (6 features) | só `favMid` | só `z` |
|---|---|---|---|
| 60s | 0,851 | **0,852** | 0,755 |
| 30s | 0,909 | **0,911** | 0,774 |
| 10s | 0,956 | **0,962** | 0,752 |

O modelo com z, momentum, cruzamentos, repricing e idade do último cruzamento **não bate o
preço sozinho**. Pior: dentro de cada faixa de preço, as features de microestrutura têm
AUC ≈ 0,50 — **zero informação residual**:

| faixa `favMid` | n (ho) | AUC microestrutura |
|---|---|---|
| 0,55–0,70 | 571 | 0,526 |
| 0,70–0,80 | 576 | 0,505 |
| 0,80–0,90 | 911 | 0,493 |
| 0,90–0,95 | 871 | 0,534 |

**Conclusão:** não há como "prever o flip antes do mercado". O que existe é um viés de nível —
em toda faixa o flip real fica **abaixo** do implícito (0,80–0,90 → real 10,1% vs implícito
15,0%), que é exatamente a tese já explorada por TFC/MIDAS.

### Uso prático pré-entrada

O preço é o gate. `favMid ≥ 0,95` em τ=30s → flip de **0,9%**. `favMid < 0,90` → 91% dos flips
ficam nesse alerta de 33% dos eventos. Não é previsão, é leitura de preço — mas serve como
gate de risco barato.

## 3. Regra de saída (o resultado que importa)

Simulação tick-a-tick: entrada no favorito em τ=30s (ask 0,50–0,94, US$ 10, taker),
monitoramento a cada tick, saída taker no bid do nosso lado, fee `0,07·p·(1−p)`,
settle 0,995. **8.252 trades, 91 dias.**

| variante | saídas | PnL | exp | PF | maxDD | pior dia | train | holdout |
|---|---|---|---|---|---|---|---|---|
| **`lead_bid40`** (perdeu liderança **E** bid < 0,40) | 18,8% | **$2.728** | 0,331 | 1,207 | **$79** | −$67 | +$1.640 | +$1.088 |
| `lead_bid45` (bid < 0,45) | 19,5% | $2.703 | 0,328 | 1,208 | $73 | −$73 | +$1.642 | +$1.061 |
| `lead` (só perdeu liderança) | 22,2% | $2.426 | 0,294 | 1,195 | $113 | −$81 | +$1.484 | +$942 |
| **`hold`** (baseline, segura até settle) | — | $1.213 | 0,147 | 1,077 | $207 | −$147 | +$775 | +$437 |
| `bid45` (só book, sem confirmação de spot) | 30,4% | **−$343** | −0,042 | 0,974 | $2.272 | −$604 | −$1.512 | +$1.170 |
| `shock` (queda de mid 0,15 em 2s) | 43,7% | **−$1.756** | −0,213 | 0,857 | $2.149 | −$446 | −$2.227 | +$471 |

**`lead_bid40` vs hold: PnL +125%, maxDD −62%, pior dia −55%.** Positivo em train e holdout,
delta positivo em **71 de 91 dias**. Por mês, o delta de `lead_bid45` é −$63 (abril, n=404),
+$627 (maio), +$406 (junho), +$520 (julho) — o único mês negativo é o de menor amostra,
com apenas 8 dias de dados.

### Por que a confirmação dupla é obrigatória

As variantes que usam **só o book** (`bid45`, `shock`, `lead_or_bid35`) são **destrutivas** —
disparam em repricing transitório e vendem o fundo de whipsaws. Isso reproduz de forma
independente a rejeição já registrada em `midas-carry-v1.md` (`earlyWarnEnabled`, −US$ 530 a
−US$ 620). O sinal só funciona quando **o spot cruza o strike** (evento físico) **e** o book
confirma (não é ruído de um único tick).

Nas 1.607 posições em que `lead_bid45` disparou, a WR se tivesse segurado era de apenas
**16,6%** — a regra está cortando um subconjunto genuinamente perdedor, não trades aleatórios.
Falsos alarmes custam −$2.737; acertos rendem +$4.227.

### Antecedência

Mediana de **13,5 segundos** restantes no momento do sinal (p25 = 6s, p75 = 21s); 62% dos
sinais disparam com mais de 10s de sobra. É aviso operacional real, não reação no estouro.

## 4. Realismo de execução (checado, não assumido)

Varredura do book bid depth 25 no instante exato de cada saída (n = 1.607):

- Profundidade mediana disponível: **6.304 shares** contra **14,5 shares** necessários (p95 = 19,2)
- **99,1%** das saídas preenchem 100% do tamanho; 15 casos de preenchimento parcial
- Slippage mediano vs best bid: **0,0000** (p90 = 0,0094)
- Custo total do realismo: **−$36 sobre −$10.941 (−0,3%)**
- Liquidez **não** colapsa no fim: mesmo na faixa 2–5s restantes, profundidade mediana 4.954 shares

## 5. O que foi testado e rejeitado

| Hipótese | Resultado |
|---|---|
| Modelo logístico multi-feature prevê flip melhor que o preço | Não — AUC igual ao `favMid` sozinho |
| Microestrutura tem sinal residual dentro da faixa de preço | Não — AUC ≈ 0,50 |
| Momentum contra o líder prevê flip | Marginal e some ao condicionar no preço |
| Contagem de cruzamentos (`cross60`) prevê flip | Não — flip 26,4% (0 cruzamentos) vs 29,9% (5) |
| Idade do último cruzamento | Não — sem monotonicidade |
| Feed stale (`staleSecs`) como precursor | Não — n insuficiente e sem sinal |
| Hora do dia / slot de 5 min | Fraco — 7,8% (14h UTC) a 13,9% (01h UTC); não acionável sozinho |
| Saída por choque de odds sem confirmação de spot | **Destrutivo** (−$1.756) |
| Gate pré-entrada por `pFlip` do modelo | Inconsistente entre train e holdout |

## 6. Reprodução

```powershell
# 1. Extrai cubo de features por evento x checkpoint (~166k linhas, ~2 min)
node labs/sandbox/anti-flip/extract-flip-features.mjs --out <path>/flip-features.csv

# 2. Calibração, AUC, poder residual
python labs/sandbox/anti-flip/analyze-flips-1-calibration.py
python labs/sandbox/anti-flip/analyze-flips-2-residual.py

# 3. Simulação tick-a-tick das 11 variantes de saída
node labs/sandbox/anti-flip/tick-level-exit.mjs --out <path>/tick-exit.csv
python labs/sandbox/anti-flip/analyze-flips-3-tick-exit.py

# 4. Checagem de liquidez real no bid no instante da saída
node --max-old-space-size=8192 labs/sandbox/anti-flip/exit-liquidity-check.mjs --out <path>/exit-liq.csv
```

Os scripts Python têm os caminhos de CSV no topo do arquivo — ajuste antes de rodar.

## 7. Próximo passo sugerido

Portar `lead_bid40` para o GLS como saída da MIDAS Carry V1 e rodar `lab:run-preset` com
`btc-gold-v1` para medir o efeito dentro do motor oficial, com o envelope real da campeã
(τ ≤ 30s, tier high-ask, danger floor). O lab aqui usa entrada simplificada em τ=30s; o ganho
precisa ser reconfirmado sob os gates da estratégia de produção antes de qualquer promoção.
