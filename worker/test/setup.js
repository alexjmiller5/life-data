// Workers provide crypto.DigestStream; Bun does not. Same interface, for tests only.
import { createHash } from "node:crypto";

if (!crypto.DigestStream) {
  crypto.DigestStream = class extends WritableStream {
    constructor(algorithm) {
      const hash = createHash(algorithm.replace("-", "").toLowerCase());
      let resolve;
      const digest = new Promise((r) => (resolve = r));
      super({ write: (chunk) => void hash.update(chunk), close: () => resolve(new Uint8Array(hash.digest()).buffer) });
      this.digest = digest;
    }
  };
}
