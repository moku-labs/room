/**
 * @file Unit tests for `lifecycle/qr.ts`: the QR encodes the join URL ONLY (never SDP/ICE),
 * `generateQr:false` yields `qr:null`, and `modules.length === size * size`.
 */

import { describe, it } from "vitest";

describe("lifecycle/qr: matrix", () => {
  it.todo("encodes the join URL only (asserts the encoded payload is the URL, never SDP/ICE)");
  it.todo("returns null when generateQr is false");
  it.todo("produces modules.length === size * size");
});
