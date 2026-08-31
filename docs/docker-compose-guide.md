# Docker Compose Installation and Operations Guide

This guide explains how to run and operate `cokacremote` safely with Docker Compose. It applies to Docker Desktop on macOS and Docker Engine on Linux.

> [!WARNING]
> `cokacremote` is a powerful MCP server that can execute commands and modify files. The container runs as the non-root `node` user, but an authenticated client still has unrestricted access to mounted directories and the container network. Do not mount the entire host, the Docker socket, or your personal SSH directory.

## 1. Deployment layout

The default Compose configuration uses the following boundaries.

| Host | Container | Purpose |
|---|---|---|
| `./workspace` | `/workspace` | Default MCP working directory |
| `./.ssh` | `/home/node/.ssh` | Persistent container-only SSH configuration and keys |
| `cokacremote-data` named volume | `/data` | OAuth client and token-hash state |
| `127.0.0.1:3000` | `3000` | MCP HTTP server |
| `127.0.0.1:3010-3020` | `3010-3020` | Development servers started inside the container |

`./.ssh` is not your host user's `~/.ssh`. It is a project-specific directory that should contain only keys and `known_hosts` entries created for this container.

## 2. Prerequisites

- Docker Desktop, or Docker Engine with the Compose plugin
- Git
- OpenSSL for generating authentication secrets

Verify the required tools:

```bash
docker version
docker compose version
git --version
openssl version
```

## 3. Initial setup

From the repository root, create the local environment file and mount directories:

```bash
cp .env.example .env
mkdir -p workspace .ssh
chmod 700 .ssh
```

On Linux, if the container's `node` user, whose default UID/GID is `1000`, cannot write to the bind mounts, adjust their ownership:

```bash
sudo chown -R 1000:1000 workspace .ssh
```

Docker Desktop on macOS normally does not require this ownership change.

### Generate authentication secrets

Run this command twice to create two independent secrets:

```bash
openssl rand -hex 32
```

Enter the generated values in `.env`. For static Bearer authentication only, use:

```dotenv
MCP_AUTH_TOKEN=<generated-64-character-value>
MCP_ALLOW_NO_AUTH=false
MCP_OAUTH_ENABLED=false
```

Authentication secrets must contain at least 32 characters. The server rejects example values beginning with `replace-with-`. The `.env` file is ignored by Git and must not be committed.

### Default network settings

These values are recommended for local-only access:

```dotenv
MCP_HOST=0.0.0.0
MCP_LISTEN_HOST=127.0.0.1
MCP_PORT=3000
MCP_ALLOWED_HOSTS=127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=0
```

`MCP_HOST=0.0.0.0` allows the process to accept connections inside the container. `MCP_LISTEN_HOST=127.0.0.1` restricts the published host port to the local machine.

## 4. Validate and start the service

Validate the Compose file and variable interpolation first:

```bash
docker compose config --quiet
```

Build the image and start the service in the background:

```bash
docker compose up -d --build
```

Inspect its state and logs:

```bash
docker compose ps
docker compose logs --tail=100 cokacremote
```

A healthy service is shown as `healthy` by `docker compose ps`. Immediately after startup it may briefly appear as `starting` because of the health check's `start_period`.

## 5. Verify connectivity

Check the health endpoint:

```bash
curl -fsS http://127.0.0.1:3000/health
```

The default MCP URL is:

```text
http://127.0.0.1:3000/mcp
```

MCP requests require the Bearer secret configured in `.env`. Calling the endpoint without authentication should return `401 Unauthorized`, which confirms that the authentication boundary is active.

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  --data '{}'
```

The response should also include these security headers:

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

## 6. Change the workspace

By default, only `./workspace` is mounted at `/workspace`. To use a different project, set `WORKSPACE_PATH` in `.env` to a dedicated directory.

macOS example:

```dotenv
WORKSPACE_PATH=/Users/myname/Projects/mcp-workspace
```

Linux example:

```dotenv
WORKSPACE_PATH=/srv/cokacremote-workspace
```

Recreate the container after changing the setting:

```bash
docker compose up -d --force-recreate
```

Avoid mounting any of the following:

- `/` or an entire user home directory
- `/var/run/docker.sock`
- The host user's `~/.ssh`
- Operating-system configuration directories
- Secret directories belonging to other applications

## 7. Use container-only SSH credentials

Keys created inside the container persist in the project's `SSH_PATH` directory.

```bash
docker compose exec cokacremote ssh-keygen -t ed25519 -f /home/node/.ssh/id_ed25519
docker compose exec -T cokacremote sh -lc \
  'ssh-keyscan github.com >> /home/node/.ssh/known_hosts && chmod 600 /home/node/.ssh/known_hosts'
```

Print the public key and register it with the required Git hosting service:

```bash
docker compose exec cokacremote cat /home/node/.ssh/id_ed25519.pub
```

The `.ssh` directory is listed in both `.gitignore` and `.dockerignore`. It still requires an appropriate backup policy and restrictive file permissions, and it must never be shared publicly.

## 8. Expose development servers from the container

Compose publishes ports `3010-3020` on the host loopback interface. A development server started by MCP must bind to `0.0.0.0` inside the container so that the published port can reach it.

Example:

```bash
npm run dev -- --host 0.0.0.0 --port 3010
```

Open it on the host at:

```text
http://127.0.0.1:3010
```

If the development server binds only to `127.0.0.1`, it is reachable only from inside the container.

## 9. Configure OAuth behind public HTTPS

Remote MCP clients such as ChatGPT require a public HTTPS URL for OAuth. Put Nginx, a secure tunnel, or a load balancer in front of the service. Do not expose the Node.js port `3000` directly to the internet.

When the proxy runs on the host and there is exactly one trusted proxy hop, use settings similar to:

```dotenv
MCP_LISTEN_HOST=127.0.0.1
MCP_ALLOWED_HOSTS=mcp.example.com,127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=1
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<independent-generated-64-character-value>
MCP_PUBLIC_URL=https://mcp.example.com
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/data/oauth-state.json
```

If the proxy chain has a different number of hops, or a tunnel service forwards addresses differently, adjust `MCP_TRUST_PROXY_HOPS` to match the actual topology. Incorrect proxy trust can allow OAuth rate-limit bypasses.

OAuth state is stored in the `cokacremote-data` named volume. State files created by the server are owned by the container service user and use mode `0600`.

## 10. Stop, restart, and update

Stop and start the existing container:

```bash
docker compose stop
docker compose start
```

Recreate it after configuration changes:

```bash
docker compose up -d --force-recreate
```

Update the source and base image:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

Remove the service and network while retaining the OAuth named volume:

```bash
docker compose down
```

## 11. Back up and reset persistent data

The following data survives container replacement:

- Workspace files under `WORKSPACE_PATH`
- Container-only SSH files under `SSH_PATH`
- OAuth state in the `cokacremote-data` volume

To copy the OAuth state out of a running container, then restrict the backup permissions:

```bash
docker compose cp cokacremote:/data/oauth-state.json ./oauth-state.backup.json
chmod 600 oauth-state.backup.json
```

The backup contains OAuth client information and token hashes. Protect it as authentication data.

Delete the named volume only when you intend to invalidate every OAuth registration and issued token:

```bash
docker compose down --volumes
```

> [!CAUTION]
> This command permanently deletes the `cokacremote-data` volume. `WORKSPACE_PATH` and `SSH_PATH` are bind mounts and are not deleted.

## 12. Troubleshooting

### The service rejects an authentication secret

If the logs report a short secret or an example placeholder, generate a new value, update `.env`, and recreate the container:

```bash
openssl rand -hex 32
docker compose up -d --force-recreate
```

### The container is unhealthy

```bash
docker compose ps
docker compose logs --tail=200 cokacremote
docker compose exec cokacremote curl -i http://localhost:3000/health
```

### The container cannot write to `/workspace` or `.ssh`

On Linux, inspect and correct the bind-mount ownership:

```bash
ls -ld workspace .ssh
sudo chown -R 1000:1000 workspace .ssh
```

### `403 Host header is not allowed`

Add the requested domain or local hostname to `MCP_ALLOWED_HOSTS`, then recreate the container.

### The port is already in use

Change the MCP port used on both the host and container in `.env`:

```dotenv
MCP_PORT=3100
```

Alternatively, move a development server to another port within the `3010-3020` range.

### Configuration changes are not applied

After changing `env_file` or Compose variables, recreate the container instead of only restarting it:

```bash
docker compose up -d --force-recreate
```

## 13. Operations security checklist

- Is `MCP_LISTEN_HOST=127.0.0.1` still set?
- Are independent authentication secrets at least 32 characters long?
- Is `MCP_ALLOW_NO_AUTH=false`?
- Does `WORKSPACE_PATH` point to a dedicated workspace?
- Are the Docker socket and the full host home directory excluded from mounts?
- Are only container-specific SSH credentials used?
- Are public connections terminated by an HTTPS proxy?
- Does `MCP_TRUST_PROXY_HOPS` match the actual proxy chain?
- Are OAuth state and SSH keys backed up and handled as sensitive data?
- Are images rebuilt and `npm audit` results reviewed regularly?


## Process lifecycle and diagnostics

The Docker setup keeps operational state under `/data`. By default:

```dotenv
MCP_PROCESS_IDLE_TIMEOUT_MS=1800000
MCP_PROCESS_MAX_RUNTIME_MS=14400000
MCP_TASK_JOURNAL_FILE=/data/task-journal.jsonl
```

Use `docker compose exec cokacremote npm run doctor` to verify runtime dependencies and workspace access. The task journal is retained in the `cokacremote-data` volume across container restarts.
