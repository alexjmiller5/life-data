import {changesetRoutes} from './changeset-client.ts';
import {governanceOperations} from './governance-wire.ts';
import type {JSONValue} from './contract.generated.ts';
import type { ServiceHub } from "./services.ts";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Browser-compatible transport. Inject fetch explicitly; platforms can wrap it
 * with their own AbortSignal/timeout. Core creates no controllers or timers.
 */
export function createHttpHub(endpoint: string, token: string, fetcher: Fetcher): ServiceHub {
  let url: URL;
  try {
    if (typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)
      || /[\s\\?#\u0000-\u001f\u007f]/.test(endpoint)) throw new Error();
    const authority = endpoint.split("/")[2];
    if (!authority || authority.includes("@")) throw new Error();
    url = new URL(endpoint);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
  } catch {
    // URL parser messages can contain userinfo or query credentials.
    throw new Error("invalid hub endpoint");
  }
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) throw new Error("invalid hub token");
  if (typeof fetcher !== "function") throw new Error("hub fetch implementation required");
  const base = url.href.replace(/\/+$/, "");
  async function send(method: "POST" | "GET", route: string, body?: string) {
    let response: Response;
    try {
      response = await fetcher(base + route, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json",
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        credentials: "omit",
      });
    } catch {
      // Transport/abort exceptions may echo credentials or private URLs.
      throw new Error("hub request failed");
    }
    return response;
  }
  async function request(method: "POST" | "GET", route: string, body?: string) {
    const response=await send(method,route,body);
    if (response.status < 200 || response.status >= 300) throw new Error(`hub HTTP ${response.status}`);
    const contentType = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json" && !(contentType?.startsWith("application/") && contentType.endsWith("+json"))) {
      throw new Error("hub response is not JSON");
    }
    let data: unknown;
    try { data = await response.json(); }
    catch { throw new Error("hub invalid JSON response"); }
    const date = response.headers.get("Date");
    return { data, ...(date ? { date } : {}) };
  }
  async function governanceRequest(route:string,body:unknown){
      const response=await send('POST',route,JSON.stringify(body));
      const contentType=response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if(contentType!=='application/json')throw new Error('invalid governance response');
      let data:JSONValue;try{data=await response.json() as JSONValue;}catch{throw new Error('invalid governance response');}
      const retry=response.headers.get('Retry-After');
      const seconds=retry!==null && /^[0-9]+$/.test(retry)?Number(retry):undefined;
      return {status:response.status,data,...(seconds!==undefined && Number.isSafeInteger(seconds)?{retryAfterSeconds:seconds}:{})};
  }
  return {
    endpoint: base,
    async changesetPost(route,body){
      if(!Object.values(changesetRoutes).includes(route))throw new Error('invalid changeset route');
      return governanceRequest(route,body);
    },
    async governancePost(route,body) {
      if(!Object.values(governanceOperations).some(op=>op.route===route))throw new Error('invalid governance route');
      return governanceRequest(route,body);
    },
    async get(route) {
      // Only client-generated service URIs. No arbitrary queries or values can
      // carry credentials, override an origin, or escape the endpoint path.
      if (typeof route !== "string") throw new Error("invalid hub route");
      const feed = /^\/v1\/notifications\?after=(0|[1-9][0-9]*)&limit=([1-9][0-9]*)$/.exec(route);
      if (route !== "/v1/usage" && route !== "/v1/notifications"
        && !(feed && feed[0] === route && Number.isSafeInteger(Number(feed[1]))
          && Number(feed[2]) <= 200)) throw new Error("invalid hub route");
      return request("GET", route);
    },
    async post(route, body) {
      // API paths only: no origin overrides, traversal, query, or fragments.
      if (typeof route !== "string" || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(route)) {
        throw new Error("invalid hub route");
      }
      let serialized: string;
      try {
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
        serialized = JSON.stringify(body);
        if (typeof serialized !== "string") throw new Error();
      } catch {
        throw new Error("invalid hub request body");
      }
      return request("POST", route, serialized);
    },
  };
}
