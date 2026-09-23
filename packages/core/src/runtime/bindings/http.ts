// internalBinding('http_parser'): the native side _http_common.js/_http_server.js/
// _http_client.js need. HTTPParser wraps the real, hand-written HttpMessageParser (httpParser.ts) to
// match the exact shape real Node's own vendored JS expects: numeric-indexed callback "slots"
// (`parser[kOnHeadersComplete] = fn`, matching a C++ binding's private-slot convention - plain
// numeric-keyed properties work fine for this in JS), and a grab-bag of plain fields
// (_headers/_url/socket/incoming/outgoing/maxHeaderPairs/onIncoming/joinDuplicateHeaders) that
// _http_common.js's own vendored functions read and write directly, expecting `this` to be the
// SAME object across calls - not something this file interprets, just a place to hold them.
//
// Not implemented: the pause-parsing-at-headers protocol (a JS callback returning a specific
// sentinel from kOnHeadersComplete to tell llhttp "stop, don't read the body yet" - used for
// CONNECT/raw-upgrade proxying). Ordinary GET/POST/response handling never exercises it: an
// upgrade is already detected and handled via HttpMessageParser's own "stop at headers, report bytes
// consumed" path, which _http_client.js/_http_server.js check for directly
// (`parser.incoming?.upgrade`) independent of any callback return value.

import { HttpMessageParser, HttpParseError, type IParsedHeadersComplete } from "./httpParser";

// Numeric slots _http_common.js assigns callbacks to. The exact values don't matter - nothing
// outside this file and that vendored module's own module-scope constants reads them - only
// that they're stable, distinct small integers real Node's own code can `| 0` freely.
const K_ON_MESSAGE_BEGIN = 0;
const K_ON_HEADERS = 1;
const K_ON_HEADERS_COMPLETE = 2;
const K_ON_BODY = 3;
const K_ON_MESSAGE_COMPLETE = 4;
const K_ON_EXECUTE = 5;
const K_ON_TIMEOUT = 6;

// The standard HTTP methods (IANA-registered + WebDAV), matching real llhttp's own known set -
// http.METHODS is built from this. A request using some OTHER, non-standard-but-syntactically-
// valid token still works: appended to this list (and so to `allMethods`) the first time it's
// seen, exactly as RFC 7230's extensible method grammar allows.
const KNOWN_METHODS = [
  "DELETE", "GET", "HEAD", "POST", "PUT", "CONNECT", "OPTIONS", "TRACE", "COPY", "LOCK",
  "MKCOL", "MOVE", "PROPFIND", "PROPPATCH", "SEARCH", "UNLOCK", "BIND", "REBIND", "UNBIND",
  "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE", "M-SEARCH", "NOTIFY", "SUBSCRIBE",
  "UNSUBSCRIBE", "PATCH", "PURGE", "MKCALENDAR", "LINK", "UNLINK", "SOURCE", "QUERY",
];

/** Tracks a server's live parsers/connections for getConnections()/closeIdleConnections()/etc. */
class ConnectionsList {
  private readonly items = new Set<HTTPParser>();

  push(parser: HTTPParser): void {
    this.items.add(parser);
  }
  remove(parser: HTTPParser): void {
    this.items.delete(parser);
  }
  all(): HTTPParser[] {
    return [...this.items];
  }
  /** "Idle" = not in the middle of an active request/response exchange. */
  idle(): HTTPParser[] {
    return this.all().filter((p) => !p.incoming || p.incoming.complete);
  }
  /** Approximates real Node's own headers/request timeout enforcement: a connection whose
   *  current message has been open longer than the given timeouts allow. */
  expired(headersTimeout: number, requestTimeout: number): HTTPParser[] {
    const now = Date.now();
    return this.all().filter((p) => {
      if (!p.incoming) return false;
      const limit = p.incoming.complete ? 0 : p.incoming.headersComplete ? requestTimeout : headersTimeout;
      return limit > 0 && now - p.startedAt > limit;
    });
  }
}

/** A minimal shape of what `incoming` (the IncomingMessage-to-be, real vendored code) exposes back to us. */
interface IIncomingLike {
  complete?: boolean;
  headersComplete?: boolean;
}

class HTTPParser {
  static readonly REQUEST = 0;
  static readonly RESPONSE = 1;
  static readonly kOnMessageBegin = K_ON_MESSAGE_BEGIN;
  static readonly kOnHeaders = K_ON_HEADERS;
  static readonly kOnHeadersComplete = K_ON_HEADERS_COMPLETE;
  static readonly kOnBody = K_ON_BODY;
  static readonly kOnMessageComplete = K_ON_MESSAGE_COMPLETE;
  static readonly kOnExecute = K_ON_EXECUTE;
  static readonly kOnTimeout = K_ON_TIMEOUT;
  static readonly kLenientAll = 0;
  static readonly kLenientNone = 1;

  // Plain fields real vendored code reads/writes directly (see file header comment) - typed
  // loosely on purpose, since their shape is entirely defined by that code, not by us.
  _headers: string[] = [];
  _url = "";
  socket: unknown = null;
  incoming: IIncomingLike | null = null;
  outgoing: unknown = null;
  maxHeaderPairs = 0;
  _consumed = false;
  onIncoming: ((incoming: unknown, shouldKeepAlive: boolean) => unknown) | null = null;
  joinDuplicateHeaders: unknown = null;
  startedAt = Date.now();

  [slot: number]: unknown;

  core: HttpMessageParser | null = null;
  connections: ConnectionsList | undefined;
  readonly methodIndex: Map<string, number>;
  readonly allMethods: string[];

  constructor(methodIndex: Map<string, number>, allMethods: string[]) {
    this.methodIndex = methodIndex;
    this.allMethods = allMethods;
  }

  initialize(type: number, _asyncResource: unknown, _maxHeaderSize: number, _lenient: number, connectionsList?: ConnectionsList): void {
    this.core = new HttpMessageParser(type === HTTPParser.REQUEST ? "REQUEST" : "RESPONSE");
    this.connections = connectionsList;
    this.connections?.push(this);
    this.startedAt = Date.now();

    this.core.onMessageBegin = () => {
      this.incoming = null;
      (this[K_ON_MESSAGE_BEGIN] as (() => void) | undefined)?.call(this);
    };
    this.core.onHeadersComplete = (info: IParsedHeadersComplete) => {
      const method = info.method === undefined ? undefined : this.methodNumber(info.method);
      (this[K_ON_HEADERS_COMPLETE] as ((...args: unknown[]) => unknown) | undefined)?.call(
        this,
        info.versionMajor,
        info.versionMinor,
        info.headers,
        method,
        info.url,
        info.statusCode,
        info.statusMessage,
        info.upgrade,
        info.shouldKeepAlive,
      );
    };
    this.core.onBody = (chunk) => {
      (this[K_ON_BODY] as ((chunk: Uint8Array) => void) | undefined)?.call(this, chunk);
    };
    this.core.onMessageComplete = () => {
      (this[K_ON_MESSAGE_COMPLETE] as (() => void) | undefined)?.call(this);
    };
  }

  methodNumber(method: string): number {
    let index = this.methodIndex.get(method);
    if (index === undefined) {
      index = this.allMethods.length;
      this.allMethods.push(method);
      this.methodIndex.set(method, index);
    }
    return index;
  }

  execute(buffer: Uint8Array): number | Error {
    if (!this.core) return new Error("parser not initialized");
    // A HEAD response has no body regardless of Content-Length (real HTTP semantics: it reflects
    // what a GET would have returned) - _http_client.js already tells us this itself, by setting
    // `outgoing` to the ClientRequest it sent (tickOnSocket's own `parser.outgoing = req;`) before
    // any response bytes can possibly arrive. Read fresh each call: cheap, and always correct
    // even if `outgoing` is assigned after initialize() but before the first execute().
    this.core.markLastWasHead((this.outgoing as { method?: string } | null)?.method === "HEAD");
    try {
      return this.core.execute(buffer);
    } catch (error) {
      // Only a genuine malformed-message error is "our" error to report back as a parse failure.
      // Anything else - notably ProcessExit, thrown synchronously by user code reachable from
      // deep inside onHeadersComplete/onBody (the request handler itself, or code it calls) -
      // must propagate untouched, exactly as it would if llhttp's native execute() were a plain
      // synchronous call stack with no JS try/catch boundary in the middle of it.
      if (error instanceof HttpParseError) return error;
      throw error;
    }
  }

  finish(): number {
    this.core?.finish();
    return 0;
  }

  close(): void {
    this.connections?.remove(this);
    this.core = null;
  }
  /** Real Node's own no-op-by-design method (see _http_common.js's freeParser comment). */
  free(): void {}
  remove(): void {
    this.connections?.remove(this);
  }
  unconsume(): void {}
  /** Never actually called: our TCP handle has no `isStreamBase`, so _http_server.js's own
   *  `if (socket._handle?.isStreamBase && ...)` guard steers around this fast path entirely -
   *  parsing always goes through the ordinary `socket.on('data', ...)` + execute() route instead. */
  consume(): void {}
  pause(): void {}
  resume(): void {}
  getCurrentBuffer(): Uint8Array {
    return new Uint8Array(0);
  }
}

export const createHttpParserBinding = () => {
  const allMethods = [...KNOWN_METHODS];
  const methodIndex = new Map(allMethods.map((m, i) => [m, i]));

  return {
    methods: [...KNOWN_METHODS],
    allMethods,
    ConnectionsList,
    HTTPParser: class extends HTTPParser {
      constructor() {
        super(methodIndex, allMethods);
      }
    },
  };
};
