// Node-style globals some libraries expect in a browser.
import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
export { Buffer };
