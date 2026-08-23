# Workmachine Instructions

## Purpose

- `/shared` is the persistent host-mounted workspace.
- Store projects and durable files under `/shared`.
- Treat files outside `/shared` as disposable unless documented otherwise.

## Public Access

- This workmachine is connected to its public domain through Cloudflare Tunnel.
- Public domain: `{{PUBLIC_DOMAIN}}`
- Public base URL: `{{PUBLIC_BASE_URL}}`
- Public MCP endpoint: `{{PUBLIC_MCP_URL}}`
- Cloudflare Tunnel forwards public requests to Nginx at `http://localhost:2999`.
- Nginx forwards the protected cokacremote paths, including `/mcp`, to `http://127.0.0.1:3000`.

## Instruction Scope

- Check for a nearer `AGENTS.md` before modifying a project.
- Project-specific instructions take precedence within that project.
- Preserve existing files, repositories, and uncommitted changes.

## Reserved Workmachine Resources

The following resources belong to the workmachine infrastructure and cokacremote. During unrelated application development, never reuse, overwrite, remove, stop, redirect, or otherwise interfere with them:

- TCP port `2999`: Nginx gateway
- TCP port `3000`: cokacremote MCP server
- `/opt/cokacremote`
- `/var/lib/cokacremote`
- `/etc/nginx/routes.d/10-cokacremote.conf`
- Nginx and cokacremote Supervisor processes
- `/mcp`
- `/health`
- `/.well-known/*`
- `/authorize`
- `/token`
- `/register`
- `/revoke`

Only modify these resources when the user explicitly requests maintenance of workmachine or cokacremote.

## Application Services

- Check listening ports before selecting an application port.
- New applications must not use ports `2999` or `3000`.
- Bind application servers to `127.0.0.1` unless instructed otherwise.
- Store application route files in `/shared/nginx/routes.d/`.
- Use one route file and one unique internal port per application.
- Do not modify `/etc/nginx/routes.d/10-cokacremote.conf`.

## Nginx Changes

- Validate configuration before applying it.
- Apply changes with `nginx -t && nginx -s reload`.
- Do not stop or restart Nginx when a reload is sufficient.
- Do not modify Cloudflare Tunnel settings unless explicitly requested.

## Safety

- Do not delete, overwrite, move, or reset user files without explicit approval.
- Do not expose secrets, tokens, `.env` files, or OAuth keys.
- Do not publish container ports directly without approval.
- Avoid destructive system and Git commands.

## Verification

- Use the package manager selected by the existing lockfile.
- Run relevant tests or builds after changes.
- Report changed files, allocated ports, routes, and verification results.
