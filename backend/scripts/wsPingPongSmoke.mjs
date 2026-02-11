import WebSocket from "ws";

const PORT = process.env.PORT || "3001";
const TOKEN = process.env.TEST_TOKEN || "dev"; // если сервер требует токен — подставим ниже
const URL = `ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`;

const ws = new WebSocket(URL);

const id = 1;
const t = Date.now();
const sentAt = Date.now();

const timeout = setTimeout(() => {
  console.error("TIMEOUT: no pong received");
  process.exit(1);
}, 2500);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "ping", id, t }));
});

ws.on("message", (buf) => {
  const msg = JSON.parse(buf.toString());
  if (msg.type !== "pong") return;

  clearTimeout(timeout);

  if (msg.id !== id) {
    console.error("FAIL: pong id mismatch", msg);
    process.exit(1);
  }
  if (msg.t !== t) {
    console.error("FAIL: pong t mismatch", msg);
    process.exit(1);
  }
  if (typeof msg.serverNow !== "number") {
    console.error("FAIL: pong serverNow missing", msg);
    process.exit(1);
  }

  const rtt = Date.now() - sentAt;
  console.log("OK pong:", msg, "RTT(ms)~", rtt);

  ws.close();
  process.exit(0);
});

ws.on("error", (e) => {
  clearTimeout(timeout);
  console.error("WS ERROR:", e);
  process.exit(1);
});
