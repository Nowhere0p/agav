import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgavConfig } from "../config/config.js";
import { readdirSync, readFileSync } from "node:fs";
import {
  noProviderCredentialsError,
  providerConfigurationError,
  resolveStartupSelection,
  selectConfiguredProvider,
  loadMostRecentSession
} from "../config/startup.js";

const base: AgavConfig = {
  provider: "anthropic",
  model: "configured-claude",
  effort: "high",
  maxTokens: 1024,
  maxIterations: 10,
  errorRetries: 1,
  permissionMode: "ask",
};

vi.mock("node:fs", () => ({
  readdirSync: vi.fn().mockImplementation(() => {
    throw new Error("no history found");
  }),
  readFileSync: vi.fn(),
}));

describe("startup provider and model resolution", () => {
  it("keeps configured selection for plain startup", () => {
    expect(resolveStartupSelection(base, {})).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });

  it("uses the selected provider default when --provider changes provider", () => {
    expect(resolveStartupSelection(base, { cliProvider: "openai" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(resolveStartupSelection(base, { cliProvider: "openrouter" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("restores both provider and model from a resumed session", () => {
    expect(resolveStartupSelection(base, {
      session: { provider: "gemini", model: "gemini-session-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-session-model" });
  });

  it("does not combine a CLI provider override with another provider's saved model", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "openai",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("retains the saved model when the CLI provider matches the session", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "anthropic",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "anthropic", model: "claude-session-model" });
  });

  it("keeps an explicit provider/model pair authoritative", () => {
    expect(resolveStartupSelection(base, {
      cliProvider: "openai",
      cliModel: "custom-openai-model",
      session: { provider: "anthropic", model: "claude-session-model" },
    })).toMatchObject({ provider: "openai", model: "custom-openai-model" });
  });

  it("preserves an unqualified CLI model until catalog resolution selects its provider", () => {
    expect(resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "sonnet-5",
    })).toMatchObject({ provider: "openai", model: "sonnet-5" });
  });

  it("retains an unmatched CLI model when provider catalog lookup cannot resolve it", () => {
    expect(resolveStartupSelection({ ...base, provider: "openai", model: "gpt-5.4-mini" }, {
      cliModel: "private-model",
    })).toMatchObject({ provider: "openai", model: "private-model" });
  });

  it("rejects an unsupported saved provider unless the CLI replaces it", () => {
    expect(() => resolveStartupSelection(base, {
      session: { provider: "removed-provider", model: "old-model" },
    })).toThrow("Saved session uses unsupported provider");

    expect(resolveStartupSelection(base, {
      cliProvider: "gemini",
      session: { provider: "removed-provider", model: "old-model" },
    })).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite" });
  });

  it("auto-selects an available provider only for an unpinned startup", () => {
    expect(selectConfiguredProvider({ ...base, openaiApiKey: "key" })).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(selectConfiguredProvider({ ...base, openrouterApiKey: "key" })).toMatchObject({
      provider: "openrouter",
      model: "openrouter/auto",
    });
  });

  it("keeps an explicit --model when falling back to another provider", () => {
    expect(selectConfiguredProvider({ ...base, model: "gpt-4o", openaiApiKey: "key" }, { keepModel: true }))
      .toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("enables Vertex AI from the credentials path alone", () => {
    const config: AgavConfig = { ...base, provider: "vertex-ai", model: "vertex/gemini-3.5-flash" };
    expect(providerConfigurationError(config)).toContain("VERTEX_AI_CREDENTIALS_PATH");
    expect(providerConfigurationError({ ...config, vertexAICredentialsPath: "/tmp/sa.json" })).toBeNull();
  });

  it("names a runnable command for every provider when nothing is configured", () => {
    const message = noProviderCredentialsError();
    for (const variable of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "VERTEX_AI_CREDENTIALS_PATH"]) {
      // The shell-specific prefix is covered by utils.shell-hints; here it only
      // matters that each variable is shown as a command, not just named.
      expect(message).toMatch(new RegExp(`(export|set|\\$env:)\\s?${variable}`));
    }
    expect(message).toContain("agav --provider ollama");
  });

  it("reports the selected provider's exact missing configuration", () => {
    expect(providerConfigurationError({ ...base, anthropicApiKey: undefined }))
      .toContain("ANTHROPIC_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openai", openaiApiKey: undefined }))
      .toContain("OPENAI_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: undefined }))
      .toContain("OPENROUTER_API_KEY");
    expect(providerConfigurationError({ ...base, provider: "openrouter", openrouterApiKey: "sk-or-test" }))
      .toBeNull();
  });
});

describe("loadMostRecentSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the most recently created session with a valid provider", () => {
    const olderSession = {
      id: "session-1",
      createdAt: "2025-01-01T10:00:00.000Z",
      provider: "openai",
      model: "gpt-4o",
      title: "Older session",
      messages: [],
    };
    const newerSession = {
      id: "session-2",
      createdAt: "2025-01-02T10:00:00.000Z",
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      title: "Newer session",
      messages: [],
    };
    vi.mocked(readdirSync).mockReturnValue(["1.json", "2.json"] as any);
    vi.mocked(readFileSync).mockImplementation((filePath) => {
      if (String(filePath).includes("1.json")) return JSON.stringify(olderSession);
      if (String(filePath).includes("2.json")) return JSON.stringify(newerSession);
      return "";
    });

    const session = loadMostRecentSession();
    expect(session).toEqual(newerSession);
  });

  it("returns undefined if no history files exist", () => {
    vi.mocked(readdirSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadMostRecentSession()).toBeUndefined();
  });
});
describe("resolveStartupSelection with recent session history", () => {
  it("falls back to the most recent session's model and provider on plain startup", () => {
    vi.mocked(readdirSync).mockReturnValue(["session.json"] as any);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      }),
    );
    const selection = resolveStartupSelection(base, {});
    expect(selection).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
    });
  });
  it("prefers explicit CLI provider over saved session history", () => {
    vi.mocked(readdirSync).mockReturnValue(["session.json"] as any);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        id: "session-1",
        createdAt: "2025-01-01T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4o",
        title: "Saved Session",
        messages: [],
      }),
    );
    const selection = resolveStartupSelection(base, { cliProvider: "anthropic" });
    expect(selection).toMatchObject({
      provider: "anthropic",
      model: "configured-claude",
    });
  });
});
