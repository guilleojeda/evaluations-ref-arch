import assert from "node:assert/strict";
import { test } from "node:test";
import { handler } from "../.artifacts/controller/backend/index.mjs";

const actionId = "9e844502-01b5-4745-a1ca-7d47e9377b97";

function event(method, path, { headers = {}, body } = {}) {
  return {
    version: "2.0",
    rawPath: path,
    headers,
    requestContext: { requestId: "phase2-local-unauthorized", http: { method, path } },
    isBase64Encoded: false,
    body,
  };
}

test("the controller guards observations, recorded actions and commands before parsing input", async (t) => {
  const cases = [
    ["state", event("GET", "/api/state")],
    ["action record", event("GET", `/api/actions/${actionId}`, { headers: { authorization: "Basic invalid" } })],
    ["malformed command", event("PUT", `/api/actions/${actionId}`, { body: "{" })],
  ];

  for (const [label, request] of cases) {
    await t.test(label, async () => {
      // No runtime configuration or AWS provider is needed to reject these credentials.
      const response = await handler(request);
      assert.equal(response.statusCode, 401);
      const headers = new Headers(response.headers);
      assert.match(headers.get("cache-control") ?? "", /\bno-store\b/i);
    });
  }
});
