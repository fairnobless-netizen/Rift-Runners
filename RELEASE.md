# Release Guide

## Local development

Run frontend + backend together:

```bash
npm install
npm --prefix backend install
npm run dev:full
```

Alternative split terminals:

```bash
npm run dev:frontend
npm run dev:backend
```

## Production run

```bash
npm install
npm run build:full
PORT=4101 npm --prefix backend run start
```

## Verification checklist

1. Open `/` in a browser and confirm the app loads.
2. Open `/healthz` and confirm JSON similar to:
   - `ok: true`
   - `ts: <iso timestamp>`
   - `version: <git sha or dev>`
3. Probe workflow note: run Playwright probe E2E (`npm run test:e2e:probe`) to generate operational artifacts and verify the smoke path.
