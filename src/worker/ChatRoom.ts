import { RateLimiterClient } from './RateLimiter';
import type { WebSocketMessage, ClientMessage } from '../shared/types';

interface Env {
  rooms: DurableObjectNamespace;
  limiters: DurableObjectNamespace;
}

interface Session {
  name?: string;
  limiterId?: DurableObjectId | string;
  limiter: RateLimiterClient;
  blockedMessages?: string[];
  quit?: boolean;
}


async function handleErrors(request: Request, func: () => Promise<Response>): Promise<Response> {
  try {
    return await func();
  } catch (err) {
    if (request.headers.get("Upgrade") == "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({error: err instanceof Error ? err.stack : String(err)}));
      pair[1].close(1011, "Uncaught exception during session setup");
      return new Response(null, { status: 101, webSocket: pair[0] });
    } else {
      return new Response(err instanceof Error ? err.stack : String(err), {status: 500});
    }
  }
}

export class ChatRoom implements DurableObject {
  private state: DurableObjectState;
  private storage: DurableObjectStorage;
  private env: Env;
  private sessions: Map<WebSocket, Session>;
  private lastTimestamp: number;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.sessions = new Map();
    
    this.state.getWebSockets().forEach((webSocket) => {
      const meta = webSocket.deserializeAttachment() as any;
      const limiterId = this.env.limiters.idFromString(meta.limiterId);
      const limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack || String(err)));
      
      const blockedMessages: string[] = [];
      this.sessions.set(webSocket, { ...meta, limiter, blockedMessages });
    });

    this.lastTimestamp = 0;
  }

  async fetch(request: Request): Promise<Response> {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);

      switch (url.pathname) {
        case "/websocket": {
          if (request.headers.get("Upgrade") != "websocket") {
            return new Response("expected websocket", {status: 400});
          }

          const ip = request.headers.get("CF-Connecting-IP") || "unknown";
          const pair = new WebSocketPair();
          await this.handleSession(pair[1], ip);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }

        default:
          return new Response("Not found", {status: 404});
      }
    });
  }

  private async handleSession(webSocket: WebSocket, ip: string): Promise<void> {
    this.state.acceptWebSocket(webSocket);

    const limiterId = this.env.limiters.idFromName(ip);
    const limiter = new RateLimiterClient(
        () => this.env.limiters.get(limiterId),
        err => webSocket.close(1011, err.stack || String(err)));

    const session: Session = { limiterId, limiter, blockedMessages: [] };
    webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), limiterId: limiterId.toString() });
    this.sessions.set(webSocket, session);

    for (const otherSession of this.sessions.values()) {
      if (otherSession.name) {
        session.blockedMessages!.push(JSON.stringify({joined: otherSession.name}));
      }
    }

    const storage = await this.storage.list<string>({reverse: true, limit: 100});
    const backlog = [...storage.values()];
    backlog.reverse();
    backlog.forEach(value => {
      session.blockedMessages!.push(value);
    });
  }

  async webSocketMessage(webSocket: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    try {
      const session = this.sessions.get(webSocket);
      if (!session) return;
      
      if (session.quit) {
        webSocket.close(1011, "WebSocket broken.");
        return;
      }

      if (!session.limiter.checkLimit()) {
        webSocket.send(JSON.stringify({
          error: "Your IP is being rate-limited, please try again later."
        }));
        return;
      }

      const data = JSON.parse(msg as string) as WebSocketMessage;

      if (!session.name) {
        session.name = String(data.name || "anonymous");
        webSocket.serializeAttachment({ ...webSocket.deserializeAttachment(), name: session.name });

        if (session.name.length > 32) {
          webSocket.send(JSON.stringify({error: "Name too long."}));
          webSocket.close(1009, "Name too long.");
          return;
        }

        session.blockedMessages?.forEach(queued => {
          webSocket.send(queued);
        });
        delete session.blockedMessages;

        this.broadcast({joined: session.name});
        webSocket.send(JSON.stringify({ready: true}));
        return;
      }

      const message: WebSocketMessage = { 
        name: session.name, 
        message: String(data.message) 
      };

      if (message.message!.length > 256) {
        webSocket.send(JSON.stringify({error: "Message too long."}));
        return;
      }

      message.timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = message.timestamp;

      const dataStr = JSON.stringify(message);
      this.broadcast(dataStr);

      const key = new Date(message.timestamp).toISOString();
      await this.storage.put(key, dataStr);
    } catch (err) {
      webSocket.send(JSON.stringify({error: err instanceof Error ? err.stack : String(err)}));
    }
  }

  private async closeOrErrorHandler(webSocket: WebSocket): Promise<void> {
    const session = this.sessions.get(webSocket);
    if (session) {
      session.quit = true;
      this.sessions.delete(webSocket);
      if (session.name) {
        this.broadcast({quit: session.name});
      }
    }
  }

  async webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.closeOrErrorHandler(webSocket);
  }

  async webSocketError(webSocket: WebSocket, error: unknown): Promise<void> {
    await this.closeOrErrorHandler(webSocket);
  }

  private broadcast(message: string | WebSocketMessage): void {
    if (typeof message !== "string") {
      message = JSON.stringify(message);
    }

    const quitters: Session[] = [];
    this.sessions.forEach((session, webSocket) => {
      if (session.name) {
        try {
          webSocket.send(message as string);
        } catch (err) {
          session.quit = true;
          quitters.push(session);
          this.sessions.delete(webSocket);
        }
      } else {
        session.blockedMessages?.push(message as string);
      }
    });

    quitters.forEach(quitter => {
      if (quitter.name) {
        this.broadcast({quit: quitter.name});
      }
    });
  }
}