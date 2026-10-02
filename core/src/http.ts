import type { Hub } from "./driver.ts";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Browser-compatible transport. Inject fetch explicitly; platforms can wrap it
 * with their own AbortSignal/timeout. Core creates no controllers or timers.
 */
export function createHttpHub(endpoint: string, token: string, fetcher: Fetcher): Hub {
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
  return {
    endpoint: base,
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
      let response: Response;
      try {
        response = await fetcher(base + route, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: serialized,
          redirect: "error",
          credentials: "omit",
        });
      } catch {
        // Transport/abort exceptions may echo credentials or private URLs.
        throw new Error("hub request failed");
      }
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
    },
  };
}
