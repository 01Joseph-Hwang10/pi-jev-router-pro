import type { ExtensionAPI, ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Mode, ProConfig, RouterState } from "./domain/types.js";
import { TIERS } from "./domain/types.js";
import { buildOrderedChain, decisionReason, firstAvailable, type AvailableModel, type TargetEligibility } from "./domain/chain.js";
import { JevChainExhausted } from "./domain/errors.js";
import { computeTier, resolveRoute, type RouteDecision, type RouteInput } from "./routing/router.js";
import { quotaEligibility, quotaSummary, CodexQuotaCache, describeQuotaStatus, type QuotaStatusInput } from "./routing/quota.js";
import { recordCost, recordJevUsage, spendSnapshot, type SpendSnapshot } from "./routing/budget.js";
import { classifyRequest, JevError, type RouteAnalysis } from "./jev/client.js";
import { apiKeyFor, hasApiKey } from "./jev/config.js";
import { ProRouterRuntime } from "./profiles/switcher.js";
import { registerCommands } from "./commands/register.js";
import type { ProCommandsContext, AnalyseResult } from "./commands/context.js";
import { entryDataFromDecision, makeEntryAppender, registerEntryRenderer } from "./ui/entries.js";
import { notify, updateStatus } from "./ui/status.js";
import { proConfigPath, proQuotaPath, proStatePath, profilesPath, readLegacyRouterNames, legacyRouterConfigPath } from "./storage/paths.js";
import { readFile } from "node:fs/promises";

/**
 * pi-jev-router-pro — single-surface TypeSafe Jev model router (constitution §2).
 *
 * One virtual model (`jev/auto` by default) routes every request:
 * judgment routing at `user` boundaries, sticky continuations, mid-turn
 * transient fallback on retries, permanent-failure parking, profile-driven
 * chains, and consent modes. Session selection stays `jev/auto`; the
 * dispatched physical model is recorded per assistant message by pi, so
 * replay and cost accounting stay correct.
 */

/** Pro-only knobs live in their own config file. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readProConfig(raw: Record<string, unknown> | undefined): ProConfig {
  if (!raw) return {};
  const cfg: ProConfig = {};
  const virtual = asRecord(raw.virtual);
  if (virtual.provider || virtual.id || virtual.name) {
    cfg.virtual = {};
    if (typeof virtual.provider === "string") cfg.virtual.provider = virtual.provider;
    if (typeof virtual.id === "string") cfg.virtual.id = virtual.id;
    if (typeof virtual.name === "string") cfg.virtual.name = virtual.name;
  }
  if (typeof raw.dormancy === "boolean") cfg.dormancy = raw.dormancy;
  if (typeof raw.profilesPath === "string") cfg.profilesPath = raw.profilesPath;
  if (typeof raw.detectLegacyProfile === "boolean") cfg.detectLegacyProfile = raw.detectLegacyProfile;
  const fault = asRecord(raw.faultInjection);
  if (fault.firstTransient !== undefined || fault.onRequest !== undefined || fault.mode !== undefined) {
    cfg.faultInjection = {
      firstTransient: typeof fault.firstTransient === "string" ? fault.firstTransient : "429",
      onRequest: typeof fault.onRequest === "number" && Number.isFinite(fault.onRequest) && fault.onRequest >= 0 ? Math.floor(fault.onRequest) : 1,
      mode: fault.mode === "advance" ? "advance" : "throw",
    };
  }
  return cfg;
}

function toAvailable(ctx: ExtensionContext): AvailableModel[] {
  try {
    const list = ctx.modelRegistry?.getAvailable?.();
    if (!Array.isArray(list)) return [];
    return list.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      cost: model.cost
        ? {
            input: model.cost.input,
            output: model.cost.output,
            cacheRead: model.cost.cacheRead,
            cacheWrite: model.cost.cacheWrite,
          }
        : undefined,
    }));
  } catch {
    return [];
  }
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const record = part as { type?: string; text?: string };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

function lastUserText(messages: readonly Message[]): string {
  const users = messages.filter((message) => message.role === "user");
  return contentToText(users.at(-1)?.content);
}

function historyExcerpt(messages: readonly Message[], turns: number): string | undefined {
  if (turns <= 0) return undefined;
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = contentToText(message.content);
    if (!text) continue;
    lines.push(`${message.role}: ${text.length > 600 ? `${text.slice(0, 600)}…` : text}`);
  }
  const tail = lines.slice(-(turns * 2));
  return tail.length > 0 ? tail.join("\n") : undefined;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Coerce a configured level to the pi union, falling back to the selection. */
function toThinkingLevel(level: string | undefined, fallback: ModelThinkingLevel): ModelThinkingLevel {
  if (level && (THINKING_LEVELS as readonly string[]).includes(level)) return level as ModelThinkingLevel;
  return fallback;
}

function formatAnalysisFull(analysis: RouteAnalysis): string {
  const probs = Object.entries(analysis.kindProbabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, p]) => `${kind} ${(p * 100).toFixed(0)}%`)
    .join(", ");
  return [
    `kind: ${analysis.kind} (confidence ${analysis.kindConfidence.toFixed(2)})`,
    `      ${probs}`,
    `complexity: ${analysis.complexity.toFixed(2)}/3 (conf ${analysis.complexityConfidence.toFixed(2)})`,
    `capability deserved: ${analysis.budgetIntensity.toFixed(2)}/3 (conf ${analysis.budgetIntensityConfidence.toFixed(2)})`,
    `deep reasoning: ${(analysis.deepReasoning * 100).toFixed(0)}%`,
    `jev latency: ${analysis.latencyMs}ms`,
  ].join("\n");
}

export default async function jevRouterProExtension(pi: ExtensionAPI): Promise<void> {
  const proConfig = readProConfig(await readJson(proConfigPath()));
  const virtualProvider = proConfig.virtual?.provider ?? "jev";
  const virtualId = proConfig.virtual?.id ?? "auto";
  const virtualKey = `${virtualProvider}/${virtualId}`;

  const runtime = new ProRouterRuntime(
    {
      profilesPath: profilesPath(proConfig.profilesPath),
      legacyRouterConfigPath: legacyRouterConfigPath(),
      statePath: proStatePath(),
    },
    proConfig,
  );
  try {
    await runtime.initialize();
  } catch (error) {
    // A broken profiles file must not take the session down; defaults apply.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`pi-jev-router-pro: ${message}`);
  }

  let models: AvailableModel[] = [];
  let dormant = false;
  let dormantWarned = false;
  let sessionMode: Mode | undefined;
  let sessionEnabled: boolean | undefined;
  let lastDecision: RouteDecision | undefined;
  let quota: CodexQuotaCache | undefined;
  let legacyWarningShown = false;
  /** R4.4 guard: the current turn exhausted its chain — later retries of the same turn fail visibly instead of silently re-dispatching. */
  let exhaustedTurn = false;
  /** Fault injection ("throw" mode): the key the armed dispatch would have used. */
  let pendingFaultKey: string | undefined;
  const classifyCache = new Map<string, { analysis: RouteAnalysis; at: number }>();
  const CLASSIFY_TTL_MS = 60_000;

  // Fault injection (design §7): deterministic, offline fallback verification.
  let faultRemaining = proConfig.faultInjection?.onRequest ?? 0;
  const faultError = proConfig.faultInjection?.firstTransient ?? "429 simulated transient failure (fault injection)";
  const faultMode = proConfig.faultInjection?.mode ?? "throw";

  const appendDecision = makeEntryAppender(pi);

  const effectiveEnabled = (): boolean => (sessionEnabled ?? runtime.config.enabled) && (process.env.JEV_ROUTER_OFF !== "1" && process.env.JEV_ROUTER_OFF !== "true");

  const effectiveMode = (): Mode => sessionMode ?? runtime.config.mode;

  const spendNow = (): SpendSnapshot => spendSnapshot(runtime.ledger, runtime.config.budget);

  function eligibilityFor(): TargetEligibility {
    return (target, model) => {
      const key = `${model.provider}/${model.id}`;
      if (runtime.parking.has(key)) {
        return { allowed: false, notes: [`${key} skipped: model temporarily parked`] };
      }
      return quotaEligibility(target, model.provider, runtime.config.quota["openai-codex"], quota?.snapshot);
    };
  }

  function classifyCached(input: { prompt: string; history?: string; contextTokens?: number; signal?: AbortSignal }): Promise<RouteAnalysis> {
    const cacheKey = input.prompt;
    const cached = classifyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CLASSIFY_TTL_MS) return Promise.resolve(cached.analysis);
    if (!hasApiKey(runtime.config)) {
      return Promise.reject(new JevError(`missing API key (env ${runtime.config.apiKeyEnv})`));
    }
    return classifyRequest(
      {
        prompt: input.prompt,
        history: input.history,
        cwd: process.cwd(),
        contextTokens: input.contextTokens,
        spend: spendNow(),
      },
      runtime.config,
      apiKeyFor(runtime.config),
      input.signal,
    ).then((analysis) => {
      classifyCache.set(cacheKey, { analysis, at: Date.now() });
      if (analysis.usage) recordJevUsage(runtime.ledger, analysis.usage.input_tokens, analysis.usage.output_tokens);
      void runtime.persistState();
      return analysis;
    });
  }

  const routeEnvironment = (): Parameters<typeof resolveRoute>[1] => ({
    config: runtime.config,
    models,
    spend: spendNow(),
    eligibility: eligibilityFor(),
    classify: classifyCached,
    park: (key: string) => {
      // Parking is best-effort; the chain still advances either way.
      runtime.parking.park(key, runtime.config.recovery.parkMs);
      void runtime.persistState();
    },
  });

  function recordDecision(decision: RouteDecision): void {
    lastDecision = decision;
    appendDecision(entryDataFromDecision(decision, spendNow().pressure));
  }

  function findVirtualModel(ctx: ExtensionContext) {
    return ctx.modelRegistry.find(virtualProvider, virtualId);
  }

  async function activateVirtual(ctx: ExtensionContext): Promise<boolean> {
    const model = findVirtualModel(ctx);
    if (!model || typeof pi.setModel !== "function") return false;
    try {
      const ok = await pi.setModel(model);
      if (ok) {
        dormant = false;
        dormantWarned = false;
        updateStatus(ctx, runtime.getActiveProfileName(), lastDecision, spendNow(), false);
      }
      return ok;
    } catch {
      return false;
    }
  }

  const commandsContext: ProCommandsContext = {
    runtime,
    proConfig,
    getModels: () => models,
    refreshModels: (ctx: ExtensionContext) => {
      models = toAvailable(ctx);
    },
    mode: () => effectiveMode(),
    setMode: (mode: Mode) => {
      sessionMode = mode;
    },
    enabled: () => effectiveEnabled(),
    setEnabled: (enabled: boolean) => {
      sessionEnabled = enabled;
    },
    isDormant: () => dormant,
    activateVirtual,
    virtualModelKey: () => virtualKey,
    lastDecision: () => lastDecision,
    recordDecision,
    spend: spendNow,
    quotaLines: () => {
      const codex = runtime.config.quota["openai-codex"];
      const input: QuotaStatusInput = {
        config: codex,
        snapshot: quota?.snapshot,
        lastError: quota?.lastError,
        restored: quota?.restored,
      };
      return { summary: quotaSummary(input), detail: describeQuotaStatus(input) };
    },
  };

  // The preview pipeline for `/jev-route` and the `jev_route` tool.
  async function analysePreview(text: string, ctx: ExtensionContext): Promise<AnalyseResult> {
    const notes: string[] = [];
    if (!hasApiKey(runtime.config)) {
      return { ok: false, analysisText: "", decisionText: "", error: `missing API key (env ${runtime.config.apiKeyEnv})` };
    }
    if (models.length === 0) models = toAvailable(ctx);
    const spend = spendNow();
    const contextTokens = ctx.getContextUsage?.()?.tokens ?? undefined;
    try {
      const analysis = await classifyCached({ prompt: text, history: undefined, contextTokens });
      const tierMath = computeTier(analysis, runtime.config, spend, notes);
      const chain = buildOrderedChain(runtime.config, analysis.kind, tierMath.index);
      const pick = firstAvailable(models, chain, eligibilityFor(), notes);
      const decisionText = pick
        ? `${decisionReason(analysis, tierMath.desiredIndex, tierMath.index)} → ${pick.target.provider}/${pick.target.model}`
        : "no eligible route available (check routes/kindModels for the judged tier)";
      return { ok: true, analysisText: formatAnalysisFull(analysis), decisionText: notes.length ? `${decisionText}\n${notes.join("\n")}` : decisionText };
    } catch (error) {
      const message = error instanceof JevError || error instanceof Error ? error.message : String(error);
      return { ok: false, analysisText: "", decisionText: "", error: message };
    }
  }

  // Optional durable, TUI-only decision rendering (feature-detected).
  await registerEntryRenderer(pi);

  pi.on("session_start", async (_event, ctx) => {
    models = toAvailable(ctx);
    try {
      await runtime.initialize();
    } catch {
      // Keep the previously loaded state; a warning already went out at load.
    }
    sessionMode = undefined;
    sessionEnabled = undefined;
    classifyCache.clear();

    quota?.stop();
    quota = undefined;
    const quotaConfig = runtime.config.quota["openai-codex"];
    if (quotaConfig?.enabled) {
      quota = new CodexQuotaCache(
        quotaConfig,
        async () => ctx.modelRegistry?.getApiKeyForProvider?.("openai-codex"),
        globalThis.fetch,
        Date.now,
        { stateFile: proQuotaPath() },
      );
      quota.start();
      try {
        await quota.ready;
      } catch {
        // Credential validation is best-effort; eligibility fails open.
      }
    }

    updateStatus(ctx, runtime.getActiveProfileName(), undefined, spendNow(), dormant);

    if (!legacyWarningShown && effectiveEnabled()) {
      const legacy = readLegacyRouterNames();
      if (legacy.length > 0) {
        legacyWarningShown = true;
        notify(
          ctx,
          `pi-jev-router-pro: legacy routing extensions also installed (${legacy.join(", ")}). ` +
            "Two routing surfaces may conflict; remove the legacy duo once verification is green.",
          "warning",
        );
      }
    }

    // R1.2: auto-select the virtual model when enabled (dormancy respected).
    if (effectiveEnabled() && !dormant && proConfig.dormancy !== false) {
      await activateVirtual(ctx);
    }

    if (effectiveEnabled() && !hasApiKey(runtime.config)) {
      notify(ctx, `pi-jev-router-pro: no API key. Set ${runtime.config.apiKeyEnv} (or add "apiKey" to the active profile).`, "warning");
    }
    if (effectiveEnabled() && !runtime.config.useDefaultModels) {
      const emptyTiers = TIERS.filter((tier) => tier !== "xpremium" && runtime.config.routes[tier].length === 0);
      if (emptyTiers.length > 0 && !runtime.getActiveProfileName()) {
        notify(ctx, `pi-jev-router-pro: useDefaultModels is off with no active profile and no models configured for: ${emptyTiers.join(", ")}.`, "warning");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    quota?.stop();
    await runtime.persistState();
  });

  // Dormancy (constitution §2): a manual physical-model selection parks the
  // router; selecting the virtual model re-activates it.
  pi.on("model_select", async (event, ctx) => {
    models = toAvailable(ctx);
    const isVirtual = event.model?.provider === virtualProvider && event.model?.id === virtualId;
    if (isVirtual) {
      dormant = false;
      dormantWarned = false;
    } else if (event.source === "restore") {
      dormant = true;
    } else {
      dormant = true;
      if (!dormantWarned) {
        dormantWarned = true;
        notify(ctx, `pi-jev-router-pro: physical model selected (${event.model.provider}/${event.model.id}) — routing is dormant. /jev auto re-activates it.`, "warning");
      }
    }
    updateStatus(ctx, runtime.getActiveProfileName(), undefined, spendNow(), dormant);
  });

  // Spend accounting: every assistant message carries its computed cost.
  pi.on("message_end", async (event) => {
    const message = event.message as { role?: string; provider?: string; model?: string; usage?: { cost?: { total?: number } } };
    if (message.role !== "assistant") return;
    const cost = message.usage?.cost?.total;
    const key = message.provider && message.model ? `${message.provider}/${message.model}` : "unknown";
    if (typeof cost === "number" && cost > 0) {
      recordCost(runtime.ledger, key, cost);
      void runtime.persistState();
    }
  });

  // ---------------------------------------------------------------- routing
  pi.registerVirtualModel<RouterState>({
    provider: virtualProvider,
    id: virtualId,
    name: proConfig.virtual?.name ?? "Auto (Jev Pro)",
    thinkingLevels: ["low", "medium", "high", "xhigh"],
    async route(request: ModelRouteRequest<RouterState>, ctx: ExtensionContext): Promise<ModelRoute<RouterState>> {
      const passthrough = request.previous?.model ?? request.failed?.model;
      const passthroughThinking = toThinkingLevel(request.previous?.thinkingLevel ?? request.failed?.thinkingLevel, request.thinkingLevel);

      // Dormant or disabled: inert passthrough, no notifications, no entries (R1.3).
      if (dormant || !effectiveEnabled()) {
        if (request.reason === "direct") {
          const chain = buildOrderedChain(runtime.config, "chat", 0);
          const pick = firstAvailable(models, chain, eligibilityFor());
          const directModel = pick ? ctx.modelRegistry.find(pick.target.provider, pick.target.model) : undefined;
          if (pick && directModel) return { model: directModel, thinkingLevel: request.thinkingLevel };
        }
        if (passthrough) {
          const model = ctx.modelRegistry.find(passthrough.provider, passthrough.id);
          if (model) return { model, thinkingLevel: passthroughThinking };
        }
        const chain = buildOrderedChain(runtime.config, "chat", TIERS.indexOf("standard"));
        const pick = firstAvailable(models, chain, eligibilityFor());
        if (!pick) throw new JevChainExhausted([], "router is inert and no candidate model is available");
        const model = ctx.modelRegistry.find(pick.target.provider, pick.target.model);
        if (!model) throw new JevChainExhausted([], `model ${pick.target.provider}/${pick.target.model} is not in the catalog`);
        return { model, thinkingLevel: request.thinkingLevel };
      }

      if (models.length === 0) models = toAvailable(ctx);

      // A retry after a fault-injected routing failure carries no `failed`
      // payload; synthesize the transient failure of the injected key so the
      // normal retry-advance path runs.
      if (request.reason === "retry" && !request.failed && pendingFaultKey) {
        const [provider, ...idParts] = pendingFaultKey.split("/");
        const id = idParts.join("/");
        const syntheticMessage = { stopReason: "error", errorMessage: faultError } as NonNullable<ModelRouteRequest<RouterState>["failed"]>["message"];
        request = {
          ...request,
          failed: {
            model: { ...request.model, provider, id },
            thinkingLevel: request.previous?.thinkingLevel,
            message: syntheticMessage,
          },
        };
        pendingFaultKey = undefined;
      }

      // R4.4: once a turn exhausted its chain, further retries of the same
      // turn keep failing visibly — never a silent re-dispatch of a dead model.
      if (request.reason === "user") exhaustedTurn = false;
      if (request.reason === "retry" && !request.failed && exhaustedTurn) {
        throw new JevChainExhausted((request.state?.attempted as string[] | undefined) ?? [], "chain already exhausted for this turn; no eligible model remains");
      }

      const input: RouteInput = {
        reason: request.reason,
        thinkingLevel: request.thinkingLevel,
        previous: request.previous
          ? { provider: request.previous.model.provider, id: request.previous.model.id, thinkingLevel: request.previous.thinkingLevel }
          : undefined,
        failed: request.failed
          ? {
              model: { provider: request.failed.model.provider, id: request.failed.model.id, thinkingLevel: request.failed.thinkingLevel ?? undefined },
              message: {
                stopReason: request.failed.message.stopReason,
                errorMessage: request.failed.message.errorMessage,
              },
            }
          : undefined,
        state: request.state,
        prompt: lastUserText(request.messages),
        history: historyExcerpt(request.messages, runtime.config.historyTurns),
        contextTokens: ctx.getContextUsage?.()?.tokens ?? undefined,
        signal: request.signal,
      };

      const env = routeEnvironment();
      env.notify = (message, level) => notify(ctx, message, level ?? "info");
      if (ctx.hasUI && typeof ctx.ui.confirm === "function") {
        env.confirmSwitch = async (decision) => {
          const answer = await ctx.ui.confirm(
            `Jev → ${decision.tier} (${decision.target.provider}/${decision.target.model})`,
            `${decision.reason}\nAccept this switch?`,
            runtime.config.confirm.timeoutMs > 0 ? { timeout: runtime.config.confirm.timeoutMs } : undefined,
          );
          return answer === true;
        };
      }

      const resolved = await (async (): Promise<Awaited<ReturnType<typeof resolveRoute>>> => {
        try {
          return await resolveRoute(input, env);
        } catch (error) {
          // R4.4: mark the turn exhausted so later retries fail visibly.
          if (error instanceof JevChainExhausted) exhaustedTurn = true;
          throw error;
        }
      })();
      const model = ctx.modelRegistry.find(resolved.route.provider, resolved.route.id);
        if (!model) {
          // Never invent models (constitution §3): the chain entry is not in
          // this build's catalog, so fall to the sticky target when possible.
          notify(ctx, `jev-router-pro: ${resolved.route.provider}/${resolved.route.id} is not in the catalog — staying put`, "warning");
          if (passthrough) {
            const previousModel = ctx.modelRegistry.find(passthrough.provider, passthrough.id);
            if (previousModel) {
              recordDecision({ ...resolved.decision, action: "skipped", reason: `${resolved.decision.reason} — target missing from catalog` });
              return { model: previousModel, thinkingLevel: passthroughThinking, state: resolved.state };
            }
          }
          throw new JevChainExhausted([], `dispatch target ${resolved.route.provider}/${resolved.route.id} is not in the catalog`);
        }

        // Fault injection (design §7): deterministic, offline fallback
        // verification against the operator's real second candidate.
        if (proConfig.faultInjection && faultRemaining > 0 && (request.reason === "user" || request.reason === "continuation")) {
          faultRemaining -= 1;
          if (faultMode === "throw") {
            // Exercise pi's real retry path: fail the request with a synthetic
            // transient error; the retry re-enters with the injected failure.
            pendingFaultKey = `${resolved.route.provider}/${resolved.route.id}`;
            notify(ctx, `jev-router-pro: fault injection → synthetic ${faultError} on ${pendingFaultKey} (real retry follows)`, "warning");
            throw new JevError(faultError);
          }
          // "advance" mode: skip the chosen candidate without a real failure.
          const attempted = new Set([...(resolved.state.attempted ?? []), `${resolved.route.provider}/${resolved.route.id}`]);
          const judgment = resolved.state.lastJudgment;
          const chain = buildOrderedChain(
            runtime.config,
            judgment?.kind ?? "chat",
            TIERS.indexOf(resolved.state.lastTier ?? resolved.decision.tier) >= 0 ? TIERS.indexOf(resolved.state.lastTier ?? resolved.decision.tier) : TIERS.indexOf("standard"),
          );
          const next = chain.filter((t) => !attempted.has(`${t.provider}/${t.model}`));
          const nextPick = firstAvailable(models, next, eligibilityFor(), []);
          const nextModel = nextPick ? ctx.modelRegistry.find(nextPick.target.provider, nextPick.target.model) : undefined;
          if (nextPick && nextModel) {
            notify(ctx, `jev-router-pro: fault injection → skipping ${resolved.route.provider}/${resolved.route.id}, dispatching ${nextPick.target.provider}/${nextPick.target.model}`, "warning");
            const advanced: RouteDecision = {
              ...resolved.decision,
              action: "fallback",
              target: nextPick.target,
              model: nextPick.model,
              thinkingLevel: nextPick.target.thinkingLevel ?? request.thinkingLevel,
              reason: `fault-injected transient failure on ${resolved.route.provider}/${resolved.route.id} → fallback`,
              notes: [...resolved.decision.notes, `fault injection: simulated ${faultError}`],
              failure: { kind: "transient", modelKey: `${resolved.route.provider}/${resolved.route.id}`, errorMessage: faultError },
            };
            recordDecision(advanced);
            updateStatus(ctx, runtime.getActiveProfileName(), advanced, spendNow(), dormant);
            return {
              model: nextModel,
              thinkingLevel: nextPick.target.thinkingLevel ?? request.thinkingLevel,
              state: {
                ...resolved.state,
                attempted: [...attempted, `${nextPick.target.provider}/${nextPick.target.model}`],
              },
            };
          }
          notify(ctx, `jev-router-pro: fault injection → no fallback candidate remains; failing visibly`, "warning");
          throw new JevChainExhausted([...attempted], `fault injection: ${faultError}`);
        }

        recordDecision(resolved.decision);
        updateStatus(ctx, runtime.getActiveProfileName(), resolved.decision, spendNow(), dormant);
        return { model, thinkingLevel: toThinkingLevel(resolved.route.thinkingLevel, request.thinkingLevel), state: resolved.state };
    },
  });

  // --------------------------------------------------------------- commands
  registerCommands(pi, commandsContext, { analyse: analysePreview });

  // -------------------------------------------------------------- jev_route
  if (typeof pi.registerTool === "function") {
    pi.registerTool({
      name: "jev_route",
      label: "Jev Route",
      description:
        "Ask TypeSafe Jev what kind of work a request is and which model tier it deserves. Returns typed judgments (task kind, complexity, capability deserved, deep-reasoning need) plus a recommended model from the configured tiers. Use when deciding how much model to spend on a subtask.",
      parameters: Type.Object({
        request: Type.String({ description: "The request or task text to classify" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await analysePreview(params.request, ctx);
        if (!result.ok) {
          return { content: [{ type: "text", text: `jev_route error: ${result.error}` }], details: undefined, isError: true };
        }
        return {
          content: [{ type: "text", text: [result.analysisText, "", result.decisionText].join("\n") }],
          details: { analysis: result.analysisText, decision: result.decisionText },
        };
      },
    });
  }
}
