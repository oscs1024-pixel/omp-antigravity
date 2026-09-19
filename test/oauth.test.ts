import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginAntigravity, REDIRECT_URI, TOKEN_URL } from "../src/auth/oauth.js";

describe("OAuth callback server", () => {
  const originalFetch = globalThis.fetch;

  it("keeps waiting after malformed callbacks and accepts the valid callback", async () => {
    const abort = new AbortController();
    let callbackFlow = Promise.resolve();

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
        return new Response(JSON.stringify({ email: "test@example.com" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/v1internal:loadCodeAssist")) {
        return new Response(JSON.stringify({ projectId: "test-project" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    try {
      const credentials = await loginAntigravity({
        signal: abort.signal,
        onPrompt: () => new Promise<string>(() => {}),
        onAuth: ({ url }) => {
          const state = new URL(url).searchParams.get("state");
          assert.ok(state);
          const callbackUrl = REDIRECT_URI.replace("localhost", "127.0.0.1");
          callbackFlow = (async () => {
            const missing = await originalFetch(callbackUrl);
            assert.equal(missing.status, 400);

            const mismatched = await originalFetch(
              `${callbackUrl}?code=wrong-code&state=wrong-state`,
            );
            assert.equal(mismatched.status, 400);

            const valid = await originalFetch(
              `${callbackUrl}?code=valid-code&state=${encodeURIComponent(state)}`,
            );
            assert.equal(valid.status, 200);
          })();
          void callbackFlow.catch(() => abort.abort());
        },
      });

      await callbackFlow;
      assert.equal(credentials.email, "test@example.com");
      assert.equal(credentials.projectId, "test-project");
    } finally {
      abort.abort();
      globalThis.fetch = originalFetch;
    }
  });
});
