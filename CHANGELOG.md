# Changelog

## 0.1.0 (unreleased)

First version. Everything below is implemented and covered by automated tests, except where marked.

### Added

- Backend: configuration validation, SQLite metadata with a build state machine and logs, bounded build queue with cancellation and timeout, retention cleanup, REST API with Server-Sent Events (written, not executed because dependencies could not be installed).
- Safe ZIP reader, HTML ingestion, entry-point detection, packaging warnings, SSRF-protected URL validation with redirect revalidation and address pinning.
- Smart Icon Generator: legacy, round, adaptive and monochrome launcher resources, previews, settings validation.
- Kotlin Android template using WebView and WebViewAssetLoader, build configuration validation, Gradle runner, APK validation, build runner.
- Frontend in English, French and Portuguese with dashboard, studio, live build monitor, history, settings, documentation and about pages.
- Dockerfile, Docker Compose with an HTTPS profile, one-command VPS installer, update, doctor, backup, restore, set-domain and uninstall scripts.
- Configurations for Railway, Render, Fly.io, Vercel and Netlify; deployment guides for ten targets; GitHub Actions workflows.

### Not verified

- No real Gradle build, no real APK, no installation on a device.
- No Docker image build, no run of the installer on a real server, no deployment to any platform, no GitHub Actions run.
- Express, Multer, Zod, Pino and express-rate-limit code was never executed.

### Not implemented

- Release signing, S3-compatible object storage, separate worker services, ARM build hosts.
