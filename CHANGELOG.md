# Changelog

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
