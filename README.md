# cokacremote

`cokacremote` lets ChatGPT or another MCP client work directly on a remote Linux server.

In simple terms, it gives an AI client tools to do things you would normally do over SSH: run shell commands, inspect logs, edit files, install packages, build projects, and manage services.

MCP stands for **Model Context Protocol**. It is a standard that lets an AI client call tools provided by another program. You do not need to understand the protocol internals to use `cokacremote`.

```text
ChatGPT or another MCP client
            |
            | MCP over HTTPS
            v
       cokacremote
            |
            v
       Linux server
       |- run commands
       |- read/write files
       |- install packages
       |- build and test code
       `- manage processes and services
```

You can run `cokacremote` continuously on a VPS or EC2 instance and connect to it remotely over MCP Streamable HTTP.

> [!WARNING]
> `cokacremote` is intentionally powerful. It has no sandbox, command allowlist, execution approval, or path restrictions. If the service runs as `root`, an authenticated MCP client can change or delete anything on the server. Use HTTPS, strong authentication, and only connect trusted clients.

## Quick start

If you already have a Linux server and Node.js 22+, the shortest local test is:

```bash
git clone https://github.com/kstost/cokacremote.git
cd cokacremote
npm install
npm run build

export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_DEFAULT_CWD=/root
npm start
```

The server starts on port `3000` by default.

- MCP endpoint: `http://127.0.0.1:3000/mcp`
- Health check: `http://127.0.0.1:3000/health`

For a real remote ChatGPT connection, you will normally also need:

1. A public HTTPS domain such as `https://mcp.example.com`
2. Nginx or another reverse proxy in front of the Node.js service
3. OAuth enabled for ChatGPT, or a Bearer token for clients that support one
4. The MCP URL added in ChatGPT, for example `https://mcp.example.com/mcp`

The full deployment and ChatGPT connection steps are explained later in this README.

## What can it do?

Typical tasks include:

- "Show me the current RAM and disk usage."
- "Find why Nginx is returning 502."
- "Edit this config file and restart the service."
- "Clone this Git repository and run its tests."
- "Install Node.js packages and build the project."
- "Upload a file, verify its hash, and move it into place."

Internally, these actions are provided through 20 MCP tools for shell execution, long-running processes, and filesystem operations.

## How it works

With `cokacremote`:

1. ChatGPT sends an MCP request over HTTPS.
2. `cokacremote` checks authentication.
3. It runs the requested tool directly on the host server.
4. The command output or file-operation result is returned to ChatGPT.

The MCP transport is stateless, but long-running command sessions are kept in memory so they can be polled or controlled across multiple requests.

## Key features

- Shell commands, complete scripts, builds, tests, package installation, Git, and service management
- Output polling, stdin delivery, and termination control for long-running processes
- Read, write, edit, transfer, and delete host files, including absolute paths
- Built-in static Bearer authentication and OAuth 2.1/DCR/PKCE for ChatGPT
- Stateless JSON transport per request, per-process output retention, and response size limits
- Built-in `npm run doctor` diagnostics for runtime/tooling/workspace readiness
- Optional persistent JSONL process journal plus idle/max-runtime process lifecycle controls
- systemd and Nginx deployment examples for Linux VPS/EC2 environments

## Available tools

### Execution and processes

- `exec_command`: Run shell commands, builds, tests, package installation, Git, service management, and log inspection
- `run_script`: Run complete scripts with Bash, sh, Node.js, Python, or an arbitrary interpreter
- `write_stdin`: Write input to a long-running process and retrieve subsequent output
- `read_process`: Poll output using a cursor and inspect process termination state
- `terminate_process`: Send `SIGINT`, `SIGTERM`, or `SIGKILL` to a managed process group
- `list_processes`: List running or recently completed process sessions

### Filesystem

- `list_directory`, `stat_path`, `read_file`, `write_file`
- `replace_in_file`, `apply_patch`
- `upload_file`, `download_file`, `hash_file`
- `make_directory`, `copy_path`, `move_path`, `remove_path`, `chmod_path`

Relative paths are resolved from `MCP_DEFAULT_CWD`, while absolute paths and `~/...` paths are also allowed. Uploads and downloads use base64 chunk transfer with `nextOffset`.

The server provides 20 tools in total. `remove_path` permanently deletes targets without using a trash folder, and `apply_patch` uses the host's `git apply --unsafe-paths`.

### File reading and transfer rules

- `offset`, `bytesRead`, and `nextOffset` returned by `read_file` are all byte offsets or byte counts.
- With `encoding="utf8"`, multibyte characters such as Korean text and emoji are never split across chunk boundaries. `bytesRead` may exceed the requested `maxBytes` by up to 3 bytes when necessary to include one complete character, but it never exceeds the server's `MCP_MAX_FILE_CHUNK_BYTES` limit.
- Invalid UTF-8 is rejected instead of silently replacing invalid bytes. Read binary files with `encoding="base64"`.
- Base64 input for `write_file` and `upload_file` is strictly validated for alphabet, length, and padding. Standard base64 without padding is also accepted, while invalid input is rejected before the file is modified.
- `write_file.fileMode` applies both to new files and when overwriting or appending to existing files.
- `copy_path` returns a conflict error for both files and directories when the destination already exists and `force=false`.

## Transport and state model

`/mcp` is a stateless Streamable HTTP JSON endpoint where every request is handled independently.

- Each `POST /mcp` request is handled with a new MCP transport and does not issue or require an `Mcp-Session-Id`.
- If an older client sends a stale `Mcp-Session-Id` header, the server ignores it for request processing.
- An authenticated `GET /mcp` or `DELETE /mcp` request returning `405 Method Not Allowed` is expected. Missing or invalid authentication may produce `401 Unauthorized` before the request reaches that method check. The server does not maintain a server-push SSE session.
- MCP transport sessions and command process `sessionId` values are unrelated. A process `sessionId` returned by `exec_command` can be reused by later HTTP requests to `write_stdin`, `read_process`, and `terminate_process`.
- Running and retained process state is stored in service memory and is lost when the service restarts.

## Requirements

- Node.js 22 or later and npm
- Linux recommended; the provided production deployment examples target systemd and Nginx
- Git for `apply_patch`
- OpenSSL for key generation
- Python 3 if Python execution through `run_script` is needed
- A stable, publicly accessible HTTPS domain when connecting directly from ChatGPT

## Task dashboard

Open `/dashboard` on the same server to inspect recent development tasks, summaries, and their ordered event timelines. The dashboard uses the same bearer/OAuth authentication as the MCP endpoint and refreshes every three seconds. Its JSON endpoints under `/dashboard/api/tasks` can also be used by external monitoring UIs.

## Reliability controls

Three operational controls are available for long-running development sessions:

- `MCP_PROCESS_IDLE_TIMEOUT_MS`: terminates a process after no stdout/stderr activity for the configured interval. Default: `1800000` (30 minutes). Set `0` to disable.
- `MCP_PROCESS_MAX_RUNTIME_MS`: fallback hard runtime limit when a tool call does not provide its own `timeoutMs`. Default: `14400000` (4 hours). Set `0` to disable.
- `MCP_TASK_JOURNAL_FILE`: optional JSONL journal containing process start/completion/idle-timeout events. Docker Compose defaults this to `/data/task-journal.jsonl`, which is stored in the persistent `cokacremote-data` volume.

Run a host readiness check with:

```bash
npm run doctor
```

The doctor checks Node.js, Git, the configured shell, npm, Python, workspace read/write access, and the configured task-journal location.

### Development task journal

When `MCP_TASK_JOURNAL_FILE` is configured, related MCP calls can be grouped into a durable development task:

1. Call `start_task` and keep the returned `taskId`.
2. Pass `taskId` to `exec_command`, `run_script`, `write_file`, `replace_in_file`, `apply_patch`, or `upload_file`.
3. Use `get_task` or `list_tasks` to review commands and changed files.
4. Call `complete_task` when the work is finished.

Calls without `taskId` remain fully backward compatible. The journal stores command metadata and changed paths, not stdout/stderr or file contents.

## Local development

The Quick Start above is enough to run a normal local instance. If you are changing the source code itself, development mode automatically watches the TypeScript entry point:

```bash
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" npm run dev
```

## Docker Compose

For complete installation, security, persistent SSH, OAuth, update, and troubleshooting instructions, see the [Docker Compose Installation and Operations Guide](docs/docker-compose-guide.md). A [Korean version](docs/docker-compose-guide.ko.md) is also available. For a shorter macOS Docker Desktop walkthrough, see [DOCKER.md](DOCKER.md).

The Compose service bind-mounts the project-local `./.ssh` directory at `/home/node/.ssh`. SSH keys, config, and `known_hosts` created inside the container therefore survive container restarts and recreation without exposing the host user's SSH directory. Set `SSH_PATH` in `.env` to use another directory on the same disk.

Then build or recreate the service normally:

```bash
docker compose up -d --build
```

Create the host directory with mode `0700` before starting the service. Because this is a bind mount, `docker compose down --volumes` does not remove its SSH credentials. Back up or delete the configured `SSH_PATH` separately when needed.

## Authentication

When `MCP_AUTH_TOKEN` is set, every MCP request requires the following header:

```http
Authorization: Bearer <MCP_AUTH_TOKEN>
```

You can also enable the built-in OAuth 2.1 Authorization Server for ChatGPT connections. The following values are environment-file examples, not shell commands:

```dotenv
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<separate-value-generated-with-openssl-rand-hex-32>
MCP_PUBLIC_URL=https://mcp.example.com
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/var/lib/remote-dev-mcp/oauth-state.json
```

When enabled, the server provides:

- RFC 9728 Protected Resource Metadata
- RFC 8414 Authorization Server Metadata
- Dynamic Client Registration (DCR)
- Authorization Code + PKCE (S256)
- `resource` audience validation
- Access tokens, replay-detecting refresh token rotation, and grant-level token revocation

OAuth uses a single `mcp:tools` scope. Enter the `MCP_OAUTH_APPROVAL_KEY` value on the approval page shown when authorizing a ChatGPT connection. For OAuth-only deployments, it is recommended to leave `MCP_AUTH_TOKEN` empty so there is no permanent static Bearer bypass path. For backward compatibility, `MCP_AUTH_TOKEN` is used as the approval key when no dedicated approval key is configured, but keeping the two values separate is safer. Treat both values like root credentials. Registered clients, client secrets, and token hashes are stored in `MCP_OAUTH_STATE_FILE` with mode `600`.

Both authentication secrets must contain at least 32 characters, and known example placeholder values are rejected at startup. Generate independent values with `openssl rand -hex 32`; do not copy the literal placeholder values from the example environment files.

OAuth-related HTTP routes:

| Path | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` | RFC 9728 resource metadata |
| `/.well-known/oauth-protected-resource/mcp` | Resource metadata for the `/mcp` path |
| `/.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `/register` | Dynamic Client Registration |
| `/authorize` | User approval and authorization code issuance |
| `/token` | Authorization code / refresh token exchange |
| `/revoke` | Token revocation |

If authentication is handled by an OAuth proxy or private network in front of the server, the built-in authentication checks can be disabled:

```dotenv
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=false
MCP_ALLOW_NO_AUTH=true
```

`MCP_ALLOW_NO_AUTH=true` does not enable anonymous mode while `MCP_AUTH_TOKEN` remains set or OAuth is enabled. When using an external IdP or OAuth gateway, bind the Node.js server only to `127.0.0.1` and complete authentication at the upstream layer. Exposing an unauthenticated MCP server to the public internet allows anyone who knows the URL to use the instance with the server process's full privileges.

OpenAI's current remote MCP authentication requirements are documented in [MCP server authentication](https://developers.openai.com/plugins/build/auth).

## VPS/EC2 deployment

The following example installs the server under `/opt/remote-dev-mcp` on an Ubuntu-based system. The service unit remains named `remote-dev-mcp.service` for backward compatibility.

```bash
sudo mkdir -p /opt/remote-dev-mcp
sudo cp -a package.json package-lock.json tsconfig.json src deploy /opt/remote-dev-mcp/
cd /opt/remote-dev-mcp
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev

sudo install -d -m 0700 /var/lib/remote-dev-mcp

sudo cp deploy/remote-dev-mcp.env.example /etc/remote-dev-mcp.env
sudo chmod 600 /etc/remote-dev-mcp.env
sudo editor /etc/remote-dev-mcp.env

sudo cp deploy/remote-dev-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now remote-dev-mcp
sudo systemctl status remote-dev-mcp
```

If `/usr/bin/node` is not the actual Node.js path, update `ExecStart` in the systemd unit. Use `which node` to find the correct path.

HTTPS is required when exposing the server to the public internet. Update the domain and certificate paths in the [Nginx example](deploy/nginx.remote-dev-mcp.conf), prepare a valid certificate, and then enable the configuration. It is recommended to bind the Node.js server to `127.0.0.1` and expose only ports 80/443 externally. Use a sufficiently long proxy read timeout so long-running tool calls are not terminated by the proxy first.

Set `MCP_TRUST_PROXY_HOPS=1` only when exactly one trusted proxy sits in front of the Node.js server, as in the provided Nginx example. Do not reuse that value when exposing the Node.js port directly or when the proxy hop count differs. Incorrectly trusting `X-Forwarded-For` can allow OAuth rate limits to be bypassed.

At minimum, update the following production environment values for your actual domain:

```dotenv
MCP_HOST=127.0.0.1
MCP_PUBLIC_URL=https://mcp.example.com
MCP_ALLOWED_HOSTS=mcp.example.com,127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=1
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<value-generated-with-openssl-rand-hex-32>
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
```

## Connecting ChatGPT

Assume the deployed MCP URL is `https://mcp.example.com/mcp`.

The UI for adding an MCP server can differ by plan and workspace type. OpenAI's current Plugins Quickstart describes a personal developer-mode flow that enables **Settings → Security and login → Developer mode** and then adds the MCP server through ChatGPT Plugins. Business/Enterprise/Edu full-MCP app flows may instead use **Settings → Apps → Advanced Settings** or the administrator path **Workspace Settings → Apps → Create**.

1. Enable **Developer mode** for the account or workspace you are using.
2. In ChatGPT's Plugins or Apps settings, create a new MCP connection and enter `https://mcp.example.com/mcp` as the MCP URL.
3. If an OAuth registration method can be selected, choose **Dynamic Client Registration (DCR)**. Because this server provides DCR, you do not need to create a Client ID and Client Secret manually.
4. Use the `mcp:tools` scope. For a public client flow, the token endpoint authentication method can be `none`.
5. When the OAuth approval page appears, enter `MCP_OAUTH_APPROVAL_KEY` to approve the connection.
6. Complete tool discovery or connection verification, then enable the app/plugin.

This server provides DCR and OAuth Authorization Code + PKCE (S256), but does not provide CIMD or OIDC. ChatGPT continues to support DCR, although CIMD may be preferred when an authorization server provides it. For this server, which provides DCR only, use the DCR flow.

Full MCP write/modify capabilities vary by plan and workspace policy. This server includes destructive tools such as file modification, command execution, and deletion, so not every capability will be available if the connection UI restricts tool permissions.

See the official [ChatGPT Plugins Quickstart](https://developers.openai.com/plugins/quickstart), [OpenAI Help Center guide to Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta), and [MCP server authentication](https://developers.openai.com/plugins/build/auth). When using the OpenAI Responses API, see [MCP and Connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) for how to provide the server URL and required authentication information.

## Operations and troubleshooting

```bash
# Check the Node.js service behind the local proxy
curl http://127.0.0.1:3000/health

# Check the public HTTPS endpoint
curl https://mcp.example.com/health

# Service status and live logs
sudo systemctl status remote-dev-mcp
sudo journalctl -u remote-dev-mcp -f

# Restart after changing configuration or code
sudo systemctl restart remote-dev-mcp
```

Example healthy response:

```json
{
  "status": "ok",
  "service": "cokacremote",
  "version": "0.1.0",
  "transportMode": "stateless-json",
  "activeMcpSessions": 0,
  "activeMcpRequests": 0,
  "managedProcesses": 0,
  "unrestrictedHostAccess": true,
  "oauthEnabled": true
}
```

- `activeMcpSessions` is always `0` in stateless mode. This does not mean the connection is broken.
- `activeMcpRequests` is the number of MCP HTTP requests being processed at the time of the health request.
- `managedProcesses` includes both currently running processes and recently completed processes retained temporarily for output retrieval. Check the `status` field from `list_processes` to determine whether a process is still running. Completed records are removed after `MCP_PROCESS_RETENTION_MS`.
- Every MCP response includes an `X-Request-Id` for tracing. Service log entries with `event="mcp_request"` record the RPC method, tool name, HTTP status, outcome, and duration without logging authentication tokens or tool arguments.

To inspect recent MCP request logs only:

```bash
sudo journalctl -u remote-dev-mcp -o cat | grep '"event":"mcp_request"'
```

- `Error fetching OAuth configuration`: Check `MCP_OAUTH_ENABLED`, the public URL, and the Nginx proxy for `/.well-known/` routes.
- `401 Unauthorized` on MCP requests: Check the Bearer token or OAuth access token.
- `403 Host header is not allowed`: Add the request domain to `MCP_ALLOWED_HOSTS`.
- A command returns a `sessionId` instead of completing immediately: Poll it with `read_process` or send input with `write_stdin`.
- MCP requests are independent stateless POST requests. An authenticated `GET /mcp` or `DELETE /mcp` returning `405 Method Not Allowed` is expected and means the server does not provide a separate SSE stream. Authentication failures may return `401 Unauthorized` first.
- Service restart behavior: Managed process state and unexchanged authorization codes are lost. OAuth client registrations and issued tokens remain in the state file.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The default tests use a real Streamable HTTP MCP client and cover:

- Bearer authentication, stateless request processing, and request tracing headers
- Success paths, failure paths, and input boundary cases for all 20 tools
- Interactive stdin, output pagination, timeouts, termination, and completed-process retention
- UTF-8 character boundaries, strict base64 validation, file modes, and copy/move conflicts
- Unified diff validation, application, reverse application, and 3-way application

### Full E2E verification against a running external MCP server

From a separate source checkout with development dependencies installed, you can verify all 20 tools against a real HTTPS endpoint:

```bash
MCP_E2E_URL='https://mcp.example.com/mcp' \
MCP_E2E_TOKEN='<bearer-token>' \
MCP_E2E_ROOT='/tmp/cokacremote-tools-e2e-manual' \
npx vitest run test/all-tools.integration.test.ts
```

This verification executes real commands on the target server and creates, modifies, and deletes test files. For safety, `MCP_E2E_ROOT` must match the `/tmp/cokacremote-tools-e2e-*` pattern. The test uses only that isolated directory and attempts to clean it afterward. Do not point it at a directory containing production data, and check whether the directory remains after a failed or interrupted test. Running `npm ci` inside the production installation directory may alter its production-only dependency layout, so run tests from a separate checkout instead.

## Key environment variables

| Variable | Default | Description |
|---|---:|---|
| `MCP_HOST` | `0.0.0.0` | HTTP bind address |
| `MCP_PORT` | `3000` | HTTP port |
| `MCP_ENDPOINT` | `/mcp` | Streamable HTTP MCP path |
| `MCP_PUBLIC_URL` | none | External HTTPS base URL excluding `/mcp` |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated list of allowed Host header hostnames |
| `MCP_TRUST_PROXY_HOPS` | `0` | Number of trusted reverse-proxy hops; keep `0` when directly exposed |
| `MCP_AUTH_TOKEN` | none | Optional static Bearer token |
| `MCP_ALLOW_NO_AUTH` | `false` | Allow startup without authentication |
| `MCP_OAUTH_ENABLED` | `false` | Enable built-in OAuth 2.1/DCR for ChatGPT |
| `MCP_OAUTH_APPROVAL_KEY` | `MCP_AUTH_TOKEN` | Dedicated key for the OAuth connection approval page |
| `MCP_OAUTH_ISSUER` | `MCP_PUBLIC_URL` | OAuth issuer URL |
| `MCP_OAUTH_RESOURCE` | `<MCP_PUBLIC_URL><MCP_ENDPOINT>` | MCP resource audience |
| `MCP_OAUTH_STATE_FILE` | inside working directory | Stores registered clients and token hashes |
| `MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `3600` | OAuth access token lifetime |
| `MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `2592000` | OAuth refresh token lifetime |
| `MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS` | `300` | One-time authorization code lifetime |
| `MCP_DEFAULT_CWD` | server startup directory | Base directory for relative paths |
| `MCP_DEFAULT_SHELL` | `$SHELL` or `/bin/bash` | Default shell for `exec_command` |
| `MCP_MAX_REQUEST_BODY` | `8mb` | HTTP request body size limit |
| `MCP_MAX_OUTPUT_BYTES` | `1048576` | Maximum output returned by one tool call |
| `MCP_MAX_RETAINED_PROCESS_OUTPUT_BYTES` | `4194304` | Retained output per managed process |
| `MCP_PROCESS_RETENTION_MS` | `3600000` | Retention period for completed processes |
| `MCP_MAX_PROCESSES` | `128` | Maximum number of retained process sessions |
| `MCP_MAX_FILE_CHUNK_BYTES` | `1048576` | Maximum file chunk size; UTF-8 reads also stay within this limit |
| `MCP_MAX_EDIT_FILE_BYTES` | `67108864` | Maximum file size for text replacement |

## Project layout

| Path | Purpose |
|---|---|
| `src/http-server.ts` | Stateless Streamable HTTP, OAuth routing, and health endpoint |
| `src/mcp-server.ts` | MCP server metadata and tool registration |
| `src/exec-tools.ts` | Command, script, and long-running process tools |
| `src/file-service.ts` | File reading, writing, transfer, and path operations |
| `src/file-tools.ts` | Filesystem tools and input schemas |
| `src/oauth.ts` | DCR, PKCE, token issuance/refresh/revocation, and approval UI |
| `deploy/` | systemd, environment-file, and Nginx examples |
| `test/all-tools.integration.test.ts` | E2E tests for all 20 tools and external endpoints |
| `test/` | Configuration, file, process, MCP, and OAuth unit/integration tests |

## License

[MIT License](LICENSE)

## Disclaimer

THIS SOFTWARE IS PROVIDED “AS IS,” WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.

IN NO EVENT SHALL THE AUTHOR, COPYRIGHT HOLDERS, OR CONTRIBUTORS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF, OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF THE SOFTWARE.

This includes, but is not limited to:

* Data loss or corruption
* System damage or malfunction
* Security breaches or vulnerabilities
* Financial loss
* Direct, indirect, incidental, special, punitive, or consequential damages

The user assumes full responsibility for all consequences arising from the use of this software, whether such use was intended, authorized, or foreseeable.

**ALL RISKS ASSOCIATED WITH USE ARE BORNE BY THE USER**
