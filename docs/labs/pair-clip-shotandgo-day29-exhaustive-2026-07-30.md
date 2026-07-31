# Pair-Path / Clip-Path / Shotandgo — campanha exaustiva do dia 29

**Data da campanha:** 2026-07-30  
**Descoberta:** partição UTC `dt=2026-07-29`, BTC Up/Down 5m, depth 25  
**Validação retrospectiva principal:** 2026-04-23 a 2026-07-28  
**Estado:** **RESEARCH / HOLD — nenhuma candidata apta para dry operacional ou ordens**

## Decisão

O dia 29 contém vários falsos campeões lucrativos. Todos os mecanismos
selecionados — complete-set imediato, Pair/Clip temporal, PTB-Path, proteção
reativa tipo Shotandgo, TSC com BUY-oposto/SELL, azarão profundo e maker tardio
— falharam ao menos um dos gates essenciais:

1. lucro positivo fora do dia de descoberta;
2. profit factor acima de 1;
3. risco residual pequeno;
4. tamanhos de ordem executáveis;
5. fill demonstrável sem reutilizar depth ou confundir cancelamento com trade;
6. outcome resolvido verificável.

O melhor resultado observado no dia não é uma estratégia encontrada. É uma
hipótese falsificada pela amostra anterior. Por isso nenhum dry com ordem em
conta real foi iniciado e nenhuma ordem foi enviada. A continuação descrita
abaixo usou apenas canais públicos GET/WSS para outcomes, book e trades.

## Trabalho executado

Três auditorias independentes rodaram em paralelo:

- cobertura, labels e integridade da partição do dia 29;
- realismo de execução, depth, latência, tamanho mínimo e settlement;
- decomposição do Shotandgo, seus stops, MULT, rearmes e taxas.

A busca principal teve:

- 261 variantes Pair/Clip do grid anterior reavaliadas;
- 378 sementes PTB-Path no estágio 1;
- 768 combinações de execução/proteção no estágio 2;
- 6 famílias diferentes levadas à validação retrospectiva;
- 1.290 relatórios maker no grid final do dia 29, correspondentes a 645
  políticas sob duas hipóteses de taxa;
- 26 relatórios maker representativos em 99 partições diárias;
- 12 relatórios maker finalistas em julho anterior ao dia 29;
- 108 variantes de azarão profundo com divisão treino/teste;
- 183 variantes de proteção TSC → Clip;
- 1.011 variantes TSC com SELL, BUY-oposto ou escolha híbrida;
- 25.269 eventos na calibração estrutural de 99 partições;
- 157.869 snapshots válidos no estudo estrutural do dia 29.

O grid maker de 645 políticas foi busca no dia 29. Apenas 13 políticas
representativas foram levadas ao histórico completo, em duas hipóteses de
taxa. Não se deve descrever isso como “645 políticas validadas em 99 dias”.

## Auditoria dos dados

O arquivo principal auditado foi:

```text
lake/backtest_ticks/underlying=BTC/interval=5m/book_depth=25/
  dt=2026-07-29/part-backtest-ticks-20260730055956-fb4fb9cb.parquet
```

| Propriedade | Resultado |
|---|---:|
| SHA-256 | `4F12C64BB8C87FD1A5F28447180E5E2D582E066CF2A94054B38A8431E1E6A7B4` |
| Tamanho | 40.530.221 bytes |
| Linhas | 158.400 |
| Eventos | 264 |
| Linhas/evento | 600 |
| Frequência mediana | 2 Hz |
| Duplicatas | 0 |

### Cobertura

A partição tem 264 de 288 eventos possíveis. Faltam 24 eventos em três blocos
UTC:

- 01:45–02:20: 8;
- 20:45–21:05: 5;
- 22:15–23:05: 11.

O manifest original lista 288 eventos/172.800 linhas; a normalização eliminou
24 mercados com dados subjacentes parados ou insuficientes. Quatro eventos
retidos ainda têm `bad_ratio` entre 19,8% e 47,5%. Portanto
`skippedCoverage=0` no runner não significa cobertura completa.

`dt` é UTC. “Dia civil 29” em America/Fortaleza exigiria também as três
primeiras horas de `dt=2026-07-30`. Esta campanha usa deliberadamente a
partição UTC do dia 29 para permanecer reproduzível.

### Settlement

Os 264 mercados do dia foram consultados no endpoint CLOB por
`condition_id`; todos estavam resolvidos. Oito epochs divergiram do proxy
terminal:

| Epoch | Vencedor canônico |
|---:|:---|
| 1785295200 | DOWN |
| 1785301200 | DOWN |
| 1785317100 | DOWN |
| 1785327900 | DOWN |
| 1785332100 | UP |
| 1785334800 | UP |
| 1785339600 | UP |
| 1785341700 | UP |

O proxy `spot > price_to_beat` errou 8/264. O proxy do book errou 2/264.
Quando se exige concordância entre os dois, seis casos ficam nulos e os dois
casos em que ambos erram continuam incorretos.

Na continuação, foi construído um journal append-only para todos os eventos do
lake:

| Medida | Resultado |
|---|---:|
| Eventos únicos no lake | 26.855 |
| Observações no journal | 51.763 |
| Labels resolvidos materializados | 26.855 |
| Cobertura | 100% |
| Conflitos observados | 0 |
| Fonte mais recente: Gamma keyset | 26.854 |
| Fonte mais recente: Gamma slug | 1 |

Esses são **labels Gamma resolvidos para pesquisa**, não prova completa de
finalidade CLOB/on-chain. Os oito casos divergentes do dia 29 foram
reconfirmados individualmente no CLOB e concordaram. O cache aplica
precedência `on-chain > CLOB explícito > Gamma > proxy`, grava novas
observações sem reescrever o journal e materializa uma visão CSV atômica.
Observações antigas importadas do seed não possuem hash da resposta original;
novas respostas passam a registrar SHA-256.

## Ciclos falha → solução → nova falha

### 1. Pair-Path / Clip-Path amplo

Das 261 variantes do grid principal, 249 abriram posição e todas perderam.
Doze não fizeram entrada.

| Variante | PnL | PF | Opens | EQ | Residuais | Pior evento |
|---|---:|---:|---:|---:|---:|---:|
| Melhor do grid: `deep3-ptbMin30` | -5,002 | 0,751 | 21 | 16 | 5 | -5,872 |
| `v0` | -111,285 | 0,374 | — | 80,00% | — | — |
| `tight2` | -114,302 | 0,427 | — | 75,88% | — | — |
| `deep3` | -116,852 | 0,467 | — | 71,76% | — | — |
| `deep4` | -120,203 | 0,475 | — | 68,82% | — | — |

**Falha:** clips reduzem algumas perdas, mas deixam inventário residual; o
residual domina a cauda.

**Solução testada:** restringir por retorno ao PTB, tau, confirmação, preço
favorito, cap de custo e execução full/tight/deep.

**Nova falha:** um `deep3` de 10 shares tenta ordens 4/3/3, abaixo do mínimo
observado de 5 shares. `deep4` e `tight2` com size 5 também são inexequíveis.
Ao impor o mínimo, o comportamento econômico muda e o aparente hedge profundo
desaparece.

### 2. PTB-Path e proteção reativa

No dia 29, a busca encontrou os seguintes finalistas:

| Família | PnL dia 29 | PF | Opens | EQ | Pior evento |
|---|---:|---:|---:|---:|---:|
| full | +10,648 | infinito | 15 | 100% | +0,243 |
| tight | +11,059 | infinito | 15 | 100% | +0,344 |
| deep | +22,078 | 2,912 | 10 | 0% | -5,872 |
| Shot-protect, delay +10 | +21,248 | 33,512 | 10 | 50% | -0,264 |
| PTB-delay | +20,061 | 4,417 | 10 | 40% | -5,872 |
| Shot-protect, delay -5 | +29,563 | 2,653 | 16 | 12,5% | -5,673 |

**Falha:** o dia isolado sugere lucro.

**Solução científica:** congelar seis mecanismos diversos e falsificá-los em
2026-04-23..2026-07-28, sem escolher novamente o parâmetro vencedor.

| Família | PnL histórico | PF | Opens | EQ | Meses positivos | Bootstrap p05 |
|---|---:|---:|---:|---:|---:|---:|
| full | -470,528 | 0,615 | 1.382 | 81,77% | 1/4 | -614,535 |
| tight | -457,668 | 0,656 | 1.382 | 76,56% | 0/4 | -607,922 |
| deep | -90,708 | 0,966 | 1.106 | 0% | 1/4 | -357,758 |
| Shot-protect +10 | -267,475 | 0,837 | 1.106 | 46,11% | 0/4 | -469,663 |
| PTB-delay | -114,578 | 0,942 | 1.106 | 30,74% | 1/4 | -346,161 |
| Shot-protect -5 | -300,569 | 0,895 | 1.473 | 25,80% | 0/4 | -577,390 |

**Nova falha:** 0/6 sobreviventes, agora com labels resolvidos em 100% dos
eventos do lake. A proteção que reduz o pior evento também consome o pequeno
prêmio recorrente; a proteção que preserva PnL deixa perdas de quase seis
dólares por evento.

### 3. Shotandgo completo

A decomposição fee-aware do dia 29 encontrou:

- Shotandgo clássico: gross +290,14; taxas 1.099,06; net **-808,92**;
  PF 0,658; pior evento -219,54;
- V4 completo: net **-351,64**; PF 0,550; pior evento -78,18;
- sem MULT: net **-575,26**;
- viradas 1–3 somam resultados brutos positivos; viradas 4–6 somam
  **-2.202,78**;
- 31 STOPs tiveram gross +83,98, mas pagaram 353,94 em taxas: todos os 31
  ficaram negativos após taxa;
- 220 eventos equalizados somaram +474,08; 13 expiries residuais somaram
  -1.013,04.

**Falha:** MULT/rearme, STOP e equalização tardia convertem vitórias pequenas
em taxas e inventário de cauda.

**Soluções testadas:** remover MULT, limitar viradas, mudar `descVirada`,
reduzir latência e testar ablações.

**Nova falha:** a melhor ablação do dia ainda fez -169,65, PF 0,919. Com
latência de 0,5 s caiu para -471,94 e com 1 s para -585,34. No relatório
honesto de maio–junho, o baseline já estava em -134.492, PF 0,433, em 16.934
eventos; MULT flat ainda perdeu -72.586, PF 0,513.

Além do resultado econômico, o runner permite superfícies otimistas que não
podem provar execução: STOP no top bid sem caminhada de depth/partial,
equalização cheia a 5¢, resting fill por crossing, FOK validado por VWAP em vez
do pior nível e `equalizaIgnoraTeto=true`.

### 4. Arbitragem de complete-set instantânea

No dia 29:

| Medida | Resultado |
|---|---:|
| `ask_UP + ask_DOWN`, p50 | 1,010 |
| custo fee-aware, p50 | 1,0352 |
| menor custo fee-aware observado | 1,0011 |
| snapshots com tamanho lucrativo caminhando depth 25 | 0/157.869 |
| shares lucrativas | 0 |

**Falha:** não existe complete-set taker instantâneo com margem positiva na
amostra. A Pair-Path só pode ganhar se a seleção temporal tiver edge suficiente
para pagar spread, taxa e risco residual.

### 5. Calibração temporal

Em 99 partições, 25.269 eventos e 227.396 snapshots:

| Tau | EV/share após taxa | IC95 por dia |
|---:|---:|---:|
| 240 s | -0,0145 | [-0,0204; -0,0093] |
| 120 s | -0,0067 | [-0,0116; -0,0022] |
| 60 s | -0,0053 | [-0,0093; -0,0014] |
| 30 s | -0,0022 | [-0,0056; +0,0010] |
| 20 s | +0,0007 | [-0,0028; +0,0042] |
| 10 s | -0,0043 | [-0,0099; +0,0002] |

O sinal positivo em 20 s não é distinguível de zero. No dia 29 sozinho várias
janelas parecem positivas; o histórico mostra que essa superfície é instável.

### 6. Azarão profundo

Foram testadas 108 variantes com treino 2026-04-23..06-30 e teste em julho.
Nenhuma ficou positiva nas duas divisões. Um dos melhores pontos, `px020-t90`,
teve:

- treino: -0,0029/evento, IC95 [-0,0044; -0,0012];
- teste: -0,0028/evento, IC95 [-0,0045; -0,0010].

O risco nominal pequeno do ticket de 2¢ não cria edge; apenas limita a perda
unitária.

### 7. Maker tardio — tela preliminar por book

O grid final do dia 29 produziu 15 relatórios positivos entre 1.290. O melhor
foi `late-x88-t120_10-nk05-nocut|mf0`, +1,131, PF 1,122, mas com resíduo em
84,47% dos eventos e sem intervalo de confiança, pois era um único dia.

Finalistas selecionados foram então reexecutados em 7.231 eventos de julho
anteriores ao dia 29:

| Política | Taxa maker | PnL | PF | IC95 EV/evento |
|---|---:|---:|---:|---:|
| `late-h75-t30_5-nk05-nocut` | 0 | -11,497 | 0,585 | [-0,0027; -0,0004] |
| mesma | 0,07 | -13,400 | 0,547 | [-0,0030; -0,0007] |
| `late-x88-t120_10-nk05-nocut` | 0 | -80,695 | 0,668 | [-0,0147; -0,0076] |
| mesma | 0,07 | -97,585 | 0,623 | [-0,0173; -0,0097] |

Nas 99 partições, os 26 relatórios representativos também foram todos
negativos. O melhor fez -212,965, PF 0,746; seu IC95 de EV/evento foi
[-0,0110; -0,0055].

Essa primeira tela usava tamanho e labels anteriores. Na reexecução com o
mínimo de 5 shares e os 26.855 labels resolvidos, `h75-t30` chegou a +21,955,
PF 1,049 nas 99 partições, mas o IC95 de EV por evento cruzou zero
`[-0,0040; +0,0068]`. `h75-t60` ficou em +0,900, PF 1,002, também sem
significância. Em julho anterior ao dia 29, ambos ficaram negativos.

Mesmo a reexecução continua otimista como prova operacional: o parquet tem
snapshots de book, não o trade tape nem nossa posição na fila. Queda do bid pode
ser consumo ou cancelamento.

### 8. Prova maker com trade tape público

O simulador ganhou um modo conservador: uma compra maker só é considerada
preenchida quando, em segundo posterior ao posting, aparece trade taker
estritamente abaixo do nosso bid. Touch no mesmo preço, trade no mesmo segundo
e mero desaparecimento do BBO não contam.

Fontes oficiais do modelo: [Data API trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets),
[fees](https://docs.polymarket.com/trading/fees) e
[maker rebates](https://docs.polymarket.com/market-makers/maker-rebates).

Foram lidas 491.730 linhas públicas em 226 mercados candidatos do dia 29 e
399.381 linhas em 184 mercados candidatos de 22–28 de julho; nenhum mercado
atingiu o limite de paginação usado.

| Política | Janela | PnL book | Fills book | PnL trade-through | Fills provados | PF provado |
|---|---|---:|---:|---:|---:|---:|
| `x88-t120` | 29 | +10,855 | 224 | -0,940 | 201 | 0,979 |
| `h75-t30` | 29 | +7,250 | 12 | +2,850 | 9 | 2,500 |
| `h75-t60` | 29 | +7,150 | 13 | +2,750 | 10 | 2,375 |
| `h75-t30` | 22–28 | -24,150 | 152 | -13,600 | 104 | 0,414 |
| `h75-t60` | 22–28 | -26,150 | 184 | -15,500 | 135 | 0,481 |

O bootstrap diário p05 da semana foi -23,350 para `h75-t30` e -29,300 para
`h75-t60`. A pequena pista positiva do dia 29 foi então submetida a uma grade
final de 960 variantes:

- `entryTau`: 15, 20, 30, 45 e 60 s;
- zona do favorito: quatro limites inferiores × três superiores;
- preço máximo do azarão: 2¢, 3¢, 4¢ e 5¢;
- backoff maker: 0, 1, 2 e 3 ticks;
- size 5, taxa maker zero e rebate excluído do gate.

Resultado: **0 variantes positivas nas duas janelas e 0 sobreviventes**.
Portanto a família maker H75 fica refutada sob trade-through público. Isso
ainda não estima posição exata na fila — o endpoint público tem timestamps de
um segundo e não expõe cancelamentos/order ID —, mas já é suficiente para
rejeitar, não para aprovar, a pista.

### 9. Evidência real Pair/Clip preservada

Quatro complete-sets reais continuam confirmados nos registros CLOB
documentados:

| Data/hora UTC | Caminho | Pares | PnL modelado líquido |
|---|---|---:|---:|
| 2026-07-28 07:46 | 5 + 5 | 5 | +0,74 |
| 2026-07-28 16:11 | 10 + 10 | 10 | +0,16 |
| 2026-07-28 17:16 | 25 + 25 | 25 | +0,14 |
| 2026-07-29 01:46 | 10 + 5 + 5 | 10 | +0,32 |

Total: 50 pares, investimento 46,95, gross 3,05 e líquido modelado 1,36, sem
residual. Isso prova que o mecanismo pode ocorrer e que esses fills foram
lucrativos; não prova a expectativa de uma automação ampla.

O denominador histórico não pode ser reconstruído dos artefatos atuais:
arquivos `<slug>.json` eram sobrescritos, alguns skips aconteciam antes da
gravação e o resumo omitia no-fill. Também faltam dump bruto imutável,
split/merge/redeem e payout contábil. O caminho correto é um ledger operacional
append-only que registre decisão, skip, ordem, cancelamento, fill e settlement
para toda oportunidade, inclusive as não executadas.

### 10. Recuperação máxima do denominador histórico

Foi implementado um recuperador determinístico sobre todos os artefatos locais,
sem rede ou credenciais. Dataset:
`pair_clip_denominator_62ccf01c561afda7`.

| Evidência recuperada | Quantidade |
|---|---:|
| Slugs exatos | 10 |
| Grupos de sessão sem slug, fora do total exato | 5 |
| Complete-sets oficiais preservados | 4 |
| Slugs com conflito material | 1 |

O conflito em `btc-updown-5m-1785258900` contém simultaneamente alegações de
fill/no-fill, ordem/no-order e skip/complete-set. Ele permanece em quarentena,
sem escolher arbitrariamente uma versão. Em `...9500`, o winner do harness
diverge do label Gamma resolvido, mas o complete-set equalizado continua
invariante ao vencedor.

Conclusão: o denominador exato passado continua irrecuperável, porém agora sua
fronteira está formalizada e reproduzível. Poll loops não são contados como
oportunidades e os cinco grupos sem slug não são somados aos dez eventos exatos.

### 11. TSC e proteção Clip-Path

Uma nova pista apareceu no workspace: comprar o favorito terminal quando spot
e book concordam. A auditoria encontrou primeiro um erro de alegação:
`latencyTicks=0` executava no mesmo snapshot, embora o documento dissesse
“nunca no mesmo tick”. Essa configuração ficou marcada apenas como diagnóstico
otimista; a reprodução usou latência mínima de um snapshot.

O novo runner também impôs size 5, caminhada de cinco níveis de depth, FAK
partial/miss e taxas. Abril–junho foi discovery; julho é validação temporal,
**não holdout limpo**, porque já tinha sido examinada:

| Entrada TSC | Abr–jun PnL/PF | Jul 1–28 PnL/PF | bootstrap p05 jul | Dia 29 |
|---|---:|---:|---:|---:|
| z≥2, ask 0,70–0,925 | +463,832 / 1,557 | +12,927 / 1,038 | -42,894 | -0,916 |
| z≥2, ask 0,80–0,925 | +283,706 / 1,416 | -3,040 / 0,989 | -44,091 | -0,680 |
| z≥1, ask 0,80–0,925 | +303,456 / 1,247 | +52,500 / 1,114 | -16,203 | +7,434 |

Todas deixam 100% das entradas direcionais e pior perda potencial de
aproximadamente -4,67 por evento de 5 shares.

Foram testadas 183 proteções TSC → Clip: gatilho contínuo, z, cruzamento de spot
e flip do book; piso de complete-set entre 0 e -8¢; latência de hedge 1–2
snapshots.

- 99 foram nominalmente positivas em discovery e julho;
- **0 passaram o gate de risco**;
- a proteção reativa deixou 91–100% de residual;
- a proteção contínua deixou aproximadamente 21–34% de residual, mas tornou
  julho negativo;
- um único FAK miss preservou a cauda inteira de -4,67.

No dia 29, `z≥2/a80 + always/floor -1¢/lat1` protegeu 13/14 entradas e realizou
+3,108, pior resultado realizado -0,004. A 14ª proteção foi FAK no-fill; embora
o evento tenha terminado favoravelmente, sua perda potencial continuou perto
de -4,20. Isso mostra por que taxa de proteção de 92,9% não é teto duro.

#### Venda/flatten e escolha híbrida

Também foram confrontadas 1.011 políticas sobre 25.490 eventos elegíveis:
vender a posição original, comprar o lado oposto ou escolher conservadoramente
entre as duas ações. O sweep combinou três entradas TSC, oito gatilhos, sete
pisos por share, latência de um ou dois snapshots e até uma nova tentativa após
FAK zero-fill. O sinal e a execução de proteção ocorreram sempre depois da
entrada e em snapshots distintos.

| Funil flatten/Pair/híbrido | Quantidade |
|---|---:|
| Positivas em PnL e PF em discovery e validação | 422 |
| Bootstrap p05 positivo nas duas janelas | 5 |
| Worst-case de discovery ≥ -0,50 | 0 |
| Zero violações de risco em discovery | 0 |
| Residual de discovery ≤ 5% | 0 |
| Sobreviventes integrais | **0** |

A melhor política híbrida por economia
(`a70/hybrid/z<0/floor -10¢/lat1`) fez +474,450, PF 1,583 e bootstrap p05
+256,186 em discovery, mas deixou 98,97% de residual, 1.620 violações e
worst-case -4,673. Em julho, o bootstrap p05 voltou a ser negativo e, no dia
29, ela perdeu -0,916.

A política híbrida com menos violações
(`a80/hybrid/always/floor -10¢/lat1`) protegeu 1.272/1.453 entradas e reduziu o
residual a 12,87%, mas perdeu -152,762 em discovery e -109,394 em julho. Ainda
restaram 186 violações; o pior caso de todo o sweep só melhorou para -4,626.
Nas políticas bootstrap-positivas, o residual permaneceu entre 89% e 98%.

Portanto, SELL não abre uma fronteira ausente no BUY-oposto: proteção seletiva
preserva o lucro e a cauda; proteção contínua reduz a cauda, mas destrói o valor
esperado e ainda sofre partial abaixo do mínimo, FAK miss e fim de evento. O
híbrido escolheu quase sempre flatten no trecho de menor risco.

### 12. Captura prospectiva e ledger operacional

O lab agora possui dois journals separados:

1. tape público bruto/normalizado para `market.discovery`, snapshots, alterações
   de nível, best bid/ask e trades;
2. ledger operacional Pair/Clip com `event_seen`, `decision`, `order`, `fill`,
   `cancel`, `inventory` e `resolution`.

O ledger usa JSONL append-only com `fsync`, lock, batch atômico, idempotência,
hashes de policy/build, cadeia `prev_hash/record_hash`, bloqueio de campos de
segredo e projeção materializada verificável. Ele rejeita overfill, ordem sem
decisão acionável e resolução FINAL contraditória.

O coletor público possui allowlist somente para Gamma market discovery, CLOB
`/book` e Market WebSocket. Não contém rota de ordem, carteira ou credencial.
Os shadows antigos estavam incompatíveis com o protocolo atual
(`price_changes[]`, assinatura `type: market`, `last_trade_price`) e não
preservavam stream reexecutável.

O primeiro canário revelou uma falha de fechamento: o summary tinha 518
registros, mas um callback `close` tardio gravou a linha 519 depois de
`run.stop`. O callback pós-stop foi bloqueado e ganhou teste de regressão.

Canário corrigido:

| Medida | Resultado |
|---|---:|
| Mercados | 1 |
| Registros JSONL/summary | 254 / 254 |
| Snapshots book | 12 |
| Alterações de nível | 224 |
| Best bid/ask | 8 |
| Trades públicos | 4 |
| Malformados/assets desconhecidos/erros de sink | 0 / 0 / 0 |
| Último registro | `run.stop` |

O canário foi importado no ledger sob policy congelada
`HOLD_PARITY_GAP`: 1 evento visto, 1 decisão SKIP, 0 ordens e 0 fills. Essa é a
primeira observação prospectiva cujo denominador não depende do sumarizador que
descartava no-fills.

## Bloqueios de execução encontrados

- tamanho mínimo observado de 5 shares invalida clips 4/3/3, 2,5/2,5 e
  retries residuais abaixo de 5;
- `latencyTicks=0` no runner anterior equivale a pelo menos um snapshot;
  um tick variou de 106 a 1.502 ms, mediana 500 ms;
- depth pode ser reutilizado entre snapshots idênticos, criando
  sobreconsumo/phantom fills;
- em 213 linhas o depth aparece melhor que o BBO; L1 ausente ou incoerente
  também ocorre;
- FAK pode preencher parcialmente; FOK é all-or-none e precisa respeitar o
  pior preço, não apenas VWAP;
- os últimos snapshots terminam 342–411 ms antes da resolução;
- os labels Gamma cobrem o lake inteiro, mas ainda não equivalem a finalidade
  CLOB/on-chain completa;
- trade-through público melhora a prova maker, mas timestamp de um segundo e
  ausência de cancelamentos/order IDs impedem reconstrução exata da fila;
- o denominador dos quatro caminhos reais não existe nos artefatos preservados.
- a TSC não possui holdout limpo e a proteção Clip ainda deixa miss de cauda;
- um tape público prospectivo mede mercado, mas não substitui ack/fill
  autenticado das nossas próprias ordens.

## Alterações de laboratório desta campanha

`ptb-protect-ab.mjs` agora oferece:

- runner importável por janela;
- parâmetros de threshold em vez de constantes enterradas;
- detalhes de fills;
- proteção emergencial `shot-protect`;
- `depthFraction`, taxa, payout e buffer por variante;
- mínimo de 5 shares aplicado em abertura, clip e hedge;
- override de winner canônico.

`ptb-protect-ab.test.mjs` cobre:

- tight 10 → 5/5 válido;
- deep3 10 → 4/3/3 rejeitado;
- hedge emergencial completo;
- override canônico sobre proxy terminal errado.

## Verificações

```text
node --test labs/sandbox/pair-path-v0/*.test.mjs
44/44 PASS

node --test tests/publicTapeCollector.test.js
8/8 PASS

node --test tests/shotandgoParity.test.js
11/11 PASS

git diff --check
PASS (somente avisos LF/CRLF do Windows)
```

## Artefatos reproduzíveis

| Objetivo | Script | Saída |
|---|---|---|
| Campanha PTB/Clip/Shot-protect | `labs/sandbox/pair-path-v0/ptb-path-exhaustive-campaign.mjs` | `.tmp/ptb-path-exhaustive-campaign/` |
| Estrutura do dia 29 | `labs/sandbox/pair-path-v0/day29-structure-probe.mjs` | `.tmp/day29-structure-probe/` |
| Calibração | `labs/sandbox/pair-path-v0/calibration-probe.mjs` | `.tmp/calibration-probe-all/` |
| Azarão profundo | `labs/sandbox/pair-path-v0/deep-dog-probe.mjs` | `.tmp/deep-dog-probe/` |
| Maker | `labs/sandbox/pair-path-v0/mm-engine.mjs`, `mm-grid.mjs` | `.tmp/mm-grid-*/` |
| Outcomes append-only | `labs/sandbox/pair-path-v0/sync-canonical-outcomes.mjs` | `scratch/canonical-outcomes-v1.*`, `.tmp/canonical-outcomes-v1/` |
| Prova maker no tape | `labs/sandbox/pair-path-v0/mm-trade-tape-validate.mjs` | `.tmp/mm-trade-tape-*/` |
| Grade maker trade-through | `labs/sandbox/pair-path-v0/mm-tape-grid.mjs` | `.tmp/mm-tape-grid-v1/` |
| Proteção TSC → Clip | `labs/sandbox/pair-path-v0/tsc-clip-protection.mjs` | `.tmp/tsc-clip-protection-full-later-depth/` |
| TSC SELL/Pair/híbrido | `labs/sandbox/pair-path-v0/tsc-flatten-{protection,analysis}.mjs` | `.tmp/tsc-flatten-protection/` |
| Recuperação do denominador | `labs/sandbox/pair-path-v0/recover-historical-denominator.mjs` | `.tmp/pair-path-v0-denominator-recovery/` |
| Tape público prospectivo | `labs/sandbox/pair-path-v0/public-tape-{core,collector}.mjs` | `.tmp/public-market-tape/` |
| Ledger append-only | `labs/sandbox/pair-path-v0/operational-ledger.mjs` | `.tmp/pair-clip-operational-shadow-v1/` |
| Import tape → denominador | `labs/sandbox/pair-path-v0/public-tape-to-operational-ledger.mjs` | `.tmp/pair-clip-operational-shadow-v1/` |
| Relatório completo da campanha | este arquivo | `docs/labs/` |

Comando principal:

```powershell
node labs/sandbox/pair-path-v0/ptb-path-exhaustive-campaign.mjs `
  --discoveryFrom=2026-07-29 --discoveryTo=2026-07-29 `
  --validationFrom=2026-04-23 --validationTo=2026-07-28
```

## Próximo ciclo cientificamente defensável

Não há justificativa para outra otimização de clips sobre a mesma superfície e
os mesmos fills. As próximas brechas legítimas são de informação e
microestrutura:

1. continuar o denominator prospectivo já iniciado, cobrindo janelas completas
   e registrando todo evento visto, decisão, skip e oportunidade perdida;
2. promover os labels mais críticos de Gamma para evidência CLOB/on-chain e
   preservar hashes das respostas;
3. acumular com o coletor já validado websocket prospectivo de book/trades em
   milissegundos, estimando a incerteza de fila em blocos ainda não examinados;
4. reconstruir accounting split/merge/redeem e payout dos fills conhecidos;
5. pré-registrar uma política antes de olhar um novo bloco temporal;
6. somente se PF, PnL, bootstrap e cauda passarem, rodar shadow read-only sem
   ordens; qualquer ordem posterior exige plano fresco e aprovação explícita.

O recuperador histórico já delimitou 10 slugs exatos, cinco grupos sem slug e
um conflito material; ele não inventou o filtro de seleção ausente. O primeiro
canário prospectivo também já provou a cadeia tape → ledger com 1 visto/1 SKIP,
mas é apenas prova mecânica curta, não uma janela de estimação econômica.

Até esses dados existirem, o resultado correto é **HOLD / PARITY GAP**:
continua sendo pesquisa, não candidata a deploy ou execução.
