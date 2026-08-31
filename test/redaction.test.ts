import { describe, expect, it } from "vitest";
import { redactCommand } from "../src/redaction.js";

describe("redactCommand", () => {
  it("redacts common credential forms while preserving useful command context", () => {
    expect(redactCommand("API_TOKEN=abc123 curl -H 'Authorization: Bearer xyz' x --password hunter2 --api-key=key npm test"))
      .toBe("API_TOKEN=<redacted> curl -H 'Authorization: <redacted>' x --password <redacted> --api-key=<redacted> npm test");
  });
});
