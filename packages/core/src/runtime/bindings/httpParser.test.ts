import { describe, expect, it } from "vitest";
import { HttpParseError, HttpMessageParser, type IParsedHeadersComplete } from "./httpParser";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface IRecorded {
  messageBegins: number;
  headersComplete: IParsedHeadersComplete[];
  body: string[];
  messagesComplete: number;
}

const wire = (parser: HttpMessageParser): IRecorded => {
  const rec: IRecorded = { messageBegins: 0, headersComplete: [], body: [], messagesComplete: 0 };
  parser.onMessageBegin = () => rec.messageBegins++;
  parser.onHeadersComplete = (info) => rec.headersComplete.push(info);
  parser.onBody = (chunk) => rec.body.push(dec.decode(chunk));
  parser.onMessageComplete = () => rec.messagesComplete++;
  return rec;
};

describe("HttpMessageParser - requests", () => {
  it("parses a simple GET with no body: headers complete and the message completes immediately", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "GET /foo?x=1 HTTP/1.1\r\nHost: example.com\r\nUser-Agent: test\r\n\r\n";
    const consumed = parser.execute(enc.encode(raw));
    expect(consumed).toBe(raw.length);
    expect(rec.messageBegins).toBe(1);
    expect(rec.headersComplete).toEqual([
      {
        versionMajor: 1,
        versionMinor: 1,
        headers: ["Host", "example.com", "User-Agent", "test"],
        upgrade: false,
        shouldKeepAlive: true,
        method: "GET",
        url: "/foo?x=1",
      },
    ]);
    expect(rec.body).toEqual([]);
    expect(rec.messagesComplete).toBe(1);
  });

  it("parses a POST with a Content-Length body, delivered via onBody", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "POST /submit HTTP/1.1\r\nHost: h\r\nContent-Length: 11\r\n\r\nhello world";
    const consumed = parser.execute(enc.encode(raw));
    expect(consumed).toBe(raw.length);
    expect(rec.body.join("")).toBe("hello world");
    expect(rec.messagesComplete).toBe(1);
  });

  it("parses a chunked request body across several chunks, and stops at the terminating 0-chunk", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "POST /up HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
    const consumed = parser.execute(enc.encode(raw));
    expect(consumed).toBe(raw.length);
    expect(rec.body).toEqual(["hello", " world"]);
    expect(rec.messagesComplete).toBe(1);
  });

  it("handles bytes arriving in arbitrary fragments (partial start-line, header, and body) across several execute() calls", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhello";
    const bytes = enc.encode(raw);
    let totalConsumed = 0;
    // Feed one byte at a time - the most adversarial possible fragmentation.
    for (const b of bytes) totalConsumed += parser.execute(Uint8Array.of(b));
    expect(totalConsumed).toBe(bytes.length);
    expect(rec.headersComplete).toHaveLength(1);
    expect(rec.body.join("")).toBe("hello");
    expect(rec.messagesComplete).toBe(1);
  });

  it("parses two pipelined requests delivered in one execute() call", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "GET /a HTTP/1.1\r\nHost: h\r\n\r\nGET /b HTTP/1.1\r\nHost: h\r\n\r\n";
    const consumed = parser.execute(enc.encode(raw));
    expect(consumed).toBe(raw.length);
    expect(rec.messageBegins).toBe(2);
    expect(rec.headersComplete.map((h) => h.url)).toEqual(["/a", "/b"]);
    expect(rec.messagesComplete).toBe(2);
  });

  it("parses two keep-alive requests delivered in separate execute() calls on the same parser", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    parser.execute(enc.encode("GET /a HTTP/1.1\r\nHost: h\r\n\r\n"));
    parser.execute(enc.encode("GET /b HTTP/1.1\r\nHost: h\r\n\r\n"));
    expect(rec.headersComplete.map((h) => h.url)).toEqual(["/a", "/b"]);
    expect(rec.messagesComplete).toBe(2);
  });

  it("a request with neither Content-Length nor chunked has no body (matches RFC 7230, unlike a response)", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    parser.execute(enc.encode("DELETE /x HTTP/1.1\r\nHost: h\r\n\r\n"));
    expect(rec.body).toEqual([]);
    expect(rec.messagesComplete).toBe(1);
  });

  it("detects an Upgrade request, stops parsing there, and reports bytes consumed excluding the tail", () => {
    const parser = new HttpMessageParser("REQUEST");
    const rec = wire(parser);
    const raw = "GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nTAIL-BYTES";
    const bytes = enc.encode(raw);
    const consumed = parser.execute(bytes);
    expect(rec.headersComplete[0].upgrade).toBe(true);
    expect(consumed).toBe(bytes.length - "TAIL-BYTES".length);
    expect(dec.decode(bytes.slice(consumed))).toBe("TAIL-BYTES");
  });

  it("throws HttpParseError on a malformed request line, header line, or Content-Length", () => {
    expect(() => new HttpMessageParser("REQUEST").execute(enc.encode("GET\r\n\r\n"))).toThrow(HttpParseError);
    expect(() => new HttpMessageParser("REQUEST").execute(enc.encode("GET / HTTP/1.1\r\nbadheader\r\n\r\n"))).toThrow(HttpParseError);
    expect(() => new HttpMessageParser("REQUEST").execute(enc.encode("GET / HTTP/1.1\r\nContent-Length: nope\r\n\r\n"))).toThrow(HttpParseError);
  });
});

describe("HttpMessageParser - responses", () => {
  it("parses a status line and headers", () => {
    const parser = new HttpMessageParser("RESPONSE");
    const rec = wire(parser);
    parser.execute(enc.encode("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"));
    expect(rec.headersComplete[0]).toMatchObject({ statusCode: 404, statusMessage: "Not Found" });
  });

  it("a HEAD response has no body even with a Content-Length header", () => {
    const parser = new HttpMessageParser("RESPONSE");
    parser.markLastWasHead(true);
    const rec = wire(parser);
    parser.execute(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n"));
    expect(rec.body).toEqual([]);
    expect(rec.messagesComplete).toBe(1);
  });

  it("204/304/1xx responses have no body even with a Content-Length header (RFC 7230/7231), and the next keep-alive response still parses correctly", () => {
    for (const status of [100, 204, 304]) {
      const parser = new HttpMessageParser("RESPONSE");
      const rec = wire(parser);
      parser.execute(enc.encode(`HTTP/1.1 ${status} X\r\nContent-Length: 5\r\n\r\n`));
      expect(rec.body).toEqual([]);
      expect(rec.messagesComplete).toBe(1);
      // The "phantom" 5 bytes from Content-Length must NOT be misread as this message's body,
      // nor corrupt parsing of whatever comes next on the same connection.
      parser.execute(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi"));
      expect(rec.body).toEqual(["hi"]);
      expect(rec.messagesComplete).toBe(2);
    }
  });

  it("a response with no Content-Length/chunked and no Connection: close still reads until finish()", () => {
    const parser = new HttpMessageParser("RESPONSE");
    const rec = wire(parser);
    parser.execute(enc.encode("HTTP/1.0 200 OK\r\n\r\nhello"));
    expect(rec.body).toEqual(["hello"]);
    expect(rec.messagesComplete).toBe(0);
    parser.execute(enc.encode(" world"));
    expect(rec.body).toEqual(["hello", " world"]);
    expect(rec.messagesComplete).toBe(0);
    parser.finish();
    expect(rec.messagesComplete).toBe(1);
  });

  it("a chunked response body decodes correctly, including a chunk split across execute() calls", () => {
    const parser = new HttpMessageParser("RESPONSE");
    const rec = wire(parser);
    const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n0\r\n\r\n";
    const bytes = enc.encode(raw);
    // Split right in the middle of the "abcd" chunk data.
    const splitAt = raw.indexOf("ab") + 1;
    parser.execute(bytes.slice(0, splitAt));
    parser.execute(bytes.slice(splitAt));
    expect(rec.body.join("")).toBe("abcd");
    expect(rec.messagesComplete).toBe(1);
  });
});
