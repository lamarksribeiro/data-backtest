# Conexão ao servidor Brutus (outra máquina / outra IDE)

Guia para configurar SSH e (opcionalmente) Coolify MCP em um PC ou IDE novo. O Brutus é o host de produção do **Coolify Hulw** (`openclaw`, rede privada `10.40.2.77`), onde rodam `data-colector`, `data-backtest`, `data-index`, `data-robot` e Postgres.

## Pré-requisitos

1. **Rede** — o SSH usa IP privado `10.40.2.77`. É preciso estar na mesma VPN/rede que o ambiente Hulw (o mesmo acesso que já funciona no PC principal).
2. **Chave SSH** — par Ed25519 autorizado no servidor. Copie de forma segura do PC já configurado ou peça para alguém com acesso adicionar sua chave pública em `/root/.ssh/authorized_keys`.
3. **OpenSSH** — cliente `ssh`/`scp` no PATH (Windows: OpenSSH Client nas Features opcionais; macOS/Linux: geralmente já vem instalado).

Não commite chaves privadas nem tokens de API no repositório.

## 1. Chave SSH

### Opção A — copiar chave existente (recomendado se você já tem acesso em outro PC)

No PC que já conecta, os arquivos costumam estar em:

```text
Windows:  %USERPROFILE%\.ssh\brutus_ed25519
          %USERPROFILE%\.ssh\brutus_ed25519.pub
macOS:    ~/.ssh/brutus_ed25519
Linux:    ~/.ssh/brutus_ed25519
```

Copie **os dois** arquivos para o mesmo caminho na máquina nova (pendrive, gerenciador de senhas com anexo, etc.). Permissões:

```bash
# macOS / Linux
chmod 600 ~/.ssh/brutus_ed25519
chmod 644 ~/.ssh/brutus_ed25519.pub
```

No Windows, garanta que só sua conta leia a chave privada (Propriedades → Segurança).

### Opção B — chave nova

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\brutus_ed25519 -C "seu-email@exemplo.com"
```

Envie o conteúdo de `brutus_ed25519.pub` para quem administra o Brutus e peça inclusão em `authorized_keys` do usuário `root`.

## 2. Alias SSH `Brutus`

Adicione ao arquivo de config do OpenSSH:

| SO | Arquivo |
|----|---------|
| Windows | `%USERPROFILE%\.ssh\config` |
| macOS / Linux | `~/.ssh/config` |

Exemplo (também em `labs/ops/brutus/ssh-config.example`):

```sshconfig
Host Brutus
    HostName 10.40.2.77
    User root
    IdentityFile ~/.ssh/brutus_ed25519
    IdentitiesOnly yes
```

No Windows, se `IdentityFile` com `~` falhar, use caminho absoluto:

```sshconfig
    IdentityFile C:\Users\SEU_USUARIO\.ssh\brutus_ed25519
```

### Teste

```powershell
ssh Brutus "hostname ; uptime"
```

Saída esperada: `openclaw` e load average.

Comandos úteis:

```powershell
ssh Brutus "docker ps"
ssh Brutus "df -h"
scp labs/ops/brutus/run-queue.sh Brutus:/tmp/labs-brutus/
```

### PowerShell no Windows

Evite `docker ps --format` com templates Go (`{{.Names}}`) dentro de `ssh Brutus "..."` — o OpenSSH do Windows pode falhar com exit code estranho. Prefira:

```powershell
ssh Brutus "docker ps | grep data-backtest || true"
```

## 3. Outras IDEs e editores

Qualquer IDE com **terminal integrado** usa os mesmos comandos `ssh`/`scp` após o passo 2.

### Cursor

- Terminal: `ssh Brutus` como acima.
- **MCP Coolify** (deploy, logs, env vars sem SSH): em `%USERPROFILE%\.cursor\mcp.json` (global) ou `.cursor/mcp.json` no projeto:

```json
{
  "mcpServers": {
    "coolify-hulw": {
      "command": "npx",
      "args": ["-y", "@masonator/coolify-mcp"],
      "env": {
        "COOLIFY_BASE_URL": "https://coolify.hulw.online",
        "COOLIFY_ACCESS_TOKEN": "<token-do-painel-coolify>"
      }
    }
  }
}
```

Token: painel Coolify → **Settings** → **API tokens** → criar token com escopo adequado. Não versionar o token.

Skills do agente (opcional): copiar `brutus-hulw` e `coolify` de `~/.cursor/skills/` ou recriar a partir deste doc.

### VS Code / VS Code Insiders

1. Extensão **Remote - SSH**: Command Palette → *Remote-SSH: Add New SSH Host* → `ssh Brutus` (usa o alias do `config`).
2. Conectar: *Remote-SSH: Connect to Host* → `Brutus`.
3. MCP (se usar extensão MCP compatível): mesmo bloco JSON do Cursor, no arquivo de MCP da extensão.

### Windsurf / Claude Code / outras

- Terminal: alias `Brutus` no `~/.ssh/config`.
- Se a IDE suportar MCP: mesmo pacote `@masonator/coolify-mcp` com `COOLIFY_BASE_URL` e `COOLIFY_ACCESS_TOKEN`.

### JetBrains (WebStorm, etc.)

Settings → Tools → SSH Configurations → adicionar host `10.40.2.77`, user `root`, chave `brutus_ed25519`. Depois use Deployment ou terminal com o alias.

## 4. Variáveis locais do `data-backtest`

No `.env` do projeto (ver `.env.example`):

```env
LAKE_PULL_REMOTE_HOST=Brutus
LAKE_PULL_REMOTE_LAKE=/data/goldenlens/lakehouse
LAKE_PULL_REMOTE_STATE=/data/goldenlens/backtest-state/data-backtest.db
```

**Baixar Parquet para o PC local:** seguir o guia **[lake-pull-brutus.md](lake-pull-brutus.md)** (não usar `npm run lake:pull` sem `--from`/`--to`; após redeploy, atualizar `--remote-container` ou apagar `state/.lake-pull-remote-container.json`).

Scripts de lab: ver `labs/ops/brutus/README.md`.

## 5. Duas camadas de acesso (resumo)

| Precisa de | Ferramenta |
|------------|------------|
| Deploy, restart, logs de app, env vars no Coolify | MCP `coolify-hulw` ou painel `https://coolify.hulw.online` |
| `docker exec`, `docker ps`, psql no container, arquivos em `/data/goldenlens` | SSH `Brutus` |

## 6. Referência rápida do host

| Item | Valor |
|------|--------|
| Alias SSH | `Brutus` |
| Hostname (dentro do servidor) | `openclaw` |
| IP (rede privada) | `10.40.2.77` |
| Usuário SSH | `root` |
| Coolify | `https://coolify.hulw.online` |
| Lake no host | `/data/goldenlens/lakehouse` |
| State backtest no host | `/data/goldenlens/backtest-state` |

Trate como **produção**. Confirme antes de comandos destrutivos no host ou em containers.

## 7. Problemas comuns

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| `Connection timed out` | Fora da VPN/rede `10.40.x` | Conectar à VPN Hulw |
| `Permission denied (publickey)` | Chave ausente ou não autorizada | Verificar `IdentityFile` e `authorized_keys` no servidor |
| `ssh` pede senha | Chave errada ou `IdentitiesOnly` | Conferir alias e permissões da chave |
| MCP Coolify falha 401 | Token inválido/expirado | Gerar novo token no painel |
| `scp` com scripts `.sh` quebrados no Linux | CRLF do Windows | `ssh Brutus "sed -i 's/\r$//' /tmp/labs-brutus/*.sh"` |
| `lake:pull` trava ou `No such container` | Cache de container após redeploy | Ver [lake-pull-brutus.md](lake-pull-brutus.md) — apagar `state/.lake-pull-remote-container.json` e passar `--remote-container` |
| `ssh` com exit code estranho no PowerShell | Templates `{{.Names}}` no `--format` | Usar `ssh.exe Brutus docker ps` sem `--format` |

## Ver também

- [lake-pull-brutus.md](lake-pull-brutus.md) — baixar Parquet BTC 5m (e outros) do Brutus para o lake local
- `labs/ops/brutus/README.md` — filas e benchmarks no container `data-backtest`
- `docs/operacao/deploy-coolify.md` — deploy e limites de CPU/RAM
- Skill Cursor `brutus-hulw` — fluxos de `docker exec` e data-colector
