## [0.1.13] — 2026-10-15

### Added
- Paired transcript: each spoken line is shown next to its translation instead of two separate text blocks. Lines are split by pauses; a translation that lags behind is attached to the right line, and a line already in the target language (no translation) does not take the next speaker's translation.
- History: every session is saved automatically on this device (every 10 s and on stop) and can be re-read, exported or deleted from the History window.
- Export to .txt (original + translation, translation only, or original only) and copy to clipboard. No timecodes: in live use the audio often comes from different parts of a video.
- Unit tests for the line pairing and the text export (`bun test`).

### Fixed
- A failed capture start, an API error or a dropped connection no longer leaves the Gemini session open in the background. Every failure path now goes through one teardown that stops capture and closes the socket.
- Audio captured while the session reconnects (goAway rotation or network loss) is buffered (up to 3 s) and sent once the new session is ready, instead of being dropped.
- A session that never became ready (wrong key, no model access) now fails immediately with the server's reason instead of retrying 8 times.
- Windows: the WASAPI capture helper is terminated on Stop instead of running until the app quits.

### Changed
- The Gemini API key never leaves the main process. Each connection uses a short-lived ephemeral token (v1beta `auth_tokens`, Live API `BidiGenerateContentConstrained` endpoint).
- The renderer now runs sandboxed (`sandbox: true`, `contextIsolation: true`).
- Debug logging is off by default and can be enabled in Settings → Diagnostics; per-fragment transcript logging was removed.
- Microphone capture uses an AudioWorklet instead of the deprecated ScriptProcessorNode.
- Settings: the saved key is no longer shown; it can be replaced or removed.

## [0.1.12] — 2026-10-12

### Fixed
- Root cause of the repeating macOS microphone prompts: `electron-builder.yml` pinned the upstream author's Developer ID, which does not exist here, so builds were left unsigned. Without a stable code identity macOS TCC cannot remember consent. CI now signs explicitly (ad-hoc via `-c.mac.identity=-`, or with a real Developer ID if `MAC_CSC_LINK` secrets are set) and verifies signature + entitlements in the build log.
- Changed `appId` to `com.maxud1980.live-trans-remake` so stale TCC records of the upstream app (different signing team) no longer conflict.
- Microphone consent is now requested in one place only: native `askForMediaAccess`, and only while the status is `not-determined`. `getUserMedia` is used afterwards solely to unlock device labels and can no longer trigger a prompt.
- If access was denied earlier, System Settings → Microphone is opened instead of failing silently.

## [0.1.11] — 2026-10-05

### Fixed
- Removed the second independent macOS microphone permission request from the main process.
- Microphone consent is now requested through one renderer startup path, then microphone devices are enumerated after consent is complete.
- Fixed the microphone input list disappearing at startup while System Audio remained the only visible source.

## [0.1.10] — 2026-10-05

### Fixed
- Moved macOS microphone and system-audio permission warm-up to application startup instead of translation start.
- Kept the macOS system-audio Core Audio tap alive for the lifetime of the application, preventing repeated system-audio permission prompts between translation sessions.
- Translation sessions now reuse the already-authorized capture paths and no longer request microphone permission themselves.

## [0.1.9] — 2026-10-05

### Fixed
- Serialized macOS microphone permission requests so multiple renderer actions cannot trigger concurrent TCC prompts.
- Waited for macOS TCC to report the microphone as granted before starting Chromium microphone capture, preventing a native permission race.
- Prevented multiple simultaneous translation starts from creating multiple microphone permission requests.

## [0.1.8] — 2026-10-05

### Fixed
- Prevented Chromium's microphone permission flow from appearing again after macOS TCC microphone access has already been granted.
- Microphone device selection now uses the native macOS consent once, then allows the local renderer to open the granted microphone without additional permission dialogs.
- System Audio mode remains isolated from microphone permission handling.

## [0.1.7] — 2026-10-05

### Fixed
- macOS no longer enumerates microphone devices while the app is using System Audio, avoiding unnecessary microphone permission prompts.
- Microphone permission is now requested explicitly through macOS TCC only when microphone input is selected.
- Removed the custom Chromium media permission handlers; macOS handles microphone consent through the native Electron API.
- Restored microphone device enumeration after permission is explicitly granted.

# Changelog

## [0.1.6] — 2026-10-05

### Fixed
- Removed the macOS Audio Input entitlement that was unnecessarily requesting microphone access from the packaged app and its child processes.
- Restored microphone device enumeration on startup so input devices are available in the device selector before the first translation.
- Show generic microphone names when macOS has not yet exposed device labels.
- Corrected the macOS microphone and system-audio usage descriptions.

## [0.1.5] — 2026-10-05

### Fixed
- Explicitly handle Electron media permission requests so repeated microphone capture attempts do not reopen the permission flow.
- System-audio mode no longer enumerates microphone devices during startup.

## [0.1.4] — 2026-10-05

### Fixed
- Removed the manual macOS microphone permission request that could cause the permission dialog to repeat indefinitely.
- Microphone access is now requested only by the actual microphone capture via getUserMedia().

## [0.1.3] — 2026-10-05

### Fixed
- Fixed the macOS microphone permission prompt repeating when using system audio capture.
- Microphone permission is now requested only when microphone input is selected; system audio uses macOS System Audio Recording permission through AudioTee.

## [0.1.2] — 2026-10-05

### Changed
- Removed the usage/cost statistics button and the session/total spending indicators from the interface.
- Removed token/cost tracking, cost-rate settings, persistent spending data, and the associated IPC/API code.
- Kept the live source audio level meter as the audio feedback indicator.
- Removed the Coffee support button from the header.
- Made the source transcript header reflect the selected source language (or Auto-detect).

All notable user-facing changes to this project are documented here.

## [0.1.1] — 2026-10-05

### Fixed
- Fixed the source audio level meter not displaying signal levels correctly.
- Improved meter scaling for normal speech and system audio levels.

### Changed
- Simplified and refreshed the project README.
- Added clearer attribution to the original Live Trans project and its author.
