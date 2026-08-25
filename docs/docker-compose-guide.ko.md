# Docker Compose 설치 및 운영 가이드

이 문서는 `cokacremote`를 Docker Compose로 안전하게 실행하고 운영하는 방법을 설명합니다. macOS의 Docker Desktop과 Linux Docker Engine에서 사용할 수 있습니다.

> [!WARNING]
> `cokacremote`는 명령 실행과 파일 변경 기능을 제공하는 강력한 MCP 서버입니다. 컨테이너 안에서는 `node` 사용자로 실행되지만, 인증된 클라이언트는 마운트된 디렉터리와 컨테이너 네트워크에 제한 없이 접근할 수 있습니다. 호스트 전체, Docker 소켓 또는 개인 SSH 디렉터리를 마운트하지 마십시오.

## 1. 구성 구조

기본 Compose 구성은 다음 경계를 사용합니다.

| 호스트 | 컨테이너 | 용도 |
|---|---|---|
| `./workspace` | `/workspace` | MCP가 작업하는 기본 디렉터리 |
| `./.ssh` | `/home/node/.ssh` | 컨테이너 전용 SSH 설정과 키의 영속 저장 |
| `cokacremote-data` named volume | `/data` | OAuth 클라이언트와 토큰 해시 상태 저장 |
| `127.0.0.1:3000` | `3000` | MCP HTTP 서버 |
| `127.0.0.1:3010-3020` | `3010-3020` | 컨테이너에서 실행하는 개발 서버용 포트 |

`./.ssh`는 호스트 사용자의 `~/.ssh`가 아닙니다. 이 프로젝트 전용 디렉터리이며 컨테이너에서 새로 만든 키와 `known_hosts`만 저장해야 합니다.

## 2. 사전 요구사항

- Docker Desktop 또는 Docker Engine과 Compose 플러그인
- Git
- 인증키 생성을 위한 OpenSSL

설치 상태를 확인합니다.

```bash
docker version
docker compose version
git --version
openssl version
```

## 3. 최초 설정

저장소 루트에서 환경 파일과 마운트 디렉터리를 준비합니다.

```bash
cp .env.example .env
mkdir -p workspace .ssh
chmod 700 .ssh
```

Linux에서 컨테이너의 `node` 사용자(기본 UID/GID `1000`)가 bind mount에 쓰지 못한다면 다음과 같이 소유권을 조정합니다.

```bash
sudo chown -R 1000:1000 workspace .ssh
```

macOS Docker Desktop에서는 일반적으로 별도 소유권 변경이 필요하지 않습니다.

### 인증키 생성

다음 명령을 두 번 실행해 서로 다른 키를 준비합니다.

```bash
openssl rand -hex 32
```

출력된 값을 `.env`에 입력합니다. 정적 Bearer 인증만 사용할 때는 다음과 같이 설정합니다.

```dotenv
MCP_AUTH_TOKEN=<생성한 64자리 값>
MCP_ALLOW_NO_AUTH=false
MCP_OAUTH_ENABLED=false
```

인증키는 최소 32자여야 하며 `replace-with-`로 시작하는 예제 값은 서버가 거부합니다. `.env`는 Git에서 제외되므로 커밋하지 마십시오.

### 기본 네트워크 설정

로컬에서만 접근할 때 권장되는 값입니다.

```dotenv
MCP_HOST=0.0.0.0
MCP_LISTEN_HOST=127.0.0.1
MCP_PORT=3000
MCP_ALLOWED_HOSTS=127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=0
```

`MCP_HOST=0.0.0.0`은 컨테이너 내부에서 요청을 받기 위해 필요합니다. 호스트 공개 범위는 `MCP_LISTEN_HOST=127.0.0.1`이 제한합니다.

## 4. 설정 검증과 시작

Compose 문법과 변수 치환을 먼저 검사합니다.

```bash
docker compose config --quiet
```

이미지를 빌드하고 백그라운드에서 시작합니다.

```bash
docker compose up -d --build
```

상태와 로그를 확인합니다.

```bash
docker compose ps
docker compose logs --tail=100 cokacremote
```

정상 상태라면 `docker compose ps`에 `healthy`가 표시됩니다. 시작 직후에는 health check의 `start_period` 때문에 잠시 `starting`으로 표시될 수 있습니다.

## 5. 연결 확인

Health endpoint를 확인합니다.

```bash
curl -fsS http://127.0.0.1:3000/health
```

기본 MCP URL은 다음과 같습니다.

```text
http://127.0.0.1:3000/mcp
```

MCP 요청에는 `.env`에 설정한 Bearer 인증키가 필요합니다. 인증 없이 endpoint를 호출했을 때 `401 Unauthorized`가 반환되면 인증 경계가 동작하는 것입니다.

```bash
curl -i -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  --data '{}'
```

응답에는 다음 보안 헤더도 포함되어야 합니다.

```text
Cache-Control: no-store
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

## 6. 작업 디렉터리 변경

기본적으로 `./workspace`만 `/workspace`에 마운트됩니다. 다른 프로젝트를 사용하려면 `.env`의 `WORKSPACE_PATH`를 전용 디렉터리로 변경합니다.

```dotenv
WORKSPACE_PATH=/Users/myname/Projects/mcp-workspace
```

Linux 예시:

```dotenv
WORKSPACE_PATH=/srv/cokacremote-workspace
```

설정 변경 후 컨테이너를 재생성합니다.

```bash
docker compose up -d --force-recreate
```

다음 경로는 마운트하지 않는 것을 권장합니다.

- `/` 또는 사용자 홈 전체
- `/var/run/docker.sock`
- 호스트의 `~/.ssh`
- 운영 서버의 시스템 설정 디렉터리
- 다른 애플리케이션의 비밀정보 저장 디렉터리

## 7. 컨테이너 전용 SSH 사용

컨테이너 안에서 SSH 키를 만들면 프로젝트의 `SSH_PATH` 디렉터리에 유지됩니다.

```bash
docker compose exec cokacremote ssh-keygen -t ed25519 -f /home/node/.ssh/id_ed25519
docker compose exec -T cokacremote sh -lc \
  'ssh-keyscan github.com >> /home/node/.ssh/known_hosts && chmod 600 /home/node/.ssh/known_hosts'
```

공개키를 확인해 필요한 Git 호스팅 서비스에 등록합니다.

```bash
docker compose exec cokacremote cat /home/node/.ssh/id_ed25519.pub
```

`.ssh`는 `.gitignore`와 `.dockerignore`에 포함되어 있습니다. 그래도 별도 백업 정책과 파일 권한을 적용하고 외부에 공유하지 마십시오.

## 8. 컨테이너 안의 개발 서버 노출

Compose는 `3010-3020` 포트를 호스트의 localhost에만 공개합니다. MCP가 컨테이너 안에서 개발 서버를 시작할 때는 컨테이너 외부 연결을 받을 수 있도록 `0.0.0.0`에 바인딩해야 합니다.

예시:

```bash
npm run dev -- --host 0.0.0.0 --port 3010
```

호스트에서는 다음 주소로 접속합니다.

```text
http://127.0.0.1:3010
```

개발 서버가 `127.0.0.1`에만 바인딩되면 컨테이너 내부에서만 접근할 수 있습니다.

## 9. OAuth를 사용하는 공개 HTTPS 구성

ChatGPT와 같은 원격 MCP 클라이언트가 OAuth를 사용하려면 먼저 Nginx, 안전한 터널 또는 로드 밸런서로 공개 HTTPS 주소를 구성해야 합니다. Node.js 포트 `3000`을 인터넷에 직접 공개하지 마십시오.

프록시가 호스트에서 실행되고 정확히 한 단계만 존재하는 예시는 다음과 같습니다.

```dotenv
MCP_LISTEN_HOST=127.0.0.1
MCP_ALLOWED_HOSTS=mcp.example.com,127.0.0.1,localhost
MCP_TRUST_PROXY_HOPS=1
MCP_AUTH_TOKEN=
MCP_OAUTH_ENABLED=true
MCP_OAUTH_APPROVAL_KEY=<별도로 생성한 64자리 값>
MCP_PUBLIC_URL=https://mcp.example.com
MCP_OAUTH_ISSUER=https://mcp.example.com
MCP_OAUTH_RESOURCE=https://mcp.example.com/mcp
MCP_OAUTH_STATE_FILE=/data/oauth-state.json
```

프록시 단계 수가 다르거나 터널 서비스가 전달하는 주소 체계가 다르면 `MCP_TRUST_PROXY_HOPS`도 해당 구조에 맞게 조정해야 합니다. 잘못된 proxy trust 설정은 OAuth rate limit 우회를 허용할 수 있습니다.

OAuth 상태 파일은 `cokacremote-data` named volume에 저장됩니다. 서버가 생성한 상태 파일은 컨테이너의 서비스 사용자 소유와 `0600` 권한으로 관리됩니다.

## 10. 중지, 재시작 및 업데이트

일반적인 중지와 시작:

```bash
docker compose stop
docker compose start
```

설정 변경 후 재생성:

```bash
docker compose up -d --force-recreate
```

소스와 base image 업데이트:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

서비스와 네트워크를 내리되 OAuth named volume은 유지합니다.

```bash
docker compose down
```

## 11. 데이터 백업과 초기화

다음 데이터는 컨테이너를 재생성해도 유지됩니다.

- `WORKSPACE_PATH`의 작업 파일
- `SSH_PATH`의 컨테이너 전용 SSH 파일
- `cokacremote-data` volume의 OAuth 상태

OAuth 상태를 파일로 백업하려면 실행 중인 컨테이너에서 복사한 후 권한을 제한합니다.

```bash
docker compose cp cokacremote:/data/oauth-state.json ./oauth-state.backup.json
chmod 600 oauth-state.backup.json
```

백업에는 OAuth 클라이언트 정보와 토큰 해시가 들어 있으므로 인증정보와 동일하게 보호하십시오.

OAuth 등록과 발급 토큰을 모두 무효화하려는 경우에만 named volume을 삭제합니다.

```bash
docker compose down --volumes
```

> [!CAUTION]
> 이 명령은 `cokacremote-data` volume을 삭제하므로 복구할 수 없습니다. `WORKSPACE_PATH`와 `SSH_PATH`는 bind mount이므로 삭제되지 않습니다.

## 12. 문제 해결

### 인증키 오류로 시작되지 않음

로그에 인증키 길이 또는 placeholder 오류가 나타나면 새 키를 생성해 `.env`를 수정합니다.

```bash
openssl rand -hex 32
docker compose up -d --force-recreate
```

### 컨테이너가 unhealthy 상태임

```bash
docker compose ps
docker compose logs --tail=200 cokacremote
docker compose exec cokacremote curl -i http://localhost:3000/health
```

### `/workspace` 또는 `.ssh`에 쓸 수 없음

Linux에서는 bind mount 소유권을 확인합니다.

```bash
ls -ld workspace .ssh
sudo chown -R 1000:1000 workspace .ssh
```

### `403 Host header is not allowed`

요청에 사용한 도메인 또는 로컬 호스트명을 `MCP_ALLOWED_HOSTS`에 추가한 뒤 컨테이너를 재생성합니다.

### 포트가 이미 사용 중임

`.env`에서 호스트와 컨테이너가 함께 사용하는 MCP 포트를 변경합니다.

```dotenv
MCP_PORT=3100
```

또는 개발 서버가 사용하는 포트를 `3010-3020` 범위 안에서 변경합니다.

### 설정 변경이 반영되지 않음

`env_file` 또는 Compose 변수 변경 후에는 restart만 하지 말고 컨테이너를 재생성합니다.

```bash
docker compose up -d --force-recreate
```

## 13. 운영 보안 체크리스트

- `MCP_LISTEN_HOST=127.0.0.1`을 유지했는가?
- 32자 이상의 독립적인 인증키를 사용했는가?
- `MCP_ALLOW_NO_AUTH=false`인가?
- `WORKSPACE_PATH`가 전용 작업 디렉터리인가?
- 호스트의 Docker socket이나 홈 전체를 마운트하지 않았는가?
- 컨테이너 전용 `.ssh`만 사용하고 있는가?
- 공개 연결이 HTTPS 프록시 뒤에 있는가?
- `MCP_TRUST_PROXY_HOPS`가 실제 프록시 단계와 일치하는가?
- OAuth 상태와 SSH 키를 민감정보로 백업·관리하는가?
- 정기적으로 이미지를 다시 빌드하고 `npm audit` 결과를 확인하는가?
