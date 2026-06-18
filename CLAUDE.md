# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 명령어

```bash
npm run dev          # 개발 빌드 (HMR, localhost 권한 포함)
npm run build        # 로컬/스테이징 빌드 (localhost:8000 권한 포함)
npm run build:prod   # 프로덕션 빌드 (localhost 권한 없음)
npx tsc --noEmit     # 타입 체크만
npm run icons        # 아이콘 재생성
```

빌드 후 Chrome `chrome://extensions` → 개발자 모드 → `dist/` 폴더 로드. 코드 변경 시 확장 새로고침 + 해당 탭 새로고침 필요 (content script는 탭 새로고침 없이 반영 안 됨).

## 아키텍처

MV3 Chrome 확장으로 4개의 독립 실행 컨텍스트가 메시지로 통신한다.

```
popup ──┐
        ├──(RequestMessage)──→ background SW ──→ Kaptik 서버
content ─┘        │
    ↑              └──(BroadcastMessage)──→ content
    │                                           │
offscreen ←── tabCapture ────────────────────── │ (라이브만)
```

**메시지 규약**: `src/shared/messaging.ts`가 단일 진실 소스. `RequestMessage`(content/popup → background), `ResponseMessage`(동기 응답), `BroadcastMessage`(background → content 단방향) 세 종류.

### Background (`src/background/index.ts`)

서비스 워커. 자막 생성 Job 관리, WebSocket 스트리밍 세션, 탭 캐시 담당.

- **`generationStore.ts`**: `chrome.storage.local`로 Job 상태 추적 (`kaptik:jobs`, `kaptik:available`, `kaptik:cues_ready`, `kaptik:gen_lang`). `gen_lang`이 핵심 — 어떤 언어로 생성했는지 기록해 언어 불일치 시 "none"으로 처리함.
- **언어 race condition 패턴**: `GET_STATUS`, `START_GENERATION`, `START_STREAMING` 메시지는 모두 `language?` 필드를 받아 `getSettings().language`보다 우선 사용한다. 팝업이 `patch({ language })` (비동기 storage 저장)와 동시에 메시지를 보내기 때문.

### Content Script (`src/content/index.tsx`)

`SubtitleController` 단일 클래스가 자막 UI 생명주기 전체를 관리.

- **`evaluate()`**: 현재 URL/상태에 맞게 마운트/언마운트 결정. `evaluating` 플래그로 중복 실행 방지. 1500ms 주기 + URL 변경 + 설정 변경 시 호출됨.
- **`requestStatus` 호출 시 반드시 `this.settings.language`를 전달**해야 함. `onSettingsChanged`가 즉시 `this.settings`를 업데이트하므로 storage 저장 완료 전에도 올바른 언어 기준으로 상태를 체크할 수 있다.
- **언어 변경 시 흐름**: `onSettingsChanged` → `teardown()` → `evaluate()` → status가 "generating"이면 대기 → `SUBTITLES_READY` 브로드캐스트 수신 → 재마운트.

### 자막 UI (`src/content/ui/`)

Shadow DOM으로 사이트 CSS와 완전 격리. `mountDisplay()`가 두 개의 독립 Shadow DOM을 생성:
- 가운데 오버레이: 영상 플레이어 위에 absolute
- 우측 패널: 사이드 컬럼에 `prepend` (없으면 오버레이로 폴백)

단일 React root에서 `createPortal`로 두 위치를 동시에 렌더하므로 상태 공유.

**`pickText(cue.text, language)`**: `text[language] ?? text.en ?? 첫 번째 값` 순서로 폴백.

### WebSocket 스트리밍 (`src/api/wsClient.ts`)

2-stage 구조: Stage1(한국어 원문) → Stage2(번역 완료). cue 빌드 시 번역 텍스트를 `{ [this.targetLang]: text }` 로 저장 — `en`으로 하드코딩하면 인도네시아어(`id`) 등 라틴 문자 언어가 영어로 폴백됨.

### SiteAdapter (`src/content/siteAdapters/`)

YouTube/Weverse/Instagram DOM 접근 추상화. `getVideoId(url)`는 DOM이 아닌 URL만으로 판단 (popup에서도 재사용).

### 라이브 스트리밍

탭 오디오 캡처 → Offscreen Document (`src/offscreen/recorder.ts`) → 백엔드 WebSocket. MV3 Service Worker 30초 idle 종료 대응으로 20초 keepalive interval 사용.

## 설계 원칙

- **`chrome.storage.local` vs `sync`**: 즉시 반영을 위해 `local` 사용 (sync는 쓰기 제한/지연 있음).
- **`gen_lang` 키**: 언어별 자막을 서버에서 별도 job으로 관리하므로, 로컬에서도 "이 영상은 어떤 언어로 생성됐는가"를 `gen_lang`으로 추적해야 언어 전환이 올바르게 동작함.
- **`force=true` 재생성**: 언어 변경 시 항상 `force=true`로 호출해 `removeAvailable`로 이전 언어 상태를 초기화한 뒤 새 job 생성.
