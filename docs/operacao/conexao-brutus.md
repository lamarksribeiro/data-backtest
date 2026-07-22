# Conexão ao servidor Brutus (outra máquina / outra IDE)

Guia para configurar SSH e (opcionalmente) Coolify MCP em um PC ou IDE novo. O Brutus é o host de produção do **Coolify Hulw** (`openclaw`, rede privada `10.40.2.77`), onde rodam `data-colector`, `data-backtest`, `data-index` e Postgres. O **`data-robot`** roda no **Coolify Giovanna** (URL oficial https://robot.fracta.online), não no Brutus/Hulw.

## Acesso recomendado (sem FortiClient)

SSH via **Cloudflare Tunnel + Access** — igual em espírito ao Giovanna (sem VPN), mas **sem porta 22 pública**:

| Peça | Papel |
|------|--------|
| Túnel existente `coolify-data-interno-2026-05-19` no Brutus | Só **saída** para a Cloudflare (já roda com os sites fracta) |
| Hostname | `ssh-brutus.fracta.online` → `ssh://localhost:22` |
| Access app **Brutus SSH** | Só `lamarcksribeiro@gmail.com` (login Cloudflare) |
| Cliente local | `cloudflared` + chave `brutus_ed25519` |

**Não** abre SSH na internet. Quem não passa no Access nem chega no `sshd`.

Modelo de segurança (resumo):

- No Brutus, o `cloudflared` só faz **conexão de saída** para a Cloudflare (já existia para os sites fracta).
- Não há porta SSH nova aberta no firewall/host para a internet.
- O hostname `ssh-brutus.fracta.online` passa pela Cloudflare; sem login Access (e-mail liberado) a sessão é recusada.
- Ainda exige a chave SSH `brutus_ed25519` depois do Access.
- Tailscale foi descartado (SSL inspection Forti no Brutus) e **removido** do PC e do servidor.

### Setup no PC

1. Instalar [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`winget install Cloudflare.cloudflared`).
2. Alias SSH (Windows `%USERPROFILE%\.ssh\config`):

```sshconfig
Host Brutus
  HostName ssh-brutus.fracta.online
  User root
  IdentityFile C:\Users\lamar\.ssh\brutus_ed25519
  IdentitiesOnly yes
  ProxyCommand "C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh --hostname %h
  ServerAliveInterval 30

Host Brutus-LAN
  HostName 10.40.2.77
  User root
  IdentityFile C:\Users\lamar\.ssh\brutus_ed25519
  IdentitiesOnly yes
```

3. Primeira conexão: `ssh Brutus` abre o browser do **Cloudflare Access** (e-mail liberado). JWT fica em cache (~24h). Depois: sem Forti, sem browser a cada comando (até expirar a sessão).
4. Teste: `ssh Brutus hostname` → `openclaw`.

Fallback com VPN Forti EBSERH: `ssh Brutus-LAN` (rede `10.40.2.77`).

Opcional (agente 100% sem browser): Zero Trust → Access → Service Auth → criar service token e política na app **Brutus SSH**; usar `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` com o `cloudflared access ssh`.

## Pré-requisitos (chave SSH)

1. **Chave SSH** — par Ed25519 autorizado no servidor (`brutus_ed25519`).
2. **OpenSSH** — cliente `ssh`/`scp` no PATH.
3. **cloudflared** — para o caminho sem VPN (acima).

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

Use o bloco da seção **Acesso recomendado** no topo deste doc (`Brutus` via Cloudflare + `Brutus-LAN` via VPN).

Exemplo mínimo Cloudflare (Windows):

```sshconfig
Host Brutus
    HostName ssh-brutus.fracta.online
    User root
    IdentityFile C:\Users\lamar\.ssh\brutus_ed25519
    IdentitiesOnly yes
    ProxyCommand "C:\Program Files (x86)\cloudflared\cloudflared.exe" access ssh --hostname %h
```

Arquivo: Windows `%USERPROFILE%\.ssh\config` · macOS/Linux `~/.ssh/config`.

### Teste

```powershell
ssh Brutus "hostname ; uptime"
```

Saída esperada: `openclaw` e load average. Na **primeira** vez, complete o login Cloudflare Access no browser.

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

Comandos remotos longos com `$`, `<`, `>`: preferir script via `scp` + `bash /tmp/script.sh` (PowerShell interpreta metacaracteres).
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

**Atualizar BTC 5m local:** `npm run lake:update-btc-5m` — ver **[atualizar-btc-5m-local.md](atualizar-btc-5m-local.md)**. Pull genérico / outros assets: **[lake-pull-brutus.md](lake-pull-brutus.md)**.

Scripts de lab: ver `labs/ops/brutus/README.md`.

## 5. Duas camadas de acesso (resumo)

| Precisa de | Ferramenta |
|------------|------------|
| Deploy, restart, logs de app, env vars no Coolify | MCP `coolify-hulw` ou painel `https://coolify.hulw.online` |
| `docker exec`, `docker ps`, psql no container, arquivos em `/data/goldenlens` | SSH `Brutus` |

## 6. Referência rápida do host

| Item | Valor |
|------|--------|
| Alias SSH | `Brutus` (Cloudflare) · `Brutus-LAN` (VPN) |
| Hostname público SSH | `ssh-brutus.fracta.online` |
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
| Browser Access / JWT expirado | Sessão Access ~24h | Rodar `ssh Brutus` e completar login de novo |
| `Connection timed out` em `Brutus-LAN` | Fora da VPN Forti | Usar `ssh Brutus` (Cloudflare) ou ligar Forti |
| `Permission denied (publickey)` | Chave ausente ou não autorizada | Verificar `IdentityFile` e `authorized_keys` no servidor |
| `ssh` pede senha | Chave errada ou `IdentitiesOnly` | Conferir alias e permissões da chave |
| MCP Coolify falha 401 | Token inválido/expirado | Gerar novo token no painel |
| `scp` com scripts `.sh` quebrados no Linux | CRLF do Windows | `ssh Brutus "sed -i 's/\r$//' /tmp/labs-brutus/*.sh"` |
| `lake:update-btc-5m` / `lake:pull` trava ou `No such container` | Cache de container após redeploy | `npm run lake:update-btc-5m -- --refresh-container` (ou ver [atualizar-btc-5m-local.md](atualizar-btc-5m-local.md)) |
| `ssh` com exit code estranho no PowerShell | Templates `{{.Names}}` no `--format` | Usar `ssh.exe Brutus docker ps` sem `--format` |

## Ver também

- [lake-pull-brutus.md](lake-pull-brutus.md) — baixar Parquet BTC 5m (e outros) do Brutus para o lake local
- `labs/ops/brutus/README.md` — filas e benchmarks no container `data-backtest`
- `docs/operacao/deploy-coolify.md` — deploy e limites de CPU/RAM
- Skill Cursor `brutus-hulw` — fluxos de `docker exec` e data-colector
