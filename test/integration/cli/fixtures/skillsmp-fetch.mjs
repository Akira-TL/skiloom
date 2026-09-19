const mode = process.env.SKILOOM_TEST_SKILLSMP_MODE ?? "success";

globalThis.fetch = async (input) => {
  const url = new URL(String(input));

  if (mode === "success") {
    return new Response(JSON.stringify({
      success: true,
      data: {
        skills: [
          {
            id: "skill-1",
            name: "frontend-design",
            description: "Design guidance",
            githubUrl: "https://github.com/Anthropics/Skills/tree/main/skills/frontend-design",
            skillUrl: "https://skillsmp.com/skills/frontend-design",
            stars: 12345,
            contentLanguage: "en",
            updatedAt: "2026-09-18T00:00:00Z",
            version: "9.9.9",
            hash: "provider-hash",
            downloadUrl: "https://skillsmp.com/download/provider.zip"
          },
          {
            id: "skill-2",
            name: "catalog-only",
            description: "No GitHub source",
            githubUrl: null,
            skillUrl: "https://skillsmp.com/skills/catalog-only",
            stars: 8,
            contentLanguage: "zh",
            updatedAt: "2026-09-17T00:00:00Z"
          }
        ]
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }

  if (mode === "authentication") {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "INVALID_API_KEY",
          message: "secret-key-must-not-leak"
        }
      }),
      { status: 401 }
    );
  }

  if (mode === "rate-limit") {
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code: "DAILY_QUOTA_EXCEEDED",
          message: "quota details must not become identity"
        }
      }),
      { status: 429 }
    );
  }

  if (mode === "incompatible-response") {
    return new Response(
      JSON.stringify({
        success: true,
        data: { skills: [{ id: 42 }] }
      }),
      { status: 200 }
    );
  }

  if (mode === "network") {
    throw new Error(
      "network failed with secret-token-that-must-not-leak"
    );
  }

  if (mode === "timeout") {
    const error = new Error(
      "timeout with secret-token-that-must-not-leak"
    );
    error.name = "TimeoutError";
    throw error;
  }

  throw new Error("unexpected fixture mode " + mode + " for " + url);
};
