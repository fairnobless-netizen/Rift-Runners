import type { WsClientMessage, WsServerMessage } from './wsTypes';

export type WsClientOptions = {
  url: string;
  token: string;
  onMessage?: (msg: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (error: Event) => void;
};

export class WsClient {
  private ws?: WebSocket;

  constructor(private opts: WsClientOptions) {}

  connect() {
    if (this.ws) return;

    const url = new URL(this.opts.url);
    url.searchParams.set('token', this.opts.token);
    const authSubprotocol = this.opts.token ? `session_token.${encodeURIComponent(this.opts.token)}` : undefined;

    this.ws = authSubprotocol ? new WebSocket(url.toString(), [authSubprotocol]) : new WebSocket(url.toString());
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

    this.ws.onclose = (event) => {
      if (event.code === 4401) {
        console.warn('[WS] Authentication failed on close (4401).', {
          code: event.code,
          reason: event.reason || '(no reason)',
        });
      }
      this.ws = undefined;
      this.opts.onClose?.(event);
    };

    this.ws.onerror = (error) => {
      this.opts.onError?.(error);
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
