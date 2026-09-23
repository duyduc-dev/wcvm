// A real, hand-written HTTP/1.1 parser: real Node's is llhttp, a native (C++/Wasm) binding, not
// vendorable as JS - so unlike the rest of this sandbox, this file is genuinely new logic, not a
// wrapper around Node's own source. It exists to satisfy exactly what _http_common.js's real,
// vendored callbacks need (see that file's parserOnHeadersComplete/parserOnBody/
// parserOnMessageComplete): request-line/status-line, headers delivered whole (llhttp's
// incremental kOnHeaders callback is for headers split across TCP packets - real Node's own JS
// already falls back gracefully when headers arrive undefined, so this parser just always takes
// that path and never needs incremental header delivery), and Content-Length/chunked/
// close-delimited body framing per RFC 7230.

export class HttpParseError extends Error {
  readonly code = "HPE_INVALID_CONSTANT";
  constructor(message: string) {
    super(message);
    this.name = "HttpParseError";
  }
}

export interface IParsedHeadersComplete {
  versionMajor: number;
  versionMinor: number;
  /** Flat [name, value, name, value, ...] pairs, in wire order - real Node's own shape. */
  headers: string[];
  /** Set for a request parser. */
  method?: string;
  url?: string;
  /** Set for a response parser. */
  statusCode?: number;
  statusMessage?: string;
  upgrade: boolean;
  shouldKeepAlive: boolean;
}

const CR = 0x0d;
const LF = 0x0a;

type Phase =
  | "start-line"
  | "headers"
  | "body-length"
  | "body-until-close"
  | "chunk-size"
  | "chunk-data"
  | "chunk-crlf"
  | "chunk-trailer"
  | "upgrade";

type StartLine =
  | { method: string; url: string; version: string }
  | { statusCode: number; statusMessage: string; version: string };

const decoder = new TextDecoder("latin1"); // header bytes are ASCII/Latin-1 per RFC 7230, not UTF-8

/** Finds `\r\n` starting at `from`; -1 if the buffer doesn't contain one yet (need more data). */
const findCRLF = (buf: Uint8Array, from: number): number => {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
};

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/**
 * One HTTP/1.x message parser, request or response mode, reused across keep-alive messages on
 * the same connection (matching real Node: one parser per connection, not per request - after
 * onMessageComplete fires, it's immediately ready to parse the next message from any bytes left
 * in the same execute() call or a later one).
 */
export class HttpMessageParser {
  onMessageBegin: (() => void) | null = null;
  onHeadersComplete: ((info: IParsedHeadersComplete) => void) | null = null;
  onBody: ((chunk: Uint8Array) => void) | null = null;
  onMessageComplete: (() => void) | null = null;

  private readonly isRequest: boolean;
  private phase: Phase = "start-line";
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private startLine: StartLine | undefined;
  private headerLines: string[] = [];
  private contentLength = 0;
  private bodyRead = 0;
  private chunkSize = 0;
  private sawContentLength = false;
  private chunked = false;
  private connectionClose = false;
  private lastWasHead = false; // a HEAD response has no body regardless of Content-Length

  constructor(type: "REQUEST" | "RESPONSE") {
    this.isRequest = type === "REQUEST";
  }

  /** For a response parser: was the just-sent request's method HEAD? (a HEAD response never has a body). */
  markLastWasHead(value: boolean) {
    this.lastWasHead = value;
  }

  /**
   * Feeds more bytes in. Returns the number of bytes of `chunk` consumed - normally
   * `chunk.length`, except when an Upgrade/CONNECT is detected: the rest of `chunk` belongs to
   * the new protocol, not this parser, and the caller is responsible for it (real Node's own
   * `d.slice(bytesParsed, d.length)` pattern in _http_client.js/_http_server.js).
   * Throws HttpParseError on a malformed message.
   */
  execute(chunk: Uint8Array): number {
    if (this.phase === "upgrade") return 0;
    const combined = this.buffer.length ? concat(this.buffer, chunk) : chunk;
    const priorLeftover = combined.length - chunk.length;
    let offset = 0;

    for (;;) {
      if (this.phase === "start-line") {
        const end = findCRLF(combined, offset);
        if (end === -1) break;
        this.parseStartLine(decoder.decode(combined.subarray(offset, end)));
        offset = end + 2;
        this.phase = "headers";
        continue;
      }
      if (this.phase === "headers") {
        const end = findCRLF(combined, offset);
        if (end === -1) break;
        if (end === offset) {
          offset = end + 2;
          if (this.finishHeaders()) {
            this.buffer = new Uint8Array(0); // an upgrade: the rest of `combined` isn't ours
            return Math.max(0, offset - priorLeftover);
          }
          continue;
        }
        this.parseHeaderLine(decoder.decode(combined.subarray(offset, end)));
        offset = end + 2;
        continue;
      }
      if (this.phase === "body-length") {
        const remaining = this.contentLength - this.bodyRead;
        const available = combined.length - offset;
        const take = Math.min(remaining, available);
        if (take > 0) {
          this.onBody?.(combined.subarray(offset, offset + take));
          this.bodyRead += take;
          offset += take;
        }
        if (this.bodyRead < this.contentLength) break;
        this.completeMessage();
        continue;
      }
      if (this.phase === "body-until-close") {
        const available = combined.length - offset;
        if (available > 0) {
          this.onBody?.(combined.subarray(offset, offset + available));
          offset += available;
        }
        break; // only finish() (a real connection close) ends this phase
      }
      if (this.phase === "chunk-size") {
        const end = findCRLF(combined, offset);
        if (end === -1) break;
        const line = decoder.decode(combined.subarray(offset, end)).split(";")[0].trim();
        const size = Number.parseInt(line, 16);
        if (Number.isNaN(size) || size < 0) throw new HttpParseError(`Invalid chunk size: ${line}`);
        offset = end + 2;
        this.chunkSize = size;
        this.phase = size === 0 ? "chunk-trailer" : "chunk-data";
        continue;
      }
      if (this.phase === "chunk-data") {
        const available = combined.length - offset;
        const take = Math.min(this.chunkSize, available);
        if (take > 0) {
          this.onBody?.(combined.subarray(offset, offset + take));
          this.chunkSize -= take;
          offset += take;
        }
        if (this.chunkSize > 0) break;
        this.phase = "chunk-crlf";
        continue;
      }
      if (this.phase === "chunk-crlf") {
        if (combined.length - offset < 2) break;
        if (combined[offset] !== CR || combined[offset + 1] !== LF) {
          throw new HttpParseError("Missing chunk terminator CRLF");
        }
        offset += 2;
        this.phase = "chunk-size";
        continue;
      }
      // chunk-trailer: optional trailing headers (rare) followed by a blank line. We don't
      // surface them separately - real Node folds leftover parser._headers into the message's
      // trailers via the incremental kOnHeaders path, which this parser never uses (see file
      // header comment) - a documented simplification.
      const end = findCRLF(combined, offset);
      if (end === -1) break;
      const blank = end === offset;
      offset = end + 2;
      if (blank) this.completeMessage();
      continue;
    }

    this.buffer = combined.subarray(offset);
    // Normal (non-upgrade) case: whatever wasn't parsed into a complete unit is buffered
    // internally for the next call, exactly like real llhttp's own internal buffering - so from
    // the caller's perspective, all of `chunk` was consumed either way. Only the upgrade path
    // above returns a shorter count, since bytes past that boundary genuinely aren't ours.
    return chunk.length;
  }

  /** Signals no more data will ever arrive (the connection closed) - finalizes an until-close body. */
  finish(): void {
    if (this.phase === "body-until-close") this.completeMessage();
  }

  private parseStartLine(line: string) {
    this.onMessageBegin?.();
    if (this.isRequest) {
      const firstSpace = line.indexOf(" ");
      const lastSpace = line.lastIndexOf(" ");
      if (firstSpace === -1 || lastSpace === firstSpace) throw new HttpParseError(`Invalid request line: ${line}`);
      const method = line.slice(0, firstSpace);
      const url = line.slice(firstSpace + 1, lastSpace);
      const version = line.slice(lastSpace + 1);
      if (!method || !url) throw new HttpParseError(`Invalid request line: ${line}`);
      this.startLine = { method, url, version };
    } else {
      const firstSpace = line.indexOf(" ");
      if (firstSpace === -1) throw new HttpParseError(`Invalid status line: ${line}`);
      const version = line.slice(0, firstSpace);
      const rest = line.slice(firstSpace + 1);
      const secondSpace = rest.indexOf(" ");
      const statusCode = Number.parseInt(secondSpace === -1 ? rest : rest.slice(0, secondSpace), 10);
      const statusMessage = secondSpace === -1 ? "" : rest.slice(secondSpace + 1);
      if (Number.isNaN(statusCode)) throw new HttpParseError(`Invalid status line: ${line}`);
      this.startLine = { statusCode, statusMessage, version };
    }
  }

  private parseHeaderLine(line: string) {
    const colon = line.indexOf(":");
    if (colon === -1) throw new HttpParseError(`Invalid header line: ${line}`);
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name) throw new HttpParseError(`Invalid header line: ${line}`);
    this.headerLines.push(name, value);
    const lower = name.toLowerCase();
    if (lower === "content-length") {
      const n = Number.parseInt(value, 10);
      if (Number.isNaN(n) || n < 0) throw new HttpParseError(`Invalid Content-Length: ${value}`);
      this.contentLength = n;
      this.sawContentLength = true;
    } else if (lower === "transfer-encoding" && /(?:^|\W)chunked(?:$|\W)/i.test(value)) {
      this.chunked = true;
    } else if (lower === "connection" && /(?:^|\W)close(?:$|\W)/i.test(value)) {
      this.connectionClose = true;
    }
  }

  private headerHasKeepAlive(): boolean {
    for (let i = 0; i < this.headerLines.length; i += 2) {
      if (this.headerLines[i].toLowerCase() === "connection" && this.headerLines[i + 1]?.toLowerCase().includes("keep-alive")) return true;
    }
    return false;
  }

  /** Returns true if this is an Upgrade/CONNECT (parsing stops here; the caller takes over the bytes). */
  private finishHeaders(): boolean {
    const start = this.startLine!;
    const version = start.version.startsWith("HTTP/") ? start.version.slice(5) : "1.0";
    const [majorStr, minorStr] = version.split(".");
    const versionMajor = Number.parseInt(majorStr, 10) || 1;
    const versionMinor = Number.parseInt(minorStr, 10) || 0;

    const method = "method" in start ? start.method : undefined;
    const hasUpgradeHeader = this.headerLines.some((v, i) => i % 2 === 0 && v.toLowerCase() === "upgrade");
    const upgrade = method === "CONNECT" || hasUpgradeHeader;
    const shouldKeepAlive = !this.connectionClose && !(versionMajor === 1 && versionMinor === 0 && !this.headerHasKeepAlive());

    const info: IParsedHeadersComplete = {
      versionMajor,
      versionMinor,
      headers: this.headerLines,
      upgrade,
      shouldKeepAlive,
      ...("method" in start ? { method: start.method, url: start.url } : { statusCode: start.statusCode, statusMessage: start.statusMessage }),
    };

    if (upgrade) {
      this.phase = "upgrade";
      this.onHeadersComplete?.(info);
      return true;
    }

    // Per RFC 7230/7231: a HEAD response, a 1xx/204/304 response, and (separately, above) an
    // Upgrade never have a body, REGARDLESS of any Content-Length/Transfer-Encoding present -
    // real llhttp enforces this via a callback-return-value protocol (_http_client.js's
    // parserOnIncomingClient returning a "skip body" sentinel) this parser doesn't implement;
    // this is the same rule, applied directly, since it's just what HTTP itself says framing is.
    const statusCode = "statusCode" in start ? start.statusCode : undefined;
    const noBodyStatus = statusCode !== undefined && (statusCode === 204 || statusCode === 304 || (statusCode >= 100 && statusCode < 200));
    const hasBody = this.isRequest
      ? this.chunked || this.sawContentLength
      : !this.lastWasHead && !noBodyStatus;
    this.onHeadersComplete?.(info);

    if (!hasBody) {
      this.completeMessage();
    } else if (this.chunked) {
      this.phase = "chunk-size";
    } else if (this.sawContentLength) {
      if (this.contentLength === 0) this.completeMessage();
      else this.phase = "body-length";
    } else if (!this.isRequest) {
      this.phase = "body-until-close";
    } else {
      this.completeMessage();
    }
    return false;
  }

  /** Resets to a fresh message, keeping any unconsumed bytes (a pipelined next request). */
  private completeMessage() {
    this.onMessageComplete?.();
    this.phase = "start-line";
    this.startLine = undefined;
    this.headerLines = [];
    this.contentLength = 0;
    this.bodyRead = 0;
    this.chunkSize = 0;
    this.sawContentLength = false;
    this.chunked = false;
  }
}
