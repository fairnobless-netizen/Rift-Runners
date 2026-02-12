# Local Dev Quickstart (Mac)

## 1) Create frontend env file

```bash
cat > .env.local <<'ENV'
VITE_WS_URL=ws://localhost:4101
ENV
```

## 2) Preferred: run fullstack dev with one command

From the repo root:

```bash
npm install
npm run dev:full
```

This starts:
- backend on port **4101**
- frontend on port **5174**

Open <http://localhost:5174> and verify the overlay shows **WS: CONNECTED**.

## 3) Fallback: run services manually

The backend already reads `PORT` from the environment.

### Backend on port 4101

```bash
cd backend
npm install
npm run dev:4101
```

### Frontend on port 5174

```bash
cd /workspace/Rift-Runners
npm install
npm run dev:5174
```
