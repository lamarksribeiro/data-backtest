# Shared Lab Infrastructure

Codigo comum dos laboratorios deve ficar aqui.

Escopo esperado:

- `labRunner`: executa experimentos config-driven.
- `paramGrid`: expande search spaces.
- `metrics`: calcula ranking e estabilidade.
- `reportWriter`: grava resultados em `reports/labs/`.
- `strategyLoader`: resolve fonte GLS, defaults e schema.

Evite colocar logica especifica de uma estrategia nesta pasta.
