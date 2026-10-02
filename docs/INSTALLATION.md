# Install AgentX

Start with the demo: local chat, document retrieval and a model workbench. No
cloud inference account, personal data import or private harness is required.
Downloads of source, images and models require internet access; inference uses
the Ollama endpoint you select.

## Before you start

Install [Git](https://git-scm.com/downloads) and
[Docker Engine with Compose](https://docs.docker.com/engine/install/) on Linux,
or [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
on Windows. Start Docker and use Compose v2 or newer with `up --wait` support.
Linux also needs Bash and curl. Windows uses the included PowerShell launcher.
Node.js 24 or newer is only required for development commands outside Docker.

Allow disk space for the Docker images, databases and downloaded models. Model
memory and speed depend on model size, context and your hardware; start with a
small model. The basic Docker path needs no GPU. See the model's licence before
using or redistributing its weights.

```bash
git clone https://github.com/WindriderQc/AgentX.git
cd AgentX
```

## First chat with Docker Ollama

This path keeps Ollama inside AgentX's Docker network. It publishes no Ollama
port and uses a named volume for models. On Linux:

```bash
./agentx doctor
./agentx ollama-up --build
./agentx ollama-pull llama3.2:1b
./agentx ollama-status
./agentx health
```

On Windows, from the repository in PowerShell:

```powershell
.\agentx.ps1 doctor
.\agentx.ps1 ollama-up --build
.\agentx.ps1 ollama-pull llama3.2:1b
.\agentx.ps1 ollama-status
.\agentx.ps1 health
```

The first start builds images and waits for service health. The model pull is
explicit; startup never downloads model weights. `llama3.2:1b` is a small example
from the [Ollama library](https://ollama.com/library/llama3.2); choose another
installed chat model if you prefer.

Open http://127.0.0.1:3180/. In the Playground select the installed model and
send “Give me three ideas for a rainy afternoon.” A generated reply verifies
chat inference; container health alone does not. Refresh model discovery if
the model does not appear after the download.

Keep using `ollama-up --build` for this path when restarting or updating the
complete stack: ordinary `up` uses the base definition and points to your
configured native endpoint instead. `ollama-pull` targets Docker Ollama only.
`./agentx down` stops the stack and preserves databases and downloaded models.
`reset` deletes this project's data and recovery archives after confirmation.

## GPU acceleration

The checked-in Docker Ollama definition does not request GPU access. For an
NVIDIA GPU, install the host driver and
[NVIDIA Container Toolkit](https://docs.ollama.com/docker), then create a
Compose override **outside the checkout**:

```yaml
services:
  ollama:
    gpus: all
```

Select it in the launching shell, then start the Ollama stack:

```bash
export AGENTX_COMPOSE_OVERRIDE=/path/outside/git/ollama-gpu.yml
./agentx ollama-up --build
```

PowerShell: `$env:AGENTX_COMPOSE_OVERRIDE = 'C:\AgentX-instance\ollama-gpu.yml'`,
then `.\agentx.ps1 ollama-up --build`. Keep this variable set for later launcher
commands. The [`gpus` key](https://docs.docker.com/reference/compose-file/services/#gpus)
requires Compose 2.30 or newer. Driver/toolkit changes
and Docker restarts affect the host; perform them when existing workloads are
idle. Check Ollama's runtime placement after a real request:

```bash
docker compose --env-file config/agentx.env -f docker-compose.yml -f docker-compose.ollama.yml exec ollama ollama ps
```

For custom project/env/override inputs, pass the same inputs to this diagnostic.
Use the [official Ollama GPU instructions](https://docs.ollama.com/docker) for
AMD/device configuration. On macOS, native Ollama is the path for Metal
acceleration; this repository's launchers document Linux and Windows workflows.

## Use a native or LAN Ollama server

Install Ollama using its [Linux guide](https://docs.ollama.com/linux) or
[Windows download](https://ollama.com/download/windows). Start its service and
verify it on the Ollama host:

```bash
ollama pull llama3.2:1b
ollama list
curl http://127.0.0.1:11434/api/version
```

Native Ollama defaults to loopback. AgentX runs in containers, so a successful
host-side probe does not prove the containers can reach it. On Linux, bind
Ollama to the host's Docker bridge or trusted LAN interface, with a firewall
allowing only the intended clients. Configure `OLLAMA_HOST` in the Ollama
service's environment using its
[configuration guide](https://docs.ollama.com/faq#how-do-i-configure-ollama-server).
For systemd, use `sudo systemctl edit ollama`, for example:

```ini
[Service]
Environment="OLLAMA_HOST=<reachable-host-interface-address>:11434"
```

Replace the placeholder, then reload systemd and restart Ollama when idle.
On Windows, configure `OLLAMA_HOST` in the user environment and restart Ollama.
Binding to all interfaces makes the API reachable more widely: limit access
with the host firewall and never forward port 11434 to the internet.

The default AgentX endpoint is `http://host.docker.internal:11434`, including
Linux's host-gateway mapping. For a different trusted LAN host, set the endpoint
in the launching shell:

```bash
export AGENTX_OLLAMA_HOST=http://ollama-host.example:11434
./agentx up --build
```

```powershell
$env:AGENTX_OLLAMA_HOST = 'http://ollama-host.example:11434'
.\agentx.ps1 up --build
```

Use your reachable host address in place of the example. Native model pulls use
`ollama pull` on that host. `ollama-doctor` checks native Ollama from the launcher
host; inspect model discovery in AgentX to verify container connectivity.

## Search your first document

RAG needs an embedding model as well as a chat model. The generic configuration
uses `nomic-embed-text:v1.5` with 768 dimensions. For Docker Ollama:

```bash
./agentx ollama-pull nomic-embed-text:v1.5
```

For native Ollama, run `ollama pull nomic-embed-text:v1.5` on its host. Open the
RAG interface at http://127.0.0.1:3182/, ingest a small non-sensitive text document
and search for a phrase from it. Verify retrieval before importing a real corpus.
An empty collection is normal on first start. Changing the embedding model or
its dimensions needs a new collection; follow
[the migration procedure](OPERATIONS.md#switching-the-embedding-model).

## Instance configuration and the full profile

Copy `config/agentx.env` to a file outside the repository, add your instance
settings there, and select it before every launcher command:

```bash
export AGENTX_ENV_FILE=/path/outside/git/instance.env
./agentx up --build
```

PowerShell: `$env:AGENTX_ENV_FILE = 'C:\AgentX-instance\instance.env'`.
Shell values override the env file. Do not commit credentials, document stores,
host inventories or runtime volumes.

| Profile | What it includes |
|---|---|
| Default `demo` | Playground, Ollama discovery, RAG and Benchmark |
| `AGENTX_PROFILE=full` | Also Nestor (`/dad`), Household (`/panel`) and operational surfaces |
| Full plus `COMPOSE_PROFILES=data` | Also optional Data and `/data-toolbox` |

Set these values in the external env file. Data binds to loopback 3183 and has
no collector target, storage mount or background job enabled by default. See
[Data configuration](../data/README.md). Voice, private harnesses, photos and
other integrations require their own configuration; enabling `full` does not
install them. Before family access from another device, configure the
[LAN HTTPS parental gateway](PARENTAL_ACCESS.md). Keep raw service ports local.

### Private sound packs

The source distribution includes only recordings with stated redistribution
terms. The catalog also recognises optional animals whose clips are absent from
the public pack; absent files are neither offered nor played.

An instance can retain its complete existing pack, including its own credits,
in an external directory. Mount that directory read-only with an external
Compose override:

```yaml
services:
  core:
    volumes:
      - /path/outside/git/sounds:/app/surfaces/household/public/sounds:ro
```

Select this file with `AGENTX_COMPOSE_OVERRIDE` and recreate Core through the
launcher. The directory replaces the whole bundled sound directory, so retain
both the bundled clips and instance-owned additions in it, with `CREDITS.md`.
Use catalog filenames. Keep private recordings out of Git history and release
archives. This configuration does not establish any right to redistribute them.

## Troubleshooting

| Symptom | Check |
|---|---|
| Docker unavailable | Start Docker; rerun `doctor` and check Compose supports `up --wait`. |
| Startup timeout | Run `status` and `logs core`; inspect Benchmark/RAG logs as needed. The initial build needs internet. |
| Address already in use | Choose unused `CORE_PORT`, `BENCHMARK_PORT`, `RAG_PORT` and optional `DATA_PORT` in the external env file. |
| No models | Pull a chat model on the selected Ollama host; verify discovery. Docker and native Ollama have separate stores. |
| Ollama unreachable | Check its bind address, firewall and container-to-host reachability. `127.0.0.1` inside Core means Core's container. |
| Slow reply | Check CPU/GPU placement and model size. Docker Ollama is CPU-only without an explicit GPU override. |
| RAG ingestion fails | Verify the embedding model is installed and reachable; keep its configured dimension aligned. |
| Deployment refused with exit 4 | Let active inference/Benchmark work finish; follow the runtime lease procedure in Operations. |

## Develop and validate

For source development, install Node.js 24 or newer, then follow the
[README checks](../README.md#develop-and-verify). MongoDB tests use disposable
local databases. [Operations](OPERATIONS.md) explains updates, isolation,
backups and integration configuration. Tests, container startup, inference and
real-device voice acceptance are separate results.
