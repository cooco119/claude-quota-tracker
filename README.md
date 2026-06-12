# quota-tracker

Claude Max20 한도(5h 세션 / 주간 all-models / 주간 Sonnet)를 시계열로 기록·시각화하고,
윈도우를 다 못 쓸 것 같으면 macOS 알림으로 넛지하는 개인용 도구.

`claude -p "/usage"` 출력을 5분마다 폴링해 SQLite에 정규화 저장하고,
burn-rate를 추정해 reset 시점 사용률을 예측한다.

## 구성

```
src/
  types.ts        WindowKey / WindowReading / UsageProvider 인터페이스
  parser.ts       /usage 출력 3줄 → pct·reset epoch 파싱 (raw 항상 보존)
  store.ts        SQLite (node:sqlite). snapshots + window_readings. 임포트 가능 라이브러리
  forecast.ts     burn-rate r 추정 → U + r·T 예측. 임포트 가능 라이브러리
  notify.ts       넛지 결정(순수 함수) + osascript 알림. quiet hours + 쿨다운
  poller.ts       launchd 엔트리: providers → store → forecast → notify → latest.json
  menubar.ts      SwiftBar 렌더러 (latest.json + quota.db만 읽음, claude 호출 없음)
  providers/      ClaudeProvider. codex/antigravity는 인터페이스 시임만(미구현)
menubar/usage.1m.sh             SwiftBar 플러그인 래퍼
launchd/com.jaejun.quota-tracker.poller.plist   StartInterval=300
config.json       넛지 모드 토글/임계값/quiet hours
data/             quota.db, latest.json, notify-state.json, 로그 (gitignored)
```

## 설치 (node 런처 — 권장)

```bash
npm install
bash scripts/setup.sh    # build + install
```

`scripts/setup.sh`(= `npm run build && node dist/cli.js install`) 한 번으로:
- 컴파일된 `dist`를 `~/.quota-tracker/lib/dist`로 복사하고, 시스템 node로 실행하는
  런처를 `~/.local/bin/quota`에 설치
- launchd 에이전트 등록 (5분 폴링, node 직접 실행, 기존 동일 라벨 교체)
- SwiftBar 미설치 시 brew로 설치 + 플러그인 연결 + 실행
- config/data는 `~/.quota-tracker/` (`quota paths`로 확인, `QUOTA_TRACKER_HOME`으로 변경)

요구사항: Node 22.5+ (`node:sqlite` 내장), `claude` CLI 로그인, macOS.
해제는 `quota uninstall` (데이터 보존).

> 왜 단일 바이너리(SEA)가 아니라 런처인가: ad-hoc 서명된 ~127MB SEA Mach-O는 `cp`로
> 설치하면 서명 연결이 깨져 Apple Silicon 커널이 SIGKILL(`Killed: 9` / exit 137)로
> 죽인다. node가 이미 필수 의존성이라 런처가 더 가볍고 견고하다. 그래도 단일 바이너리가
> 필요하면 `scripts/build-binary.sh`로 `build/quota`를 구울 수 있다(설치엔 미사용).

## Claude Code 연동 (skill + hook plugin)

Claude Code가 `quota` CLI를 쓰도록 하는 두 부분이 `claude-plugin/`에 패키징되어 있다:

- **skill** (`claude-plugin/skills/quota-tracker/SKILL.md`): Claude가 사용량 조회·야간
  예약·대시보드 열기를 할 수 있게 한다. `~/.claude/skills/quota-tracker/`에도 설치돼 있다.
- **hook** (`claude-plugin/hooks/`): `UserPromptSubmit`에서 `quota hint`를 실행해, 세션
  윈도우가 임계값(기본 70%) 이상이면 한 줄 넛지를 컨텍스트에 주입한다 — Claude가 무거운
  작업을 야간 예약하도록 능동 제안할 수 있게. 캐시된 사용량만 읽어 쿼터를 소모하지 않는다.

### 플러그인 설치

이 레포는 Claude Code 마켓플레이스다(`.claude-plugin/marketplace.json`). 플러그인으로 설치:

```
/plugin marketplace add cooco119/claude-quota-tracker     # 또는 로컬 경로
/plugin install quota-tracker@quota-tracker-marketplace
```

> 플러그인은 **Claude 연동(skill + hook)만** 제공한다. 실제 사용량 추적·야간 실행은
> `quota` CLI/데몬이 필요하므로, 플러그인과 별개로 한 번 `bash scripts/setup.sh`를
> 실행해 CLI·launchd를 설치해야 한다. 훅의 `quota hint`도 CLI가 있어야 동작한다.

수동으로 훅만 켜려면 `~/.claude/settings.json`의 `hooks.UserPromptSubmit`에
`claude-plugin/hooks/quota-nudge.sh`를 등록하면 된다.

## 설치 (개발 모드)

```bash
cd quota-tracker
npm install
npm run build       # → dist/
```

요구사항: Node 22.5+ (`node:sqlite` 내장), `claude` CLI 로그인 상태, macOS.
개발 모드에서 config/data는 저장소 안(`config.json`은 gitignore, `config.example.json` 참조).

## launchd / SwiftBar 등록

**`quota install`이 둘 다 자동으로 처리한다** — launchd 폴러 등록(5분 주기, node 직접 실행,
경로는 설치 시점에 절대경로로 채워짐)과 SwiftBar 플러그인 연결·실행까지. 별도 수동 단계는
필요 없다. 해제는 `quota uninstall`.

수동으로 하려면 `launchd/com.quota-tracker.poller.plist.template`의 플레이스홀더
(`__NODE__`/`__CLI__`/`__HOME__`/`__PATH__`)를 채워 `~/Library/LaunchAgents/`에 두고
`launchctl bootstrap gui/$(id -u) <plist>`. SwiftBar는 `~/.quota-tracker/plugins/usage.1m.sh`를
플러그인 폴더로 지정하면 된다.

메뉴바:
- 글랜스: 가장 급한 윈도우 — `CQ 5h 13%` (사용률/남은시간 비율이 가장 높은 것)
- 드롭다운: 3종 윈도우 각각 현재 % → reset 예측, reset 시각, 스파크라인, Open Dashboard
- 플러그인은 `latest.json`·`quota.db`만 읽고 claude를 호출하지 않는다.
- 로그: `~/.quota-tracker/data/poller.log`, `poller.err.log`.

## 넛지 설정 (config.json)

| 모드 | 기본 | 의미 |
|---|---|---|
| `underUse` | **ON** | reset 시점 예측 사용률이 `thresholdPct`(80) 미만 — "이 윈도우를 다 못 쓸 것 같다" |
| `overUse` | OFF | 예측 사용률이 `thresholdPct`(100) 이상 — reset 전 소진 위험 |
| `scheduleHint` | OFF | 세션 윈도우가 신선하고(<20%) 절반 이상 남음 — 헤비 작업 적기 |

공통: `cooldownMinutes`(기본 120, 같은 윈도우+모드 중복 알림 방지),
`quietHours`(기본 23:00–08:00, 알림 억제),
`minElapsedFraction`(기본 0.25, 윈도우 초반의 노이즈 낀 under-use 발화 방지).

## 설계 결정: 5분 cadence는 안전한가

2026-06-11 측정: `claude -p "/usage"`를 약 20초 간격으로 3회 호출했을 때
session/weekly 사용률이 전혀 증가하지 않았다(12/16/11% 고정, reset 시각만 분 표시
반올림으로 이동). `/usage`는 모델 토큰을 소모하지 않는 메타데이터 조회로 판단되어
**5분 cadence(StartInterval=300)를 그대로 유지**한다. 호출당 ~2초.

## 예측(forecast) 방식

- 최근 히스토리(현재 윈도우 내 — pct가 떨어진 지점 이후)가 2점 이상이고
  **30분 이상의 시간 폭**을 가질 때 최소제곱 기울기로 burn-rate r을 추정,
  `U + r·T`로 reset 시점 사용률 예측. (사용률이 정수 단위라 짧은 폭에서는
  13%→14%가 60%/h로 보이는 노이즈가 생긴다.)
- 히스토리 부족 시 윈도우 시작(`reset - duration`)부터 현재까지의 선형 폴백.
- 예측치는 현재 사용률 밑으로 내려가지 않는다(사용률은 단조 증가).

## 테스트

```bash
npm test            # vitest: parser(포맷 변형 픽스처)/forecast(합성 히스토리)/store(in-memory)/notify(발화·비발화)
npm run typecheck
```

---

# Part B: 태스크 오케스트레이터

태스크를 큐에 등록하면 야간 시간대에 무인으로 `claude -p`를 실행하고,
작업 사이즈 추정 대비 실제 토큰 사용량을 첫날부터 누적한다.
**모든 작업은 스케줄러를 경유한다** — 스케줄링이 무의미한 수동 실행도
동일 경로를 타게 해 estimation 데이터에 선택 편향을 없앤다.

## 태스크 등록

```bash
npm run enqueue
```

대화형으로 프롬프트/디렉토리/사이즈(xs~xl)/우선순위/연기 가능 여부를 받고,
**권한 triage**를 거친다:

| 분류 | 권한모드 | 무인 실행 |
|---|---|---|
| read-only | `default` + 읽기 전용 도구 allowlist | 가능 |
| write-scoped | `acceptEdits` + git worktree 격리 | 가능 |
| destructive (삭제·push·외부 발신) | — | **불가** (수동 전용) |

무인 가능 태스크는 "권한모드 X로 무인 실행됩니다" 컨펌을 받아야 등록된다.
destructive 태스크는 `npm run executor -- --task <id>`로 사용자가 보는 앞에서만 실행.

### 비대화형 등록 (`--night`)

스크립트·핫키에서 한 줄로 등록하고 **야간 윈도우의 사용량 최저 시간에 자동 실행**:

```bash
quota enqueue --night --prompt "..." --size xs --perm read-only [--cwd PATH] [--priority N]
```

`--night`는 무인 야간 실행에 대한 명시적 opt-in이므로 night window를 자동 컨펌한다.

실행 시각 결정 (executor 설정):
- **`nightFloorHHMM`** (기본 `"02:00"`): 야간 태스크가 실행될 수 있는 가장 이른 로컬
  시각. night window는 23:00에 열리지만, 아직 작업 중일 수 있는 초저녁을 피하려고
  실행은 이 시각(기본 새벽 2시) 이후 첫 기회까지 보류한다.
- **`lowUsageMinDays`** (기본 3): 이만큼의 데이터가 쌓이면, 바닥 시각 이후 구간 중
  `window_readings`에서 **세션 번레이트가 가장 낮은 시간**을 자동으로 골라 실행한다.
  데이터가 부족하면 바닥 시각(2시)에 실행한다.

즉 데이터가 없을 땐 새벽 2시에, 누적될수록 2시 이후 가장 한가한 시간으로 수렴한다.

> **destructive 수동 실행의 한계**: 수동 실행도 estimation 일관성을 위해 headless
> (`claude -p`)로 돌므로 대화형 권한 승인이 불가능하다. `acceptEdits`로 파일 수정까지는
> 진행되지만 그 이상의 권한이 필요한 도구는 **fail-closed로 거부**되고, 거부 횟수가
> 기록되며 해당 run은 성공으로 치지 않는다. 진짜 destructive 작업은 claude를 직접
> 대화형으로 여는 것이 맞다 — 이 큐는 그런 작업의 저장소 역할까지만 한다.

연기 가능 여부(deferOk)는 슬롯 기록용이다: `night` 슬롯이든 `any` 슬롯이든 무인 가능
태스크는 야간 executor가 집행한다(`any` ⊃ `night`). deferOk=false는 "야간까지 기다리지
말라"는 뜻이므로 수동 실행(`--task`)을 권장하는 표시일 뿐 야간 집행을 막지 않는다.

## night window

첫 야간 태스크 등록 때 **night window(기본 23:00–08:00, quietHours에서 파생)와
현재 타임존을 1회 컨펌**받는다. 컨펌 전까지 야간 배치는 전면 거부된다.
config의 `nightWindow.{start,end}`는 머신 로컬 wall-clock이라 DST/이동에 강건하고,
타임존이 바뀌면 재컨펌을 요구한다. 직접 수정 가능:

```json
"nightWindow": { "start": "23:00", "end": "08:00", "confirmedAt": "...", "confirmedTz": "Asia/Seoul" }
```

## executor 동작

별도 launchd 에이전트 없이 **기존 poller가 5분 틱마다 게이트를 평가**하고,
전부 통과하면 detached 프로세스(`dist/executor.js`)를 발사한다(긴 태스크가
폴링을 막지 않도록). 게이트 체인:

1. `executor.enabled` ON
2. 현재 시각이 night window 안
3. night window 컨펌됨 + 타임존 일치
4. latest.json 신선(2×폴 주기 이내)
5. **window guard** — 세션 % ≥ `sessionGuardPct`(80)면 reset까지 정지(제약: 세션 우선),
   주간 % ≥ `weeklyGuardPct`(95)면 정지(주간은 채우기 목표라 관대 — 비대칭)
6. 무인 가능한 대기 태스크 존재, 실행 중 태스크 없음

executor는 태스크마다 게이트를 재평가하며 큐를 소화하고, 윈도 종료·guard 정지·큐
소진 시 스스로 종료한다. 실패 태스크는 이월(`carried_over`)되며 `maxAttempts`(3)
도달 시 `failed`로 종착한다(크래시로 죽은 태스크의 복구 경로에도 동일 적용).
사이즈별 타임아웃(`taskTimeoutMinutes`: xs 5분 ~ xl 60분, SIGKILL로 강제 종료).

견고성 장치: 단일 인스턴스 락파일(`data/executor.lock`), claim 직후 2분 grace로
이중 실행 방지, 사이즈 타임아웃이 night window 잔여 시간을 넘는 태스크는 claim하지
않음(아침 시간대 overrun 방지), SQLite `busy_timeout` 5초(poller/executor/enqueue
동시 쓰기), 타임존 변경으로 야간 배치가 정지하면 12시간 쿨다운으로 macOS 알림.

## 토큰 실측 기록

`claude -p --output-format json` 결과에서 토큰·비용·모델·session_id를 **직접**
추출해 `task_runs`에 기록한다(% 델타 역산 없음). 발사 시점 세션/주간 %도 감사
컬럼으로 남는다. estimate vs actual 조회:

```ts
import { Store } from "./dist/store.js";
new Store("data/quota.db").estimationRecords();
// [{ taskId, size, estimateTokens, actualTokens, model, durationMs, result }]
```

## 슬립 대응 (선택)

launchd `StartInterval`은 **잠자는 동안 발화하지 않는다**. 야간 실행을 쓰려면
머신이 깨어 있어야 한다 — 운영 전제이며 quota-tracker는 wake를 보장하지 않는다.
선택 사항:

```bash
# 전원 연결 시 슬립 방지 (가장 단순)
sudo pmset -c sleep 0
# 또는 특정 시간 wake 스케줄
sudo pmset repeat wake MTWRFSU 23:00:00
# 또는 세션 단위 유지
caffeinate -dims
```

깨어 있지 못해 놓친 슬롯의 태스크는 다음 night window로 자연 이월된다.

## 웹 대시보드

SwiftBar 드롭다운의 **Open Dashboard**를 누르면 브라우저에 사용 통계 대시보드가 뜬다
(또는 `quota dashboard --open`). 멱등 기동 — 이미 떠 있으면 재기동 없이 브라우저만 연다.

- **HERO**: 3윈도우 반원 게이지(현재 % + 예측 + "100% by HH:MM · resets …"), 7일 비용/토큰/실행 KPI.
- **모델별 사용량** (tokscale 스타일): 모델별 비용 가로 막대 + 토큰 카테고리
  100% 스택바(input/output/cache-create/cache-read 4색).
- **활동 히트맵**: GitHub 컨트리뷰션 그래프(일별 토큰).
- **윈도우 추이**: 3윈도우 사용률 시계열(reset 톱니 + 예측 점선).
- **추정 정확도**: 사이즈별 실측/추정 비율(오케스트레이터 보정 피드백).
- **큐 상태**: 대기/실행중/완료/이월/실패 카운트.

전부 `node:http` + 인라인 SVG로 그려 외부 의존성·CDN이 0이라 바이너리에 그대로 내장된다.
`127.0.0.1`만 바인드(인증 불필요), config의 `dashboard.port`(기본 47600)·`dashboard.idleShutdownMin`로
조정. 데이터는 `task_runs`(quota-tracker가 실행한 태스크) 기준이라 전체 Claude 사용량이 아니다.

## 잔여물 정리

write-scoped 태스크의 worktree는 검증용으로 `data/worktrees/`에 남는다.
주기적으로 `git worktree remove <path>`(또는 디렉토리 삭제 후
`git worktree prune`)로 정리할 것.

---

## 범위

Part A: `store`/`forecast`는 임포트 가능한 라이브러리로 노출되어 있다.
codex/antigravity provider는 `providers/index.ts`의 시임 주석만 있고 구현하지 않았다.

Part B: 통계 기반 슬롯 선택, eviction/선점(스키마의 `priority`·`resume_session_id`
필드만 선반영), %↔토큰 회귀 엔진, 웹 대시보드는 다음 단계로 남겨 두었다 —
데이터가 쌓이도록 기록 스키마만 갖춰져 있다.
