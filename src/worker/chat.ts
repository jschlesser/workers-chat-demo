import { ChatRoom } from "./ChatRoom";
import { RateLimiter } from "./RateLimiter";

interface Env {
  rooms: DurableObjectNamespace;
  limiters: DurableObjectNamespace;
  ASSETS: Fetcher;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handleErrors(request, async () => {
      const url = new URL(request.url);
      const path = url.pathname.slice(1).split('/');

      // Handle API routes
      if (path[0] === "api") {
        return handleApiRequest(path.slice(1), request, env);
      }

      // For all other requests, try to serve from static assets
      // This will serve the React app
      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response("Not found", {status: 404});
    });
  }
} satisfies ExportedHandler<Env>;

async function handleApiRequest(path: string[], request: Request, env: Env): Promise<Response> {
  switch (path[0]) {
    case "room": {
      if (!path[1]) {
        if (request.method === "POST") {
          const id = env.rooms.newUniqueId();
          return new Response(id.toString(), {headers: {"Access-Control-Allow-Origin": "*"}});
        } else {
          return new Response("Method not allowed", {status: 405});
        }
      }

      const name = path[1];
      let id: DurableObjectId;
      
      if (name.match(/^[0-9a-f]{64}$/)) {
        id = env.rooms.idFromString(name);
      } else if (name.length <= 32) {
        id = env.rooms.idFromName(name);
      } else {
        return new Response("Name too long", {status: 404});
      }

      const roomObject = env.rooms.get(id);
      const newUrl = new URL(request.url);
      newUrl.pathname = "/" + path.slice(2).join("/");
      
      return roomObject.fetch(newUrl, request);
    }

    default:
      return new Response("Not found", {status: 404});
  }
}

export { ChatRoom, RateLimiter };