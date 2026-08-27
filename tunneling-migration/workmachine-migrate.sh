#!/bin/bash
set -Eeuo pipefail
umask 077

BACKUP_NAME="workmachine-full-backup"

WORKMACHINE_CONTAINER="workmachine"
CLOUDFLARED_CONTAINER="chatgpt-cloudflared"

WORKMACHINE_IMAGE="workmachine-backup:latest"
CLOUDFLARED_IMAGE="cloudflared-backup:latest"
HELPER_IMAGE="alpine:3.22"

STATE_VOLUME="workmachine_cokacremote-state"
SHARED_SOURCE=""

TEMP_ROOT=""
WORKDIR=""
WM_WAS_RUNNING=0
CF_WAS_RUNNING=0
ORIGINALS_MAY_NEED_RESTART=0
WM_BACKUP_IMAGE_CREATED=0
CF_BACKUP_IMAGE_CREATED=0
WM_BACKUP_IMAGE_ID=""
CF_BACKUP_IMAGE_ID=""
WM_PREVIOUS_IMAGE_ID=""
CF_PREVIOUS_IMAGE_ID=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

set_backup_directory() {
  local requested_directory="$1"

  [ -d "$requested_directory" ] \
    || die "백업 디렉터리가 없습니다: $requested_directory"

  BACKUP_DIRECTORY="$(cd "$requested_directory" && pwd -P)"
  [ -w "$BACKUP_DIRECTORY" ] \
    || die "백업 디렉터기에 쓸 수 없습니다: $BACKUP_DIRECTORY"

  ARCHIVE="$BACKUP_DIRECTORY/$BACKUP_NAME.tar.gz"
  CHECKSUM="$BACKUP_DIRECTORY/$BACKUP_NAME.tar.gz.sha256"
}

set_shared_source() {
  local requested_directory="$1"

  [ -d "$requested_directory" ] \
    || die "공유 디렉터리가 없습니다: $requested_directory"

  SHARED_SOURCE="$(cd "$requested_directory" && pwd -P)" \
    || die "공유 디렉터리의 절대 경로를 확인할 수 없습니다: $requested_directory"
}

usage() {
  echo "사용법:"
  echo "  $0 backup <백업 디렉터리> <공유 디렉터리>   # 기존 컴퓨터에서 전체 백업"
  echo "  $0 restore <백업 디렉터리> <공유 디렉터리>  # 새 컴퓨터에서 전체 복원"
  echo
  echo "예:"
  echo "  $0 backup /Users/kst/Desktop /Users/kst/shared/cokacdircom"
  echo "  $0 restore /Users/kst/Desktop /Users/kst/shared/cokacdircom"
}

make_temp_root() {
  TEMP_ROOT="$(mktemp -d "$BACKUP_DIRECTORY/.${BACKUP_NAME}.XXXXXX")" \
    || die "임시 작업 디렉터리를 만들 수 없습니다: $BACKUP_DIRECTORY"
  WORKDIR="$TEMP_ROOT/$BACKUP_NAME"
}

cleanup_temp_root() {
  [ -n "${TEMP_ROOT:-}" ] || return 0

  case "$TEMP_ROOT" in
    "$BACKUP_DIRECTORY"/."$BACKUP_NAME".*)
      rm -rf "$TEMP_ROOT"
      TEMP_ROOT=""
      WORKDIR=""
      ;;
    *)
      echo "ERROR: 안전하지 않은 임시 경로는 삭제하지 않습니다: $TEMP_ROOT" >&2
      return 1
      ;;
  esac
}

verify_checksum() {
  local expected_hash checksum_filename actual_output actual_hash

  IFS=' ' read -r expected_hash checksum_filename < "$CHECKSUM" \
    || die "checksum 파일을 읽을 수 없습니다: $CHECKSUM"

  [ "${#expected_hash}" -eq 64 ] \
    || die "checksum 형식이 올바르지 않습니다: $CHECKSUM"
  case "$expected_hash" in
    *[!0-9a-fA-F]*) die "checksum 형식이 올바르지 않습니다: $CHECKSUM" ;;
  esac

  actual_output="$(shasum -a 256 "$ARCHIVE")"
  actual_hash="${actual_output%% *}"
  [ "$actual_hash" = "$expected_hash" ] \
    || die "백업 파일 checksum이 일치하지 않습니다: $ARCHIVE"

  echo "$(basename "$ARCHIVE"): OK"
}

validate_outer_archive() {
  local member

  tar tzf "$ARCHIVE" >/dev/null \
    || die "백업 압축파일을 읽을 수 없습니다: $ARCHIVE"

  while IFS= read -r member; do
    case "$member" in
      "$BACKUP_NAME"|"$BACKUP_NAME/"|"$BACKUP_NAME/"*) ;;
      *) die "백업 압축파일에 예상 범위 밖의 경로가 있습니다: $member" ;;
    esac

    case "$member" in
      /*|../*|*/../*|*/..)
        die "백업 압축파일에 안전하지 않은 경로가 있습니다: $member"
        ;;
    esac
  done < <(tar tzf "$ARCHIVE")
}

normalize_architecture() {
  case "$1" in
    aarch64|arm64) printf '%s\n' arm64 ;;
    x86_64|amd64) printf '%s\n' amd64 ;;
    *) printf '%s\n' "$1" ;;
  esac
}

docker_engine_platform() {
  local os architecture

  os="$(docker info --format '{{.OSType}}')"
  architecture="$(docker info --format '{{.Architecture}}')"
  architecture="$(normalize_architecture "$architecture")"
  printf '%s/%s\n' "$os" "$architecture"
}

image_platform() {
  docker image inspect -f '{{.Os}}/{{.Architecture}}' "$1"
}

validate_loaded_platforms() {
  local recorded_platform target_platform workmachine_platform
  local cloudflared_platform helper_platform

  recorded_platform="$(<"$WORKDIR/platform.txt")"
  target_platform="$(docker_engine_platform)"
  workmachine_platform="$(image_platform "$WORKMACHINE_IMAGE")"
  cloudflared_platform="$(image_platform "$CLOUDFLARED_IMAGE")"
  helper_platform="$(image_platform "$HELPER_IMAGE")"

  [ "$workmachine_platform" = "$recorded_platform" ] \
    || die "백업 기록과 load된 workmachine 이미지 플랫폼이 다릅니다: 기록=$recorded_platform, 이미지=$workmachine_platform"

  [ "$workmachine_platform" = "$target_platform" ] \
    || die "workmachine 이미지와 현재 Docker 플랫폼이 다릅니다: 이미지=$workmachine_platform, Docker=$target_platform"
  [ "$cloudflared_platform" = "$target_platform" ] \
    || die "cloudflared 이미지와 현재 Docker 플랫폼이 다릅니다: 이미지=$cloudflared_platform, Docker=$target_platform"
  [ "$helper_platform" = "$target_platform" ] \
    || die "Alpine helper 이미지와 현재 Docker 플랫폼이 다릅니다: 이미지=$helper_platform, Docker=$target_platform"

  echo "백업/현재 Docker 플랫폼: $target_platform"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker 명령을 찾을 수 없습니다."
  command -v curl >/dev/null 2>&1 || die "curl 명령을 찾을 수 없습니다."
  command -v shasum >/dev/null 2>&1 || die "shasum 명령을 찾을 수 없습니다."
  command -v tar >/dev/null 2>&1 || die "tar 명령을 찾을 수 없습니다."
  docker info >/dev/null 2>&1 || die "Docker가 실행 중이 아닙니다."
  docker compose version >/dev/null 2>&1 || die "docker compose를 사용할 수 없습니다."
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || true)" = "true" ]
}

container_env_value() {
  local container="$1"
  local variable="$2"
  local entry

  while IFS= read -r entry; do
    case "$entry" in
      "${variable}="*)
        printf '%s\n' "${entry#*=}"
        return 0
        ;;
    esac
  done < <(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container")

  return 1
}

validate_workmachine_mounts() {
  local mount_count state_mount shared_mount shared_source_canonical

  mount_count="$(docker inspect -f '{{len .Mounts}}' "$WORKMACHINE_CONTAINER")"
  [ "$mount_count" = "2" ] \
    || die "$WORKMACHINE_CONTAINER의 mount 수가 예상과 다릅니다. /shared와 /var/lib/cokacremote 외의 데이터는 백업되지 않습니다: $mount_count"

  state_mount="$(
    docker inspect -f \
      '{{range .Mounts}}{{if eq .Destination "/var/lib/cokacremote"}}{{printf "%s|%s|%t" .Type .Name .RW}}{{end}}{{end}}' \
      "$WORKMACHINE_CONTAINER"
  )"
  [ "$state_mount" = "volume|$STATE_VOLUME|true" ] \
    || die "$WORKMACHINE_CONTAINER의 /var/lib/cokacremote mount가 예상과 다릅니다: $state_mount"

  shared_source_canonical="$(cd "$SHARED_SOURCE" && pwd -P)"
  shared_mount="$(
    docker inspect -f \
      '{{range .Mounts}}{{if eq .Destination "/shared"}}{{printf "%s|%s|%t" .Type .Source .RW}}{{end}}{{end}}' \
      "$WORKMACHINE_CONTAINER"
  )"
  case "$shared_mount" in
    "bind|$SHARED_SOURCE|true"|\
    "bind|$shared_source_canonical|true"|\
    "bind|/host_mnt$SHARED_SOURCE|true"|\
    "bind|/host_mnt$shared_source_canonical|true")
      ;;
    *) die "$WORKMACHINE_CONTAINER의 /shared mount가 예상과 다릅니다: $shared_mount" ;;
  esac
}

restart_original() {
  local failed=0

  if [ "$WM_WAS_RUNNING" -eq 1 ] && ! container_running "$WORKMACHINE_CONTAINER"; then
    if ! docker start "$WORKMACHINE_CONTAINER" >/dev/null; then
      echo "ERROR: $WORKMACHINE_CONTAINER 재시작에 실패했습니다." >&2
      failed=1
    fi
  fi

  if [ "$CF_WAS_RUNNING" -eq 1 ] && ! container_running "$CLOUDFLARED_CONTAINER"; then
    if ! docker start "$CLOUDFLARED_CONTAINER" >/dev/null; then
      echo "ERROR: $CLOUDFLARED_CONTAINER 재시작에 실패했습니다." >&2
      failed=1
    fi
  fi

  return "$failed"
}

cleanup_backup_images() {
  local failed=0
  local current_image_id

  if [ "$WM_BACKUP_IMAGE_CREATED" -eq 1 ]; then
    current_image_id="$(docker image inspect -f '{{.Id}}' "$WORKMACHINE_IMAGE" 2>/dev/null || true)"
    if [ "$current_image_id" = "$WM_BACKUP_IMAGE_ID" ]; then
      docker image rm "$WORKMACHINE_IMAGE" >/dev/null 2>&1 || failed=1
    elif [ -n "$current_image_id" ]; then
      echo "ERROR: 백업 중 $WORKMACHINE_IMAGE 태그가 다른 이미지로 변경되어 건드리지 않습니다." >&2
      failed=1
    fi

    if [ -n "$WM_PREVIOUS_IMAGE_ID" ] \
      && ! docker image inspect "$WORKMACHINE_IMAGE" >/dev/null 2>&1; then
      docker image tag "$WM_PREVIOUS_IMAGE_ID" "$WORKMACHINE_IMAGE" >/dev/null 2>&1 \
        || failed=1
    fi
    WM_BACKUP_IMAGE_CREATED=0
  fi

  if [ "$CF_BACKUP_IMAGE_CREATED" -eq 1 ]; then
    current_image_id="$(docker image inspect -f '{{.Id}}' "$CLOUDFLARED_IMAGE" 2>/dev/null || true)"
    if [ "$current_image_id" = "$CF_BACKUP_IMAGE_ID" ]; then
      docker image rm "$CLOUDFLARED_IMAGE" >/dev/null 2>&1 || failed=1
    elif [ -n "$current_image_id" ]; then
      echo "ERROR: 백업 중 $CLOUDFLARED_IMAGE 태그가 다른 이미지로 변경되어 건드리지 않습니다." >&2
      failed=1
    fi

    if [ -n "$CF_PREVIOUS_IMAGE_ID" ] \
      && ! docker image inspect "$CLOUDFLARED_IMAGE" >/dev/null 2>&1; then
      docker image tag "$CF_PREVIOUS_IMAGE_ID" "$CLOUDFLARED_IMAGE" >/dev/null 2>&1 \
        || failed=1
    fi
    CF_BACKUP_IMAGE_CREATED=0
  fi

  return "$failed"
}

backup_exit_trap() {
  local status=$?
  local restart_status=0

  trap - EXIT INT TERM HUP
  set +e

  if [ "$ORIGINALS_MAY_NEED_RESTART" -eq 1 ]; then
    restart_original
    restart_status=$?
    if [ "$restart_status" -ne 0 ]; then
      echo "ERROR: 백업 종료 과정에서 원본 환경을 완전히 재시작하지 못했습니다." >&2
      [ "$status" -ne 0 ] || status=1
    fi
  fi

  cleanup_backup_images || [ "$status" -ne 0 ] || status=1
  cleanup_temp_root || [ "$status" -ne 0 ] || status=1
  exit "$status"
}

restore_exit_trap() {
  local status=$?

  trap - EXIT INT TERM HUP
  set +e
  cleanup_temp_root || [ "$status" -ne 0 ] || status=1
  exit "$status"
}

restore_diagnostics() {
  echo >&2
  echo "===== workmachine 최근 로그 =====" >&2
  docker logs --tail 100 "$WORKMACHINE_CONTAINER" >&2 || true
  echo "===== cloudflared 최근 로그 =====" >&2
  docker logs --tail 100 "$CLOUDFLARED_CONTAINER" >&2 || true
}

write_restore_compose() {
  cat > "$WORKDIR/compose.restore.yml" <<'YAML'
services:
  workmachine:
    image: workmachine-backup:latest
    container_name: workmachine
    hostname: workmachine
    restart: unless-stopped
    working_dir: /shared
    stop_grace_period: 30s
    volumes:
      - workmachine_cokacremote-state:/var/lib/cokacremote
      - type: bind
        source: ${WORKMACHINE_SHARED_SOURCE:?WORKMACHINE_SHARED_SOURCE is required}
        target: /shared

  cloudflared:
    image: cloudflared-backup:latest
    container_name: chatgpt-cloudflared
    restart: unless-stopped
    network_mode: "service:workmachine"
    depends_on:
      workmachine:
        condition: service_healthy

volumes:
  workmachine_cokacremote-state:
    external: true
    name: workmachine_cokacremote-state
YAML
}

backup() {
  need_docker

  docker container inspect "$WORKMACHINE_CONTAINER" >/dev/null 2>&1 \
    || die "$WORKMACHINE_CONTAINER 컨테이너가 없습니다."

  docker container inspect "$CLOUDFLARED_CONTAINER" >/dev/null 2>&1 \
    || die "$CLOUDFLARED_CONTAINER 컨테이너가 없습니다."

  docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1 \
    || die "$STATE_VOLUME 볼륨이 없습니다."

  [ -d "$SHARED_SOURCE" ] \
    || die "$SHARED_SOURCE 경로가 없습니다."

  validate_workmachine_mounts

  WM_ID="$(docker inspect -f '{{.Id}}' "$WORKMACHINE_CONTAINER")"
  CF_NETWORK_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CLOUDFLARED_CONTAINER")"
  case "$CF_NETWORK_MODE" in
    "container:$WM_ID"|"container:${WM_ID:0:12}"|"container:$WORKMACHINE_CONTAINER")
      ;;
    container:*)
      die "$CLOUDFLARED_CONTAINER가 현재 $WORKMACHINE_CONTAINER가 아닌 다른 컨테이너의 네트워크를 공유하고 있습니다: $CF_NETWORK_MODE"
      ;;
    *)
      die "$CLOUDFLARED_CONTAINER의 네트워크 모드가 예상과 다릅니다: $CF_NETWORK_MODE"
      ;;
  esac

  CF_MOUNT_COUNT="$(docker inspect -f '{{len .Mounts}}' "$CLOUDFLARED_CONTAINER")"
  [ "$CF_MOUNT_COUNT" = "0" ] \
    || die "$CLOUDFLARED_CONTAINER에 별도 mount가 있습니다. 불완전 백업을 막기 위해 중단합니다."

  MCP_PUBLIC_URL="$(container_env_value "$WORKMACHINE_CONTAINER" MCP_PUBLIC_URL)" \
    || die "$WORKMACHINE_CONTAINER에서 MCP_PUBLIC_URL을 찾을 수 없습니다."
  MCP_PUBLIC_URL="${MCP_PUBLIC_URL%/}"
  case "$MCP_PUBLIC_URL" in
    https://*) ;;
    *) die "MCP_PUBLIC_URL이 올바른 HTTPS URL이 아닙니다: $MCP_PUBLIC_URL" ;;
  esac

  [ ! -e "$ARCHIVE" ] \
    || die "기존 백업 파일을 덮어쓰지 않습니다. 먼저 옮기거나 이름을 바꾸세요: $ARCHIVE"
  [ ! -e "$CHECKSUM" ] \
    || die "기존 checksum 파일을 덮어쓰지 않습니다. 먼저 옮기거나 이름을 바꾸세요: $CHECKSUM"

  WM_PREVIOUS_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$WORKMACHINE_IMAGE" 2>/dev/null || true)"
  CF_PREVIOUS_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$CLOUDFLARED_IMAGE" 2>/dev/null || true)"

  if ! docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1; then
    docker pull "$HELPER_IMAGE"
  fi

  make_temp_root
  trap backup_exit_trap EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  mkdir -p "$WORKDIR"

  WM_WAS_RUNNING=0
  CF_WAS_RUNNING=0

  if container_running "$WORKMACHINE_CONTAINER"; then
    WM_WAS_RUNNING=1
  fi

  if container_running "$CLOUDFLARED_CONTAINER"; then
    CF_WAS_RUNNING=1
  fi

  ORIGINALS_MAY_NEED_RESTART=1

  echo "[1/8] 컨테이너 정지"
  if [ "$CF_WAS_RUNNING" -eq 1 ]; then
    docker stop "$CLOUDFLARED_CONTAINER" >/dev/null
  fi
  if [ "$WM_WAS_RUNNING" -eq 1 ]; then
    docker stop "$WORKMACHINE_CONTAINER" >/dev/null
  fi

  echo "[2/8] workmachine 현재 상태 이미지화"
  WM_BACKUP_IMAGE_ID="$(docker commit "$WORKMACHINE_CONTAINER" "$WORKMACHINE_IMAGE")"
  WM_BACKUP_IMAGE_CREATED=1

  echo "[3/8] cloudflared 현재 상태 이미지화"
  CF_BACKUP_IMAGE_ID="$(docker commit "$CLOUDFLARED_CONTAINER" "$CLOUDFLARED_IMAGE")"
  CF_BACKUP_IMAGE_CREATED=1

  echo "[4/8] 이미지 저장"
  docker save -o "$WORKDIR/workmachine-image.tar" "$WORKMACHINE_IMAGE"
  docker save -o "$WORKDIR/cloudflared-image.tar" "$CLOUDFLARED_IMAGE"
  docker save -o "$WORKDIR/alpine-image.tar" "$HELPER_IMAGE"

  echo "[5/8] /var/lib/cokacremote 볼륨 백업"
  docker run --rm \
    -v "$STATE_VOLUME:/data:ro" \
    -v "$WORKDIR:/backup" \
    "$HELPER_IMAGE" \
    tar czpf /backup/cokacremote-state.tar.gz -C /data .

  echo "[6/8] 설정/검증 정보 저장"
  docker inspect "$WORKMACHINE_CONTAINER" > "$WORKDIR/workmachine-inspect.json"
  docker inspect "$CLOUDFLARED_CONTAINER" > "$WORKDIR/cloudflared-inspect.json"
  docker volume inspect "$STATE_VOLUME" > "$WORKDIR/cokacremote-state-volume-inspect.json"
  docker image inspect -f '{{.Os}}/{{.Architecture}}' "$WORKMACHINE_IMAGE" \
    > "$WORKDIR/platform.txt"

  printf '%s\n' "$MCP_PUBLIC_URL" > "$WORKDIR/mcp-public-url.txt"

  write_restore_compose
  WORKMACHINE_SHARED_SOURCE="$SHARED_SOURCE" \
    docker compose -p workmachine -f "$WORKDIR/compose.restore.yml" config >/dev/null
  chmod -R go-rwx "$WORKDIR"

  echo "[7/8] 기존 환경 다시 시작"
  if ! restart_original; then
    die "원본 환경을 완전히 재시작하지 못했습니다."
  fi
  ORIGINALS_MAY_NEED_RESTART=0

  echo "[8/8] 백업 파일 하나로 묶기"
  ARCHIVE_TMP="$TEMP_ROOT/$BACKUP_NAME.tar.gz"
  CHECKSUM_TMP="$TEMP_ROOT/$BACKUP_NAME.tar.gz.sha256"

  tar czf "$ARCHIVE_TMP" \
    -C "$TEMP_ROOT" \
    "$BACKUP_NAME"

  (
    cd "$TEMP_ROOT"
    shasum -a 256 "$BACKUP_NAME.tar.gz" > "$BACKUP_NAME.tar.gz.sha256"
  )
  chmod 600 "$ARCHIVE_TMP" "$CHECKSUM_TMP"

  [ ! -e "$ARCHIVE" ] \
    || die "백업 도중 같은 이름의 파일이 생성되어 덮어쓰지 않습니다: $ARCHIVE"
  [ ! -e "$CHECKSUM" ] \
    || die "백업 도중 같은 이름의 파일이 생성되어 덮어쓰지 않습니다: $CHECKSUM"

  mv "$ARCHIVE_TMP" "$ARCHIVE"
  if ! mv "$CHECKSUM_TMP" "$CHECKSUM"; then
    rm -f "$ARCHIVE"
    die "checksum 파일을 최종 위치로 이동하지 못했습니다."
  fi

  cleanup_backup_images \
    || die "임시 백업 이미지 태그를 원래 상태로 되돌리지 못했습니다."
  cleanup_temp_root
  trap - EXIT INT TERM HUP

  echo
  echo "백업 완료:"
  echo "  $ARCHIVE"
  echo "  $CHECKSUM"
  echo
  echo "주의: 백업에는 OAuth 상태/키와 Cloudflare Tunnel 인증정보가 포함될 수 있습니다."
}

confirm_replace() {
  FOUND=0

  if docker container inspect "$WORKMACHINE_CONTAINER" >/dev/null 2>&1; then
    FOUND=1
  fi
  if docker container inspect "$CLOUDFLARED_CONTAINER" >/dev/null 2>&1; then
    FOUND=1
  fi
  if docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1; then
    FOUND=1
  fi

  if [ "$FOUND" -eq 1 ]; then
    echo "기존 workmachine 관련 컨테이너 또는 볼륨이 존재합니다."
    echo "복원을 계속하면 해당 컨테이너와 $STATE_VOLUME 볼륨을 삭제하고 백업본으로 교체합니다."
    printf "계속하려면 RESTORE 를 입력하세요: "
    read -r ANSWER || die "복원 확인 입력을 읽을 수 없습니다."
    [ "$ANSWER" = "RESTORE" ] || die "복원을 취소했습니다."
  fi
}

restore() {
  need_docker

  [ -f "$ARCHIVE" ] || die "$ARCHIVE 파일이 없습니다."
  [ -f "$CHECKSUM" ] || die "$CHECKSUM 파일이 없습니다. checksum 없이는 복원하지 않습니다."
  [ -d "$SHARED_SOURCE" ] || die "$SHARED_SOURCE 경로가 준비되어 있지 않습니다."
  chmod 600 "$ARCHIVE" "$CHECKSUM"

  echo "[1/11] 백업 파일 무결성 확인"
  verify_checksum

  echo "[2/11] 안전한 임시 디렉터리에 백업 압축 해제"
  make_temp_root
  trap restore_exit_trap EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  validate_outer_archive
  tar xzf "$ARCHIVE" -C "$TEMP_ROOT"
  [ -d "$WORKDIR" ] \
    || die "$BACKUP_NAME 디렉터리가 백업 안에 없습니다."
  chmod -R go-rwx "$WORKDIR"

  echo "[3/11] 백업 구성파일 확인"
  [ -f "$WORKDIR/workmachine-image.tar" ] \
    || die "workmachine-image.tar가 백업 안에 없습니다."
  [ -f "$WORKDIR/cloudflared-image.tar" ] \
    || die "cloudflared-image.tar가 백업 안에 없습니다."
  [ -f "$WORKDIR/alpine-image.tar" ] \
    || die "alpine-image.tar가 백업 안에 없습니다."
  [ -f "$WORKDIR/cokacremote-state.tar.gz" ] \
    || die "cokacremote-state.tar.gz가 백업 안에 없습니다."
  [ -f "$WORKDIR/compose.restore.yml" ] \
    || die "compose.restore.yml이 백업 안에 없습니다."
  [ -f "$WORKDIR/mcp-public-url.txt" ] \
    || die "mcp-public-url.txt가 백업 안에 없습니다."
  [ -f "$WORKDIR/platform.txt" ] \
    || die "platform.txt가 백업 안에 없습니다."

  MCP_PUBLIC_URL="$(<"$WORKDIR/mcp-public-url.txt")"
  case "$MCP_PUBLIC_URL" in
    https://*) ;;
    *) die "백업의 MCP_PUBLIC_URL이 올바른 HTTPS URL이 아닙니다: $MCP_PUBLIC_URL" ;;
  esac

  confirm_replace

  echo "[4/11] Docker 이미지 load"
  docker load -i "$WORKDIR/alpine-image.tar"
  docker load -i "$WORKDIR/workmachine-image.tar"
  docker load -i "$WORKDIR/cloudflared-image.tar"

  echo "[5/11] 이미지 및 플랫폼 사전검증"
  validate_loaded_platforms
  docker run --rm --pull never "$HELPER_IMAGE" true
  docker run --rm --pull never --entrypoint /bin/true "$WORKMACHINE_IMAGE"
  docker run --rm --pull never "$CLOUDFLARED_IMAGE" version >/dev/null

  echo "[6/11] Compose, 공유 경로 및 상태 백업 사전검증"
  WORKMACHINE_SHARED_SOURCE="$SHARED_SOURCE" \
    docker compose \
      -p workmachine \
      -f "$WORKDIR/compose.restore.yml" \
      config >/dev/null
  docker run --rm --pull never \
    -v "$SHARED_SOURCE:/shared:ro" \
    "$HELPER_IMAGE" \
    test -d /shared
  docker run --rm --pull never \
    -v "$WORKDIR:/backup:ro" \
    "$HELPER_IMAGE" \
    tar tzf /backup/cokacremote-state.tar.gz >/dev/null

  echo "[7/11] 기존 workmachine 환경 제거"
  if docker container inspect "$CLOUDFLARED_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$CLOUDFLARED_CONTAINER" >/dev/null \
      || die "$CLOUDFLARED_CONTAINER 컨테이너를 삭제할 수 없습니다."
  fi
  if docker container inspect "$WORKMACHINE_CONTAINER" >/dev/null 2>&1; then
    docker rm -f "$WORKMACHINE_CONTAINER" >/dev/null \
      || die "$WORKMACHINE_CONTAINER 컨테이너를 삭제할 수 없습니다."
  fi

  if docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1; then
    docker volume rm "$STATE_VOLUME" >/dev/null \
      || die "$STATE_VOLUME 볼륨을 삭제할 수 없습니다. 다른 컨테이너에서 사용 중인지 확인하세요."
  fi

  echo "[8/11] /var/lib/cokacremote 볼륨 생성"
  docker volume create "$STATE_VOLUME" >/dev/null

  echo "[9/11] /var/lib/cokacremote 내용 복원"
  docker run --rm \
    -v "$STATE_VOLUME:/data" \
    -v "$WORKDIR:/backup:ro" \
    "$HELPER_IMAGE" \
    tar xzpf /backup/cokacremote-state.tar.gz -C /data

  echo "[10/11] workmachine + cloudflared를 Compose 프로젝트로 시작"
  WORKMACHINE_SHARED_SOURCE="$SHARED_SOURCE" \
    docker compose \
      -p workmachine \
      -f "$WORKDIR/compose.restore.yml" \
      up -d \
      --no-build \
      --pull never

  echo "[11/11] 상태 확인"
  HEALTH=""
  COUNT=0
  while [ "$COUNT" -lt 60 ]; do
    HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$WORKMACHINE_CONTAINER" 2>/dev/null || true)"
    if [ "$HEALTH" = "healthy" ]; then
      break
    fi
    sleep 1
    COUNT=$((COUNT + 1))
  done

  if [ "$HEALTH" != "healthy" ]; then
    restore_diagnostics
    die "workmachine이 제한 시간 안에 healthy 상태가 되지 않았습니다: $HEALTH"
  fi

  CLOUDFLARED_STATUS="$(docker inspect -f '{{.State.Status}}' "$CLOUDFLARED_CONTAINER" 2>/dev/null || true)"
  if [ "$CLOUDFLARED_STATUS" != "running" ]; then
    restore_diagnostics
    die "cloudflared가 running 상태가 아닙니다: $CLOUDFLARED_STATUS"
  fi

  PUBLIC_HEALTH_URL="${MCP_PUBLIC_URL%/}/health"
  PUBLIC_HEALTH_OK=0
  COUNT=0
  while [ "$COUNT" -lt 30 ]; do
    if PUBLIC_HEALTH_BODY="$(
      curl -fsS \
        --connect-timeout 3 \
        --max-time 5 \
        -H 'Cache-Control: no-cache' \
        "${PUBLIC_HEALTH_URL}?migration_check=$(date +%s)" \
        2>/dev/null
    )"; then
      case "$PUBLIC_HEALTH_BODY" in
        *'"status":"ok"'*)
          PUBLIC_HEALTH_OK=1
          break
          ;;
      esac
    fi
    sleep 2
    COUNT=$((COUNT + 1))
  done

  if [ "$PUBLIC_HEALTH_OK" -ne 1 ]; then
    restore_diagnostics
    die "Cloudflare Tunnel을 통한 공개 health 확인에 실패했습니다: $PUBLIC_HEALTH_URL"
  fi

  echo
  docker ps --filter "name=workmachine" --filter "name=chatgpt-cloudflared"
  echo
  echo "workmachine 상태: $HEALTH"
  echo "cloudflared 상태: $CLOUDFLARED_STATUS"
  echo "공개 health 확인: $PUBLIC_HEALTH_URL"

  cleanup_temp_root
  trap - EXIT INT TERM HUP
  echo "복원 완료."
}

case "${1:-}" in
  backup)
    [ "$#" -eq 3 ] || { usage; exit 1; }
    set_backup_directory "$2"
    set_shared_source "$3"
    backup
    ;;
  restore)
    [ "$#" -eq 3 ] || { usage; exit 1; }
    set_backup_directory "$2"
    set_shared_source "$3"
    restore
    ;;
  *)
    usage
    exit 1
    ;;
esac
