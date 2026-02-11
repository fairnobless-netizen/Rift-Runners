import { WsClientMessage, WsServerMessage } from './wsTypes';

export type WsClientOptions = {
  url: string;
  token: string;
  onMessage?: (msg: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class WsClient {
  private ws?: WebSocket;

  constructor(private opts: WsClientOptions) {}

  connect() {
    if (this.ws) return;

    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);

    this.ws = new WebSocket(url.toString(), []);
    this.ws.onopen = () => {
      this.opts.onOpen?.();
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsServerMessage;
        this.opts.onMessage?.(msg);
      } catch {
        // ignore malformed payloads
      }
    };

    this.ws.onclose = () => {
      this.ws = undefined;
      this.opts.onClose?.();
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = undefined;
  }

  send(msg: WsClientMessage) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }
}
