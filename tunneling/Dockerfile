# syntax=docker/dockerfile:1
FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG TIMEZONE=UTC
ARG COKACREMOTE_REPOSITORY=https://github.com/kstost/cokacremote.git
ARG COKACREMOTE_REF=main

ENV TZ=${TIMEZONE} \
    NODE_ENV=production \
    MCP_HOST=127.0.0.1 \
    MCP_PORT=3000 \
    MCP_DEFAULT_CWD=/ \
    MCP_ENDPOINT=/mcp \
    MCP_TRUST_PROXY_HOPS=1 \
    MCP_AUTH_TOKEN="" \
    MCP_OAUTH_ENABLED=true \
    MCP_OAUTH_STATE_FILE=/var/lib/cokacremote/oauth-state.json \
    MCP_OAUTH_APPROVAL_KEY_FILE=/var/lib/cokacremote/oauth-approval-key

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        nginx \
        openssl \
        supervisor \
        tmux \
        tzdata \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch "${COKACREMOTE_REF}" \
        "${COKACREMOTE_REPOSITORY}" /opt/cokacremote \
    && cd /opt/cokacremote \
    && npm ci --include=dev \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

COPY templates/AGENTS.md /usr/local/share/workmachine/AGENTS.md

RUN <<'SETUP'
set -eu

rm -f /etc/nginx/sites-enabled/default
mkdir -p /etc/nginx/routes.d /etc/nginx/snippets /var/lib/cokacremote /shared
chmod 0700 /var/lib/cokacremote

cat > /etc/nginx/snippets/workmachine-proxy.conf <<'NGINX'
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Host $host;
proxy_set_header X-Forwarded-Proto $workmachine_forwarded_proto;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $workmachine_connection_upgrade;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
NGINX

cat > /etc/nginx/conf.d/workmachine.conf <<'NGINX'
map $http_upgrade $workmachine_connection_upgrade {
    default upgrade;
    ''      close;
}

map $http_x_forwarded_proto $workmachine_forwarded_proto {
    default $http_x_forwarded_proto;
    ''      $scheme;
}

server {
    listen 2999 default_server;
    server_name _;

    include /etc/nginx/routes.d/*.conf;
    include /shared/nginx/routes.d/*.conf;
}
NGINX

cat > /etc/nginx/routes.d/10-cokacremote.conf <<'NGINX'
location = /mcp {
    include /etc/nginx/snippets/workmachine-proxy.conf;
    proxy_buffering off;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:3000;
}

location = /health {
    include /etc/nginx/snippets/workmachine-proxy.conf;
    proxy_pass http://127.0.0.1:3000;
}

location ^~ /.well-known/ {
    include /etc/nginx/snippets/workmachine-proxy.conf;
    proxy_pass http://127.0.0.1:3000;
}

location ~ ^/(authorize|token|register|revoke)$ {
    include /etc/nginx/snippets/workmachine-proxy.conf;
    proxy_buffering off;
    proxy_pass http://127.0.0.1:3000;
}
NGINX

# Example: add a new application later without changing the default routes.
# Create /shared/nginx/routes.d/20-newapp.conf:
#
# location = /newapp {
#     return 308 /newapp/;
# }
#
# location ^~ /newapp/ {
#     include /etc/nginx/snippets/workmachine-proxy.conf;
#     proxy_pass http://127.0.0.1:5000/;
# }
#
# Then validate and reload Nginx:
# nginx -t && nginx -s reload

cat > /etc/supervisor/conf.d/workmachine.conf <<'SUPERVISOR'
[supervisord]
nodaemon=true
logfile=/dev/null
pidfile=/run/supervisord.pid

[program:nginx]
command=/usr/sbin/nginx -g "daemon off;"
priority=10
autostart=true
autorestart=true
startsecs=2
stopsignal=QUIT
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:cokacremote]
command=/usr/bin/npm start
directory=/opt/cokacremote
priority=20
autostart=true
autorestart=true
startsecs=2
stopasgroup=true
killasgroup=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SUPERVISOR

cat > /usr/local/bin/workmachine-entrypoint <<'ENTRYPOINT'
#!/usr/bin/env bash
set -euo pipefail

install -d -m 0755 /shared/nginx/routes.d

public_host=""
public_mcp_url="not configured"

if [[ "${MCP_OAUTH_ENABLED:-false}" == "true" ]]; then
    : "${MCP_PUBLIC_URL:?Set MCP_PUBLIC_URL to the externally accessible base URL}"
    MCP_PUBLIC_URL="${MCP_PUBLIC_URL%/}"
    export MCP_PUBLIC_URL
    export MCP_OAUTH_ISSUER="${MCP_OAUTH_ISSUER:-${MCP_PUBLIC_URL}}"
    export MCP_OAUTH_RESOURCE="${MCP_OAUTH_RESOURCE:-${MCP_PUBLIC_URL}${MCP_ENDPOINT:-/mcp}}"
fi

if [[ -n "${MCP_PUBLIC_URL:-}" ]]; then
    public_host="$(node -e 'process.stdout.write(new URL(process.env.MCP_PUBLIC_URL).hostname)')"
    public_mcp_url="${MCP_PUBLIC_URL}${MCP_ENDPOINT:-/mcp}"
fi

if [[ -z "${MCP_ALLOWED_HOSTS:-}" ]]; then
    if [[ -n "${public_host}" ]]; then
        export MCP_ALLOWED_HOSTS="${public_host},localhost,127.0.0.1"
    else
        export MCP_ALLOWED_HOSTS="localhost,127.0.0.1"
    fi
fi

if [[ ! -e /shared/AGENTS.md && ! -L /shared/AGENTS.md ]]; then
    agents_tmp="$(mktemp)"
    PUBLIC_BASE_URL="${MCP_PUBLIC_URL:-not configured}" PUBLIC_DOMAIN="${public_host:-not configured}" PUBLIC_MCP_URL="${public_mcp_url}" node -e 'const fs = require("fs"); const source = fs.readFileSync("/usr/local/share/workmachine/AGENTS.md", "utf8"); process.stdout.write(source.replaceAll("{{PUBLIC_BASE_URL}}", process.env.PUBLIC_BASE_URL).replaceAll("{{PUBLIC_DOMAIN}}", process.env.PUBLIC_DOMAIN).replaceAll("{{PUBLIC_MCP_URL}}", process.env.PUBLIC_MCP_URL));' > "${agents_tmp}"
    install -m 0644 "${agents_tmp}" /shared/AGENTS.md
    rm -f "${agents_tmp}"
fi

install -d -m 0700 "$(dirname "${MCP_OAUTH_STATE_FILE}")"
install -d -m 0700 "$(dirname "${MCP_OAUTH_APPROVAL_KEY_FILE}")"

if [[ -z "${MCP_OAUTH_APPROVAL_KEY:-}" ]]; then
    if [[ ! -s "${MCP_OAUTH_APPROVAL_KEY_FILE}" ]]; then
        openssl rand -hex 32 > "${MCP_OAUTH_APPROVAL_KEY_FILE}"
        chmod 0600 "${MCP_OAUTH_APPROVAL_KEY_FILE}"
    fi
    export MCP_OAUTH_APPROVAL_KEY
    MCP_OAUTH_APPROVAL_KEY="$(<"${MCP_OAUTH_APPROVAL_KEY_FILE}")"
fi

nginx -t
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/workmachine.conf
ENTRYPOINT

chmod 0755 /usr/local/bin/workmachine-entrypoint
SETUP

VOLUME ["/var/lib/cokacremote"]

WORKDIR /shared

EXPOSE 2999

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS -H "Host: localhost" http://127.0.0.1:2999/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/workmachine-entrypoint"]
