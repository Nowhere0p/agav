import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseArgs } from "../main.js";
import { loadConfig, type AgavConfig } from "../config/config.js";
import { createProvider } from "../providers/registry.js";
import { listSessions } from "../config/history.js";
import {
  applyConfigOverrides,
  parseConfigOverride,
  type ConfigOverride,
} from "../config/cli-overrides.js";

vi.mock("../config/config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../config/config.js")>(),
  loadConfig: vi.fn(),
}));
vi.mock("../config/keybindings.js", () => ({ loadKeybindings: vi.fn(async () => ({})) }));
vi.mock("../config/theme.js", () => ({ loadTheme: vi.fn() }));
vi.mock("../config/history.js", () => ({ listSessions: vi.fn(async () => []) }));
vi.mock("../providers/registry.js", () => ({ createProvider: vi.fn() }));
vi.mock("../utils/auto-update.js", () => ({ checkAndUpdate: vi.fn() }));
vi.mock("../utils/temp-output.js", () => ({ tempOutputManager: { pruneStale: vi.fn() } }));

const originalArgv = process.argv;
const exitError = new Error("process exited");
const providerReached = new Error("provider reached");
let config: AgavConfig;

function overridesWith(argv: string[]): ConfigOverride[] {
  return parseArgs(argv).configOverrides as ConfigOverride[];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation(() => { throw exitError; });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  config = {
    provider: "anthropic", model: "configured-model", anthropicApiKey: "test-key",
    effort: "medium", maxTokens: 1024, maxIterations: 37, errorRetries: 1,
    permissionMode: "ask", systemPrompt: "test prompt",
  };
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(createProvider).mockImplementation(() => { throw providerReached; });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe("-c/--config flag parsing", () => {
  it.each([
    { argv: ["-c", "effort=low"], expected: { path: ["effort"], value: "low" } },
    { argv: ["--config", "effort=low"], expected: { path: ["effort"], value: "low" } },
    { argv: ["--config=effort=low"], expected: { path: ["effort"], value: "low" } },
  ])("accepts $argv", ({ argv, expected }) => {
    expect(overridesWith(argv)).toEqual([expected]);
  });

  it("is repeatable and resolves a repeated key to the last occurrence", () => {
    const parsed = overridesWith(["-c", "effort=low", "-c", "effort=high"]);
    expect(parsed).toHaveLength(2);
    const target = { effort: "medium" } as unknown as AgavConfig;
    applyConfigOverrides(target, parsed);
    expect(target.effort).toBe("high");
  });

  it("splits on the first = so values may contain =", () => {
    expect(overridesWith(["-c", "systemPrompt=a=b=c"])[0]!.value).toBe("a=b=c");
    expect(overridesWith(["-c", 'openaiHeaders={"x-a":"b=c"}'])[0]!.value).toEqual({ "x-a": "b=c" });
  });

  it.each([
    { argv: ["-c", "maxIterations=42"], expected: { path: ["maxIterations"], value: 42 } },
    { argv: ["-c", "ollamaPort=11434"], expected: { path: ["ollamaPort"], value: 11434 } },
    { argv: ["-c", "search=true"], expected: { path: ["search"], value: true } },
    { argv: ["-c", "hideAbsolutePath=false"], expected: { path: ["hideAbsolutePath"], value: false } },
    { argv: ["-c", 'allowedTools=["read_file"]'], expected: { path: ["allowedTools"], value: ["read_file"] } },
    { argv: ["-c", 'hooks={"afterEdit":"npm test"}'], expected: { path: ["hooks"], value: { afterEdit: "npm test" } } },
    { argv: ["-c", "statusBar={}"], expected: { path: ["statusBar"], value: {} } },
    { argv: ["-c", "openaiApi=chat"], expected: { path: ["openaiApi"], value: "chat" } },
    { argv: ["-c", "provider=deepseek"], expected: { path: ["provider"], value: "deepseek" } },
    { argv: ["-c", "permissionMode=deny-writes"], expected: { path: ["permissionMode"], value: "deny-writes" } },
  ])("coerces $argv", ({ argv, expected }) => {
    expect(overridesWith(argv)).toEqual([expected]);
  });

  it.each(["1", "42", "0002", "9007199254740991"])("accepts maxIterations=%j via the shared --max-turns check", (value) => {
    expect(overridesWith(["-c", `maxIterations=${value}`]))
      .toEqual([{ path: ["maxIterations"], value: Number(value) }]);
  });

  it.each(["0", "-5", "1.5", "1e3", "10abc", "+2", "", "9007199254740992"])(
    "rejects maxIterations=%j exactly like --max-turns does", (value) => {
      expect(() => parseArgs(["-c", `maxIterations=${value}`])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("-c maxIterations must be a positive safe integer"));
      // Both flags share parseMaxTurns, so they must agree on valid input.
      expect(() => parseArgs(["--max-turns", value])).toThrow(exitError);
      expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("--max-turns must be a positive safe integer"));
    },
  );

  it("parses dotted paths and coerces obvious scalars under them", () => {
    expect(parseConfigOverride("theme.promptColor=blue"))
      .toEqual({ path: ["theme", "promptColor"], value: "blue" });
    expect(parseConfigOverride("statusBar.segments.0.n=3"))
      .toEqual({ path: ["statusBar", "segments", "0", "n"], value: 3 });
  });

  it.each([
    ["-c", "a malformed entry with no equals sign"],
    ["-c", "foo"],
    ["-c", "=bar"],
    ["-c", "theme..x=1"],
    ["-c", ".x=1"],
    ["-c", "modl=x"],
    ["-c", "effort=ultra"],
    ["-c", "provider=mars"],
    ["-c", "maxIterations=abc"],
    ["-c", "maxIterations=-5"],
    ["-c", "maxIterations=1.5"],
    ["-c", "search=maybe"],
    ["-c", "allowedTools=oops"],
    ["-c", "openaiApi=bogus"],
  ])("rejects %j with an actionable error", (...argv) => {
    expect(() => parseArgs(argv)).toThrow(exitError);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Error:"));
  });

  it("suggests the closest key for a typo", () => {
    expect(() => parseArgs(["-c", "efrot=low"])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('did you mean "effort"'));
  });

  it("rejects a missing value at the end of argv", () => {
    expect(() => parseArgs(["-P", "hi", "-c"])).toThrow(exitError);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("-c/--config expects key=value"));
  });
});

describe("applyConfigOverrides", () => {
  it("sets one nested property without touching its siblings", () => {
    const target = { theme: { userLabel: "cyan" } } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["theme", "promptColor"], value: "blue" }]);
    expect(target.theme).toEqual({ userLabel: "cyan", promptColor: "blue" });
  });

  it("creates missing intermediate objects", () => {
    const target = { effort: "medium" } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["openaiHeaders", "x-api-key"], value: "tok" }]);
    expect((target as unknown as Record<string, unknown>)["openaiHeaders"]).toEqual({ "x-api-key": "tok" });
  });

  it("replaces an object leaf entirely when named without a dotted path", () => {
    const target = { theme: { userLabel: "cyan" } } as unknown as AgavConfig;
    applyConfigOverrides(target, [{ path: ["theme"], value: { promptColor: "blue" } }]);
    expect(target.theme).toEqual({ promptColor: "blue" });
  });
});

describe("-c/--config production CLI behavior", () => {
  it.each([["-P"], ["run"]])("%s applies overrides on top of the loaded config", async (command) => {
    process.argv = [process.execPath, "agav", command, "hello", "-c", "effort=low", "-c", "maxIterations=50"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "low", maxIterations: 50 }));
  });

  it("keeps the config-file value when no override is given", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "medium", maxIterations: 37 }));
  });

  it("lets dedicated flags win over -c on conflict", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "effort=low", "-c", "maxIterations=50", "--effort", "high", "--max-turns", "10"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ effort: "high", maxIterations: 10 }));
  });

  it("pins provider and model against the last-session restore", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ provider: "anthropic", model: "session-model" }] as never);
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "provider=ollama", "-c", "model=llama3.2"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "ollama", model: "llama3.2" }));
  });

  it("control: without -c the last-session restore still adopts its model", async () => {
    vi.mocked(listSessions).mockResolvedValue([{ provider: "anthropic", model: "session-model" }] as never);
    process.argv = [process.execPath, "agav", "-P", "hello"];
    await expect(main()).rejects.toThrow(providerReached);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "anthropic", model: "session-model" }));
  });

  it("fails at parse time, before loadConfig, on a malformed entry", async () => {
    process.argv = [process.execPath, "agav", "-P", "hello", "-c", "foo"];
    await expect(main()).rejects.toThrow(exitError);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("prints a session-overrides notice in interactive mode", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      // No API keys: startup fails right after the notice, before Ink would render.
      delete config.anthropicApiKey;
      process.argv = [process.execPath, "agav", "-c", "effort=low"];
      await expect(main()).rejects.toThrow(exitError);
      const written = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join("");
      expect(written).toContain("session overrides: effort");
    } finally {
      if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});
