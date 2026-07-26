# Escada Adaptativa Híbrida V1

Status: `research`. Não é estratégia aprovada para operação real.

## Hipótese

A estratégia preserva a ideia útil da Escada Dupla — construir inventário nos
dois resultados — mas remove níveis fixos e multiplicadores. Cada degrau precisa
ser justificado por valor justo, microestrutura e risco terminal.

O valor justo combina distância do BTC ao `price_to_beat`, tempo restante,
momentum de 7 e 26 segundos, aceleração, volatilidade, desequilíbrio do livro e
probabilidade implícita do mercado. O default usa 66% do modelo e 34% do mercado.

## Invariável de risco

Para um inventário buy-only:

```text
pnlSeUp   = sharesUp   - custoTotal - taxasTakerEstimadas
pnlSeDown = sharesDown - custoTotal - taxasTakerEstimadas
worstPnl  = min(pnlSeUp, pnlSeDown)
```

Com banca de US$ 1.000, nenhuma ordem pode deixar `worstPnl < -US$ 2,50`.
Também há teto de US$ 25 de exposição bruta por evento.

## Ciclo da escada

1. Entre 240 e 60 segundos, uma ordem post-only de 5 shares é colocada no lado
   subavaliado quando `pFair - preço >= minEdge`.
2. Fill maker exige atravessamento de um tick no cenário-base.
3. Com inventário desigual, novas entradas direcionais ficam bloqueadas.
4. A estratégia tenta completar a perna oposta:
   - taker FOK somente se, após book walk, latência e taxa, o par ficar com pelo
     menos US$ 0,02 de lucro protegido;
   - caso contrário, posta hedge maker no maior preço que, se preenchido,
     também deixe pelo menos US$ 0,02 de lucro protegido.
5. Somente depois da proteção um novo degrau direcional pode ser liberado.
6. O máximo é de três ciclos; todo inventário é carregado até o settlement.

O cenário adverso preenche entradas maker no toque, exige cross para o hedge e
usa duas unidades de latência para cancelamentos e taker.

## Telemetria

Cada evento registra:

- valor justo e edge no envio/fill;
- risco antes e depois de cada fill;
- markout de 1, 3 e 5 segundos;
- ordens canceladas e motivo;
- misses taker, fills maker/taker e custo do par;
- maior pior perda observada no caminho.

Maker rebate não entra no PnL.

## Protocolo de validação

O período de abril a julho de 2026 já foi inspecionado e não é holdout puro.
O script abaixo executa dez folds temporais: 21 dias de treino, seguidos por
7 dias de validação base e adversa.

```powershell
node scripts/run-escada-adaptativa-walk-forward.js
```

A seleção dentro de cada treino usa, nesta ordem:

1. maior mediana diária de PnL;
2. maior PnL por unidade de risco;
3. menor drawdown.

O grid é fechado a `modelWeight`, `minEdge`, `minDirectionalProbability`,
`maxSpread` e latência taker. Depois do smoke de frequência, os intervalos
foram estreitados para probabilidade 0,80–0,83 e edge 0,12–0,18; os valores
iniciais mais permissivos produziram entradas demais. O script rejeita qualquer
variante que viole US$ 2,50.

O histórico só pode passar se:

- 100% dos folds respeitarem o risco;
- pelo menos 70% dos folds-base forem positivos;
- a frequência de cada fold-base ficar entre 5 e 15 eventos/dia;
- pelo menos 50% dos folds adversos forem positivos.
- profit factor agregado base for pelo menos 1,20;
- profit factor agregado adverso for pelo menos 1,00;
- drawdown máximo por fold ficar abaixo de US$ 50.

Os critérios completos de PF, drawdown, concentração por dia/horário e
bootstrap em blocos ainda precisam ser avaliados no relatório antes de
classificar um candidato.

## Holdout futuro

O período pré-registrado é 2026-07-26 a 2026-08-24. O arquivo
`experiments/future-shadow-30d.json` não deve ser executado parcialmente nem
usado para ajuste. O gate futuro exige:

- 30 dias completos e pelo menos 150 eventos com fill;
- PnL líquido positivo;
- profit factor mínimo de 1,10;
- nenhuma violação de risco;
- cenário adverso sem expectativa materialmente negativa.

Mesmo um resultado aprovado é apenas evidência de shadow. Operação real exige
plano separado, aprovação explícita, reconciliação de fills e kill switch.

## Evidência inicial — reprovada

O smoke de 1–2 de maio confirmou que o runner lê o lake e respeita o risco, mas
reprovou a hipótese econômica inicial:

- defaults permissivos: 316 eventos em dois dias, PnL líquido de
  `-US$ 184,92530` e PF `0,13853`;
- cenário adverso: 363 eventos, PnL `-US$ 192,43658` e PF `0,15034`;
- calibração `p83-e15`: 7 eventos em um dia, portanto dentro da frequência
  desejada, mas PnL `-US$ 2,20` e PF `0,12`;
- na `p83-e15`, seis pares protegidos ganharam cerca de US$ 0,05 cada e um
  residual perdeu US$ 2,50, apagando todos os ganhos.

Assim, frequência e limite de risco foram demonstrados, mas lucratividade não.
A estratégia permanece `research` e não há preset champion.
