# workmachine

A long-running Ubuntu development machine controlled through cokacremote MCP.

On first start, workmachine creates `/shared/AGENTS.md` from `templates/AGENTS.md` if the file does not already exist. Existing instructions are never overwritten.

## Configure

Run commands from the directory containing `docker-compose.yml`:

```bash
cd /absolute/path/to/workmachine
cp .env.example .env
```

Set these values in `.env`:

- `SHARED_PATH`: absolute host directory mounted at `/shared`
- `MCP_PUBLIC_URL`: public HTTPS base URL without `/mcp`
- `CLOUDFLARE_TUNNEL_TOKEN`: Cloudflare Tunnel token

Example for macOS:

```dotenv
SHARED_PATH=/Users/yourname/Documents/workspace
MCP_PUBLIC_URL=https://example.com
CLOUDFLARE_TUNNEL_TOKEN=replace-with-your-real-tunnel-token
TZ=Asia/Seoul
COKACREMOTE_REF=main
```

This example creates the public MCP endpoint `https://example.com/mcp`. Use an absolute path for `SHARED_PATH`, do not add a trailing slash to `MCP_PUBLIC_URL`, and never commit the populated `.env` file.

In the Cloudflare Tunnel public-hostname settings, set the service URL to:

```text
http://localhost:2999
```

## Start

From the directory containing `docker-compose.yml`:

```bash
cd /absolute/path/to/workmachine
docker compose -p workmachine up -d --build
docker compose -p workmachine ps
docker compose -p workmachine logs -f
```

To rebuild without reusing layers from previous Docker builds, then recreate the
containers from the new image:

```bash
docker compose -p workmachine build --no-cache --pull
docker compose -p workmachine up -d --force-recreate
```

This keeps the existing `cokacremote-state` volume and its OAuth state.

To run from any directory, specify both the Compose file and environment file:

```bash
docker compose -p workmachine -f /absolute/path/to/workmachine/docker-compose.yml --env-file /absolute/path/to/workmachine/.env up -d --build
```

Nginx listens on port 2999 and forwards cokacremote routes to port 3000.

Read the generated OAuth approval key:

```bash
docker compose -p workmachine exec workmachine cat /var/lib/cokacremote/oauth-approval-key
```

## Add an application route

Create a file under `${SHARED_PATH}/nginx/routes.d`, for example `20-newapp.conf`:

```nginx
location = /newapp {
    return 308 /newapp/;
}

location ^~ /newapp/ {
    include /etc/nginx/snippets/workmachine-proxy.conf;
    proxy_pass http://127.0.0.1:5000/;
}
```

Validate and reload without restarting the container:

```bash
docker compose -p workmachine exec workmachine nginx -t
docker compose -p workmachine exec workmachine nginx -s reload
```
