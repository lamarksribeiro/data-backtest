# Guia de Performance e Boas Práticas no Laboratório

Este documento serve como referência de otimização de infraestrutura para desenvolvedores e agentes executando experimentos de backtest no `data-backtest`. Ele consolida os aprendizados práticos obtidos na execução de sweeps de alta densidade no ambiente Windows local.

---

## O Gargalo Crítico: Pressão de Heap e Memória Virtual

Ao rodar sweeps com estratégias que utilizam livros de ofertas profundos (ex.: `bookDepth: 25`), o volume de dados por tick na simulação colunar cresce exponencialmente. Cada tick de dados colunares possui até 100 campos numéricos (preços e tamanhos das ordens de compra e venda).

Em uma janela longa (ex.: 40 dias de BTC 5m), temos cerca de **12 milhões de ticks**. 

### 1. O Problema do Modo `single-pass`
No modo contínuo (`single-pass`), o runner tenta carregar toda a massa de 12 milhões de ticks de uma só vez na memória JavaScript em TypedArrays:
- Cada worker thread do Node.js consome facilmente entre **1.2 GB e 1.5 GB de RAM física**.
- Se configurarmos um número alto de threads paralelas (ex.: `variantWorkers: 10`), o processo tentará alocar de forma instantânea **15 GB a 25 GB de RAM**.
- Em sistemas locais (Windows), se a alocação exceder a RAM física disponível, o Windows ativará a **Memória Virtual (Paginação/Thrashing)**.
- **Consequência**: O desempenho cai em até 100x. Os cores de CPU passam a ficar ociosos esperando I/O de disco virtual e o Garbage Collector (GC) entra em loops contínuos de limpeza de heap, travando a simulação.

---

## Boas Práticas de Execução

Para sweeps rápidos e eficientes no ambiente local, siga as diretrizes abaixo de acordo com a escala do experimento:

### A. Escolha do Modo de Sweep

| Escala do Sweep | Recomendação | Configuração no JSON |
| :--- | :--- | :--- |
| **Pequeno** (Janela < 7 dias e < 20 variantes) | **`single-pass`** | `"dailyMetrics": false` |
| **Médio/Longo** (Janela > 7 dias ou > 20 variantes) | **`chunked-1d`** | `"dailyMetrics": true` |

> [!TIP]
> **Por que o Chunked é mais rápido para sweeps grandes?**
> Ao fatiar o processamento em chunks de 1 dia (`dailyMetrics: true`), cada worker thread carrega apenas os ticks correspondentes àquele dia (~300k ticks, consumindo menos de 50MB de RAM por thread). A pegada total de memória fica abaixo de 1.5 GB, eliminando a paginação e permitindo que as threads processem o loop do Javascript a 100% da velocidade máxima da CPU.

### B. Limitação de Workers no Windows (`variantWorkers`)
No Windows, os recursos de CPU e spawn de threads do Node devem ser dimensionados para evitar concorrência desnecessária:
- Nunca defina `variantWorkers` maior do que os cores lógicos da máquina física menos 2.
- Para modo `single-pass` com grandes janelas, limite para no máximo **2 ou 3 workers** para proteger a memória física.
- Para modo `chunked-1d`, você pode usar **4 a 6 workers** com total segurança, pois o consumo de RAM por thread é mínimo.

---

## Otimização do Search Space (Espaço de Busca)

Grids de busca genéricos muito amplos (ex.: testar parâmetros de probabilidade de 0.01 a 0.5) geram combinações ineficientes que consomem bilhões de ciclos de CPU de forma inútil.

1. **Etapa 1 - Filtro Rápido (Discovery)**: Use search spaces enxutos e focados nas variantes candidatas prováveis (máximo de 15 a 30 variantes).
2. **Etapa 2 - Validação**: Evite rodar sweeps gigantes no disco local. Se precisar de sweeps de alta densidade (+1000 variantes), envie a fila do experimento para o servidor remoto **Brutus** usando o script `labs/ops/brutus/` e apenas consuma os resultados consolidados localmente.
