interface Env {
  limiters: DurableObjectNamespace;
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

export class RateLimiter implements DurableObject {
  private nextAllowedTime: number;

  constructor(state: DurableObjectState, env: Env) {
    this.nextAllowedTime = 0;
  }

  async fetch(request: Request): Promise<Response> {
    return await handleErrors(request, async () => {
      const now = Date.now() / 1000;

      this.nextAllowedTime = Math.max(now, this.nextAllowedTime);

      if (request.method === "POST") {
        this.nextAllowedTime += 5;
      }

      const cooldown = Math.max(0, this.nextAllowedTime - now - 20);
      return new Response(String(cooldown));
    });
  }
}

export class RateLimiterClient {
  private getLimiterStub: () => DurableObjectStub;
  private reportError: (err: Error) => void;
  private limiter: DurableObjectStub;
  private inCooldown: boolean;

  constructor(getLimiterStub: () => DurableObjectStub, reportError: (err: Error) => void) {
    this.getLimiterStub = getLimiterStub;
    this.reportError = reportError;
    this.limiter = getLimiterStub();
    this.inCooldown = false;
  }

  checkLimit(): boolean {
    if (this.inCooldown) {
      return false;
    }
    this.inCooldown = true;
    this.callLimiter();
    return true;
  }

  private async callLimiter(): Promise<void> {
    try {
      let response: Response;
      try {
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      } catch (err) {
        this.limiter = this.getLimiterStub();
        response = await this.limiter.fetch("https://dummy-url", {method: "POST"});
      }

      const cooldown = +(await response.text());
      await new Promise(resolve => setTimeout(resolve, cooldown * 1000));

      this.inCooldown = false;
    } catch (err) {
      this.reportError(err as Error);
    }
  }
}