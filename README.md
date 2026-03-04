# Vinoria AR

Production setup:
- Frontend (Cloudflare Pages): `https://vinoria.app`
- Backend (Cloudflare Worker route): `https://vinoria.app/api/*`
- Storage: Cloudflare KV + Cloudflare R2

## API (current)
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/wines`
- `POST /api/wines`
- `PUT /api/wines`
- `GET /api/wines/:id`
- `PUT /api/wines/:id`
- `DELETE /api/wines/:id`
- `POST /api/admin/mind/presign-put`
- `POST /api/admin/mind/finalize`
- `POST /api/admin/mind/trigger-build`
- `GET /api/mind/manifest`
- `GET /api/mind/latest`
- `POST /api/recognize/ocr`
- `POST /api/recognize/visual`
- `GET /api/labels/records`
- `GET /api/health`

Mind compilation:
- Runs in GitHub Actions (`.github/workflows/compile-mind-targets.yml`) on schedule/manual dispatch.
- Compiler script: `worker/scripts/compile-mind-from-worker.mjs`
- Uses shard-based manifest (`/api/mind/manifest`) for scanner loading.

## Auth
Admin password is stored in Worker secret:
- `ADMIN_PASSWORD`

Session cookie settings:
- `HttpOnly`
- `Secure`
- `SameSite=Lax`
- `Path=/`

## Required Worker secrets/vars
- `ADMIN_PASSWORD`
- `CF_ACCOUNT_ID`
- `R2_BUCKET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_PUBLIC_BASE_URL` (optional, if using public R2 domain)
- `TARGETS_ADMIN_KEY` (optional, service/admin header access)
- `OCR_SPACE_API_KEY` (optional, OCR provider)
- `ALLOWED_ORIGIN` (optional, comma-separated allowlist)
- `GITHUB_TOKEN` (optional, to auto-trigger compile workflow)
- `GITHUB_REPO` (optional, format `owner/repo`, e.g. `adasils/ARApp`)
- `GITHUB_WORKFLOW_ID` (optional, default `compile-mind-targets.yml`)
- `GITHUB_WORKFLOW_REF` (optional, default `master`)

## Local dev
```bash
npm install
npm run dev
```

Worker:
```bash
cd worker
npm install
npx wrangler dev
```

## Build
```bash
npm run build
```
