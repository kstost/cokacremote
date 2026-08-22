# Running with Docker Desktop on macOS

This setup runs `cokacremote` inside Docker Desktop. The MCP server can access
only the directory mounted at `/workspace`; it does not receive the Docker
socket, your SSH keys, or your macOS home directory.

## Prerequisites

- macOS
- Docker Desktop
- Git

## Setup

Create your local configuration and set a strong authentication token:

```bash
cp .env.example .env
openssl rand -hex 32
```

Put the generated value in `.env` as `MCP_AUTH_TOKEN=<generated-value>`. Do
not commit `.env`.

The service executes commands as the non-root `node` user inside the
container. The image already includes Git, curl, wget, OpenSSH client,
Python 3, build tools, jq, and ripgrep for work performed in the mounted
workspace.

## Build

```bash
docker compose build
```

## Start

```bash
docker compose up -d
```

## Status

```bash
docker compose ps
```

## Logs

```bash
docker compose logs -f cokacremote
```

## Stop

```bash
docker compose down
```

The named `cokacremote-data` volume is intentionally retained by this command
so OAuth state survives a container replacement. Remove it only when you
intend to invalidate that state:

```bash
docker compose down -v
```

## Rebuild

```bash
docker compose build --no-cache
docker compose up -d
```

## Health check

The HTTP port is bound to localhost only. With the default settings:

```bash
curl -f http://127.0.0.1:3000/health
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`. It requires the Bearer token
configured in `MCP_AUTH_TOKEN` unless built-in OAuth is enabled or the server
is deliberately configured for authenticated upstream access.

## Workspace

By default, the host directory `./workspace` is mounted at `/workspace` in the
container and is the MCP server's default working directory. Only
`workspace/.gitkeep` is tracked by this repository; files created during work
are ignored.

To use an existing macOS project directory, set a specific path in `.env`:

```dotenv
WORKSPACE_PATH=/Users/myname/Projects/ai-workspace
```

Do not mount your entire home directory, `/`, Docker Desktop's socket, system
directories, or SSH key directories. The container is intentionally not
privileged and publishes its HTTP port only on `127.0.0.1`.

## OAuth state

When `MCP_OAUTH_ENABLED=true`, set `MCP_PUBLIC_URL`,
`MCP_OAUTH_APPROVAL_KEY`, `MCP_OAUTH_ISSUER`, and `MCP_OAUTH_RESOURCE` to the
public HTTPS values for the future reverse-proxy or tunnel deployment. OAuth
state defaults to `/data/oauth-state.json`, which is backed by the named
Docker volume rather than the bind-mounted workspace.
