import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jevRouterProExtension from "../src/index.js";
import type { ExtensionAPI, ExtensionContext, ModelRouteRequest, VirtualModelDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Extension-level smoke test: the factory against a stub ExtensionAPI.
 * R1.1 — exactly one virtual model with selectable levels low|medium|high|xhigh;
 * R8.3 — the command surface incl. legacy aliases; R2.3/R3.1 — route() wiring.
 */

interface Captured {
  virtualModels: VirtualModelDefinition<unknown>[];
  commands: Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
  handlers: Map<string, unknown>;
  tools: { name: string }[];
  api: ExtensionAPI;
}

function stubPi(): Captured {
  const captured: Captured = {
    virtualModels: [],
    commands: new Map(),
    handlers: new Map(),
    tools: [],
    api: {} as ExtensionAPI,
  };
  const api = {
    registerVirtualModel: (definition: VirtualModelDefinition<never>) => {
      captured.virtualModels.push(definition as VirtualModelDefinition<unknown>);
    },
    registerCommand: (name: string, registration: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      captured.commands.set(name, registration);
    },
    registerTool: (tool: { name: string }) => {
      captured.tools.push(tool);
    },
    on: (event: string, handler: unknown) => {
      captured.handlers.set(event, handler);
    },
    appendEntry: () => {},
    registerEntryRenderer: undefined,
    setModel: async () => true,
  };
  captured.api = api as unknown as ExtensionAPI;
  return captured;
}

function stubCtx(models: { provider: string; id: string }[]): ExtensionContext {
  const catalog = models.map((m) => ({ ...m, name: m.id, provider: m.provider }));
  return {
    modelRegistry: {
      getAvailable: () => catalog,
      find: (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id),
    },
    ui: {
      notify: () => {},
      setStatus: () => {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      editor: async () => undefined,
    },
    model: undefined,
    getContextUsage: () => undefined,
    cwd: process.cwd(),
    hasUI: false,
    signal: undefined,
  } as unknown as ExtensionContext;
}

describe("extension factory (R1, R2, R8)", () => {
  let dir: string;
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "extension-test-"));
    previousEnv = {
      JEV_ROUTER_AGENT_DIR: process.env.JEV_ROUTER_AGENT_DIR,
      JEV_ROUTER_PROFILES: process.env.JEV_ROUTER_PROFILES,
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
      TYPESAFE_API_URL: process.env.TYPESAFE_API_URL,
    };
    process.env.JEV_ROUTER_AGENT_DIR = dir;
    await writeFile(
      join(dir, "pi-jev-model-router-profiles.json"),
      JSON.stringify({
        zai: {
          useDefaultModels: false,
          routes: { quick: [{ provider: "zai", model: "glm-5.3-flash" }], standard: [{ provider: "zai", model: "glm-5.3" }], high: [{ provider: "zai", model: "glm-5.3" }], premium: [{ provider: "zai", model: "glm-5.3" }] },
          kindModels: { implement: [{ provider: "zai", model: "glm-5.3", minTier: "standard" }] },
        },
      }),
      "utf8",
    );
    // Active profile persisted in the pro state file (R8.2).
    await writeFile(join(dir, "pi-jev-auto-state.json"), JSON.stringify({ version: 1, activeProfile: "zai", parks: [] }), "utf8");
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("registers exactly one virtual model with low|medium|high|xhigh (R1.1)", async () => {
    const pi = stubPi();
    await jevRouterProExtension(pi.api);
    expect(pi.virtualModels).toHaveLength(1);
    const definition = pi.virtualModels[0];
    expect(definition.provider).toBe("jev");
    expect(definition.id).toBe("auto");
    expect(definition.name).toBe("Auto (Jev Pro)");
    expect(definition.thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(typeof definition.route).toBe("function");
  });

  it("registers the command surface incl. legacy aliases (R8.3)", async () => {
    const pi = stubPi();
    await jevRouterProExtension(pi.api);
    for (const name of ["jev", "jev-router", "jev-route", "jev-profile", "jev-profiles", "jev-profile-current", "jev-profile-show", "jev-profile-add", "jev-profile-save", "jev-profile-edit", "jev-profile-clone", "jev-profile-remove", "jev-profile-reload", "jev-profile-init"]) {
      expect(pi.commands.has(name), `missing command /${name}`).toBe(true);
    }
    expect(pi.tools.map((t: { name: string }) => t.name)).toEqual(["jev_route"]);
  });

  it("route(): user dispatch from the active profile; continuation stays sticky (R2, R3)", async () => {
    process.env.TYPESAFE_API_KEY = "";
    delete process.env.TYPESAFE_API_KEY;
    const pi = stubPi();
    await jevRouterProExtension(pi.api);
    const definition = pi.virtualModels[0];
    const ctx = stubCtx([
      { provider: "zai", id: "glm-5.3-flash" },
      { provider: "zai", id: "glm-5.3" },
    ]);

    // First request: no Jev key in the test env → fail-open sticky (chain[0]).
    const route = definition.route as (request: ModelRouteRequest<unknown>, ctx: ExtensionContext) => Promise<{ model: { provider: string; id: string }; thinkingLevel: string; state?: unknown }>;
    const first = await route(
      {
        model: { provider: "jev", id: "auto", api: "pi-virtual" },
        thinkingLevel: "medium",
        reason: "user",
        messages: [{ role: "user", content: "implement a parser for the config format" }],
      } as unknown as ModelRouteRequest<unknown>,
      ctx,
    );
    expect(first.model).toMatchObject({ provider: "zai" });
    expect(first.model.id).toBeTruthy();
    expect((first.state as { attempted?: string[] } | undefined)?.attempted).toHaveLength(1);

    // Continuation: sticky on the previous physical model.
    const second = await route(
      {
        model: { provider: "jev", id: "auto", api: "pi-virtual" },
        thinkingLevel: "medium",
        reason: "continuation",
        previous: { model: first.model, thinkingLevel: "medium" },
        state: first.state,
        messages: [
          { role: "user", content: "implement a parser for the config format" },
          { role: "assistant", content: "Working on it." },
          { role: "toolResult", content: "done", toolName: "read", isError: false },
        ],
      } as unknown as ModelRouteRequest<unknown>,
      ctx,
    );
    expect(second.model).toEqual(first.model);
  });

  it("route(): chain exhaustion throws (R4.4)", async () => {
    const pi = stubPi();
    await jevRouterProExtension(pi.api);
    const definition = pi.virtualModels[0];
    const ctx = stubCtx([{ provider: "zai", id: "glm-5.3" }]);
    const route = definition.route as (request: ModelRouteRequest<unknown>, ctx: ExtensionContext) => Promise<unknown>;
    const exhaustedRequest = {
      model: { provider: "jev", id: "auto", api: "pi-virtual" },
      thinkingLevel: "medium",
      reason: "retry",
      failed: { model: { provider: "zai", id: "glm-5.3" }, message: { stopReason: "error", errorMessage: "HTTP 429 rate limited" } },
      state: { attempted: ["zai/glm-5.3"], lastJudgment: { kind: "chat", kindConfidence: 0.9, complexity: 0.5, budgetIntensity: 0.5, deepReasoning: 0.1 }, lastTier: "standard", lastKind: "chat" },
      messages: [],
    } as unknown as ModelRouteRequest<unknown>;
    await expect(route(exhaustedRequest, ctx)).rejects.toThrow(/chain exhausted/i);
    // A further retry of the same exhausted turn (no failure details) keeps
    // failing visibly instead of silently re-dispatching (R4.4 no silent degrade).
    await expect(
      route(
        {
          model: { provider: "jev", id: "auto", api: "pi-virtual" },
          thinkingLevel: "medium",
          reason: "retry",
          state: { attempted: ["zai/glm-5.3"] },
          messages: [],
        } as unknown as ModelRouteRequest<unknown>,
        ctx,
      ),
    ).rejects.toThrow(/already exhausted/i);
  });
});
