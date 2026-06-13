# Lab CLI

Entrypoints Node invocados pelos scripts `npm run lab:*`.

| Comando npm | Arquivo | Função |
|---|---|---|
| `lab:run` | `run.js` | Executa um experimento config-driven |
| `lab:consolidate` | `consolidate.js` | Mescla rankings de vários relatórios |
| `lab:bench-sweep` | `bench-sweep-mode.js` | Benchmark chunked vs single-pass |

A lógica reutilizável fica em `labs/shared/`. Scripts de operação remota (Brutus, docker) ficam em `labs/ops/`.
