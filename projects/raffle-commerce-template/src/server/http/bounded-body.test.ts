import { describe, expect, it } from "vitest";
import { readBoundedRequestBody, RequestBodyTooLargeError } from "./bounded-body";

function streamingRequest(body: ReadableStream<Uint8Array>) {
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  return new Request("https://example.test", init);
}

describe("bounded raw request body", () => {
  it("preserves chunk bytes below the boundary", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    await expect(readBoundedRequestBody(streamingRequest(body), 4))
      .resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("cancels and rejects before buffering a chunked oversized body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
      },
    });
    await expect(readBoundedRequestBody(streamingRequest(body), 5))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
