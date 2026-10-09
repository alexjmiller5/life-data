// The hub's previous hostname: forwards every request to the renamed hub
// until each consumer points at it directly.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    url.hostname = env.TARGET_HOST;
    return env.HUB.fetch(new Request(url, request));
  },
};
