# Local Dev Quickstart (Mac)

## 1) Create frontend env file

```bash
cat > .env.local <<'ENV'
VITE_WS_URL=ws://localhost:4101
ENV
```

## 2) Run backend on port 4101

The backend already reads `PORT` from the environment.

```bash
cd backend
npm install
npm run dev:4101
```

## 3) Run frontend on port 5174

```bash
cd /workspace/Rift-Runners
npm install
npm run dev:5174
```

Open <http://localhost:5174> and verify the overlay shows **WS: CONNECTED**.
