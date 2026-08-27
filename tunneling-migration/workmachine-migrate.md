# workmachine 백업·복원 사용법

## 준비

- Docker Desktop을 실행합니다.
- 백업 디렉터리와 `/shared`로 연결할 공유 디렉터리를 미리 만듭니다.
- `/shared`의 파일은 백업에 포함되지 않으므로 별도로 새 컴퓨터에 준비해야 합니다.
- 복원 대상 Docker는 백업한 Docker 이미지와 같은 CPU 아키텍처여야 합니다.

처음 한 번 실행 권한을 줍니다.

```bash
chmod +x workmachine-migrate.sh
```

## 백업

```bash
./workmachine-migrate.sh backup <백업 디렉터리> <공유 디렉터리>
```

예:

```bash
./workmachine-migrate.sh backup \
  /Users/kst/Desktop \
  /Users/kst/shared/cokacdircom
```

백업 디렉터리에 다음 두 파일이 생성됩니다.

```text
workmachine-full-backup.tar.gz
workmachine-full-backup.tar.gz.sha256
```

같은 이름의 파일이 이미 있으면 덮어쓰지 않고 중단합니다.

## 복원

새 컴퓨터에 다음 항목을 준비합니다.

- `workmachine-migrate.sh`
- `workmachine-full-backup.tar.gz`
- `workmachine-full-backup.tar.gz.sha256`
- `/shared`로 연결할 공유 디렉터리와 그 데이터

기존 컴퓨터의 `workmachine`과 `chatgpt-cloudflared`를 종료한 뒤 실행합니다.

```bash
./workmachine-migrate.sh restore <백업 디렉터리> <공유 디렉터리>
```

예:

```bash
./workmachine-migrate.sh restore \
  /Users/kst/Desktop \
  /Users/kst/shared/cokacdircom
```

복원 대상에 기존 컨테이너나 볼륨이 있으면 삭제 확인을 요청합니다. 계속하려면 정확히 `RESTORE`를 입력해야 합니다.

## 주의

백업 파일에는 OAuth 키와 Cloudflare Tunnel 인증정보가 포함될 수 있습니다. 비밀번호 파일처럼 안전하게 보관하세요.
