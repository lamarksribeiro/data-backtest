# Chronos Kinetic V1 (`chronos-kinetic-v1`)

## Resumo da Estratégia
A **Chronos Kinetic V1** é uma estratégia de microestrutura desenvolvida do zero para operar contratos preditivos de 5 minutos do Bitcoin na Polymarket.

---

## Pilares Teóricos

1. **Impulso Cinético ($v_t \cdot a_t$):**
   Calcula a velocidade do spot $v_t = P_t - P_{t-5s}$ e a aceleração $a_t = v_t - v_{t-5s}$. Exige que o preço do ativo subjacente esteja acelerando na direção do favorito.
2. **Order Book Imbalance ($OBI_5$):**
   Mede a dominância da pressão de compra no topo do livro de ordens ($OBI \ge 0.30$).
3. **Discrepância Entrópica de Odds ($EFOD$):**
   Calcula a probabilidade teórica implícita $\Phi(z)$ via aproximação logística do desvio-padrão percebido e compara com o preço $Ask$ negociado no mercado. Exige um *edge* líquido positivo ($\Phi(z) - Ask \ge 0.05$).
4. **Controle de Risco Rigoroso:**
   Alocação base de US$ 5.00 por ordem para travar o **Max Drawdown estritamente $< \$70.00$**.
