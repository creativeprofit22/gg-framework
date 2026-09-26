import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAppSidecarKenLifecycle, createKenSessionInitializer, KenInitializationError,
  KenLifecycleBusyError, parseKenPromptInput, parseKenRunIdentity,
} from "./app-sidecar-ken-lifecycle.js";
import { AppSidecarSessionMutationCoordinator, runAppSidecarNewSessionMutation } from "./app-sidecar-session-mutation.js";
import { useFakeHome } from "./test-support/fake-home.js";
import { canonicalProjectKey } from "./project-notes-repository.js";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as ModelRegistryModule from "./core/model-registry.js";

vi.mock("@kenkaiiii/gg-agent", async () => ({
  ...await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent"),
  agentLoop: vi.fn(async function* () { yield { type: "agent_done" as const }; }),
}));
const sourceModelRegistry = new URL("../../gg-core/src/model-registry.ts", import.meta.url).href;
vi.doMock("./core/model-registry.js", async () => ({
  ...await vi.importActual<typeof ModelRegistryModule>("./core/model-registry.js"),
  ...await import(sourceModelRegistry),
}));
// Cold core dependency loading belongs to module collection, not a timed test.
const { AgentSession } = await import("./core/agent-session.js");

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

// Only initialization/provider, disk append and pane transport boundaries are
// faked. All target/run, retirement and lease decisions use production seams.
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ken-lifecycle-"));
  directories.push(dir);
  function build(id: string, file = id) {
    const turns: { text: string; reply: string }[] = [];
    return {
      id, file, turns,
      getConversationIdentity: () => ({ conversationId: id }),
      persistKenTurn: vi.fn(async (text: string, reply: string) => {
        await fs.appendFile(path.join(dir, file), JSON.stringify({ text, reply }) + "\n");
        turns.push({ text, reply });
      }),
    };
  }
  const old = build("OLD");
  const next = build("NEW");
  let session = old;
  const initialization = deferred();
  const enteredInitialization = deferred();
  const enteredProvider = deferred();
  const provider = deferred();
  const digestGate = deferred();
  digestGate.resolve();
  let reply = "";
  let signal!: AbortSignal;
  const history: string[] = [];
  const ken = {
    prompt: vi.fn(async (digest: string) => {
      history.push(digest);
      enteredProvider.resolve();
      await provider.promise;
      reply = `${digest} reply`;
      history.push(reply);
    }),
    setSignal: vi.fn((value: AbortSignal) => { signal = value; }),
    newSession: vi.fn(async (_preserve: boolean) => { history.length = 0; }),
  };
  const create = vi.fn(async (value: AbortSignal) => { signal = value; return ken; });
  const initialize = vi.fn(async () => { enteredInitialization.resolve(); await initialization.promise; });
  const ensureSession = createKenSessionInitializer({ create, initialize });
  const listeners = new Set<(type: string, data: object) => boolean>();
  const attached: ((type: string, data: object) => boolean)[] = [];
  const listen = vi.fn((_ken: typeof ken, publish: (type: string, data: object) => boolean) => {
    listeners.add(publish); attached.push(publish);
    return () => { listeners.delete(publish); };
  });
  const broadcast = vi.fn();
  const reportError = vi.fn((error: unknown) => ({ message: String(error) }));
  const clearPendingState = vi.fn();
  const switchModel = vi.fn(async (_ken: typeof ken, _model: string) => {});
  const mutations = new AppSidecarSessionMutationCoordinator();
  const buildContext = vi.fn(async (captured: typeof old, text: string) => {
    await digestGate.promise;
    return `${captured.id}: ${text}`;
  });
  const lifecycle = createAppSidecarKenLifecycle({
    mutations, getBuildSession: () => session, ensureSession, buildContext,
    replyText: () => reply, listen, broadcast, reportError, switchModel,
    currentModel: () => "model", clearPendingState,
    footerExtras: () => ({ id: session.id, turns: [...session.turns] }),
  });
  return {
    lifecycle, mutations, initialization, enteredInitialization, enteredProvider, provider,
    old, next, ken, create, initialize, buildContext, switchModel, history, attached, listeners,
    broadcast, reportError, clearPendingState, build, get signal() { return signal; },
    setBuild: (value: typeof old) => { session = value; },
    transition: (destination = next, retain = false) => {
      const finish = lifecycle.beginTransition(retain);
      session = destination;
      finish();
    },
    read: async (file: string) => fs.readFile(path.join(dir, file), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    }),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function accept(f: Fixture, text = "question") {
  const result = f.lifecycle.prompt(text, f.lifecycle.target);
  expect(result.status).toBe(202);
  if (result.status !== 202) throw new Error(`Unexpected rejection: ${result.status}`);
  return result;
}
async function running(f: Fixture, text = "question") {
  const run = accept(f, text);
  f.initialization.resolve();
  await f.enteredProvider.promise;
  return run;
}

describe("interactive Ken lifecycle", () => {
  it.each(["reset", "fresh-continuation", "rewind", "replacement"] as const)("refuses deferred OLD transport after %s and accepts the current target", async (kind) => {
    const f = await fixture();
    const captured = f.lifecycle.target;
    const transport = deferred();
    // The same JSON parser and admission calls used by POST /ken/prompt.
    const raw = JSON.stringify({ text: "OLD question", target: captured });
    const delivery = transport.promise.then(() => {
      const input = parseKenPromptInput(JSON.parse(raw));
      if (!input) throw new Error("Unexpected invalid transport body");
      return f.lifecycle.prompt(input.text, input.target);
    });
    // Fresh continuation uses the same non-retaining transition to a new conversation as reset.
    const fresh = kind === "reset" || kind === "fresh-continuation";
    f.transition(fresh ? f.next : kind === "replacement" ? f.build("OLD", "replacement") : f.old);
    await f.lifecycle.settled;
    f.broadcast.mockClear();
    transport.resolve();
    const refused = await delivery;
    expect(refused).toMatchObject({ status: 409, body: { error: "ken_target_stale", retryable: false } });
    expect(refused).not.toHaveProperty("identity");
    expect(f.lifecycle.state.activeRunId).toBeNull();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.buildContext).not.toHaveBeenCalled();
    expect(f.ken.prompt).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(await f.read("OLD")).toBe("");
    expect(await f.read("NEW")).toBe("");
    expect(await f.read("replacement")).toBe("");
    f.initialization.resolve(); f.provider.resolve();
    const current = accept(f, "current question");
    await current.completion;
    expect(f.ken.prompt).toHaveBeenCalledTimes(1);
    expect(current.identity).toMatchObject(f.lifecycle.target);
    expect(await f.read(fresh ? "NEW" : kind === "replacement" ? "replacement" : "OLD")).toContain("current question");
  });

  it("refuses captured transport in a distinct lifecycle with the same conversation ID, then accepts its own target", async () => {
    const source = await fixture();
    const captured = source.lifecycle.target;
    const raw = JSON.stringify({ text: "source question", target: captured });
    const transport = deferred();
    // A replaced logical session (or unrelated pane) owns a separate lifecycle,
    // even when its build reports exactly the same conversation ID.
    const destination = await fixture();
    expect(destination.lifecycle.target.conversationId).toBe(captured.conversationId);
    expect(destination.lifecycle.target.activationEpoch).not.toBe(captured.activationEpoch);
    const delivery = transport.promise.then(() => {
      const input = parseKenPromptInput(JSON.parse(raw));
      if (!input) throw new Error("Unexpected invalid transport body");
      return destination.lifecycle.prompt(input.text, input.target);
    });
    transport.resolve();
    const refused = await delivery;
    expect(refused).toMatchObject({ status: 409, body: { error: "ken_target_stale", retryable: false } });
    expect(refused).not.toHaveProperty("identity");
    for (const f of [source, destination]) {
      expect(f.lifecycle.state.activeRunId).toBeNull();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.buildContext).not.toHaveBeenCalled();
      expect(f.ken.prompt).not.toHaveBeenCalled();
      expect(f.old.persistKenTurn).not.toHaveBeenCalled();
      expect(f.next.persistKenTurn).not.toHaveBeenCalled();
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(await f.read("OLD")).toBe("");
    }
    destination.initialization.resolve(); destination.provider.resolve();
    const current = accept(destination, "destination question");
    await current.completion;
    expect(current.identity).toMatchObject(destination.lifecycle.target);
    expect(destination.ken.prompt).toHaveBeenCalledTimes(1);
    expect(destination.old.persistKenTurn).toHaveBeenCalledExactlyOnceWith("destination question", "OLD: destination question reply");
    expect(await destination.read("OLD")).toContain("destination question");
    expect(source.ken.prompt).not.toHaveBeenCalled();
    expect(source.old.persistKenTurn).not.toHaveBeenCalled();
    expect(await source.read("OLD")).toBe("");
  });

  it("rejects missing/malformed targets at both the daemon parser and direct admission without side effects", async () => {
    const f = await fixture();
    for (const target of [undefined, null, [], {}, "OLD", { conversationId: "OLD" },
      { conversationId: "OLD", activationEpoch: 1 }, { conversationId: " ", activationEpoch: "e" },
      { conversationId: "OLD", activationEpoch: " \n" }]) {
      expect(parseKenPromptInput({ text: "question", target })).toBeNull();
      const result = Reflect.apply(f.lifecycle.prompt, f.lifecycle, ["question", target]);
      expect(result).toMatchObject({ status: 400, body: { error: "invalid_ken_prompt", retryable: false } });
      expect(result).not.toHaveProperty("identity");
    }
    expect(parseKenPromptInput({ text: "question" })).toBeNull();
    expect(f.lifecycle.state.activeRunId).toBeNull();
    expect(f.mutations.owner).toBeNull();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.buildContext).not.toHaveBeenCalled();
    expect(f.ken.prompt).not.toHaveBeenCalled();
    expect(f.old.persistKenTurn).not.toHaveBeenCalled();
    expect(f.next.persistKenTurn).not.toHaveBeenCalled();
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("compares target under the startup lease and blocks reentrant reset until acceptance finishes", async () => {
    const f = await fixture();
    const captured = f.lifecycle.target;
    f.broadcast.mockImplementationOnce(() => {
      expect(f.mutations.owner?.kind).toBe("ken-start");
      expect(() => f.lifecycle.beginTransition()).toThrow(KenLifecycleBusyError);
    });
    const run = f.lifecycle.prompt("question", captured);
    expect(run.status).toBe(202);
    expect(f.mutations.owner).toBeNull();
    f.initialization.resolve(); f.provider.resolve();
    if (run.status === 202) await run.completion;
    expect(f.old.turns).toHaveLength(1);
  });

  it("persists and publishes valid same-conversation completions, retaining mentor history", async () => {
    const f = await fixture();
    const run = await running(f);
    expect(f.mutations.owner).toBeNull();
    f.provider.resolve();
    await run.completion;
    expect(f.old.turns).toEqual([{ text: "question", reply: "OLD: question reply" }]);
    expect(await f.read("OLD")).toContain("OLD: question reply");
    expect(f.broadcast).toHaveBeenCalledWith("extras", { id: "OLD", turns: f.old.turns, ken: run.identity });
    expect(f.broadcast).toHaveBeenCalledWith("ken_run_end", { ken: run.identity });
    const again = accept(f, "again");
    await again.completion;
    expect(again.identity.activationEpoch).toBe(run.identity.activationEpoch);
    expect(again.identity.runId).not.toBe(run.identity.runId);
    expect(f.history).toHaveLength(4);
    expect(f.ken.newSession).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.running).toBe(false);
  });

  it.each(["initialization", "digest", "provider"] as const)(
    "does not persist or publish OLD into NEW after deferred %s", async (boundary) => {
      const f = await fixture();
      const digest = deferred<string>();
      const digestEntered = deferred();
      if (boundary === "digest") f.buildContext.mockImplementationOnce(async () => {
        digestEntered.resolve(); return digest.promise;
      });
      const run = accept(f, "OLD question");
      await f.enteredInitialization.promise;
      if (boundary !== "initialization") f.initialization.resolve();
      if (boundary === "digest") await digestEntered.promise;
      if (boundary === "provider") await f.enteredProvider.promise;
      const capturedSignal = f.signal;
      f.transition();
      expect(capturedSignal.aborted).toBe(true);
      expect(f.lifecycle.prompt("NEW question", f.lifecycle.target).status).toBe(409);
      f.broadcast.mockClear();
      f.initialization.resolve(); digest.resolve("OLD digest"); f.provider.resolve();
      await run.completion;
      expect(await f.read("NEW")).toBe("");
      expect(f.next.turns).toEqual([]);
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.reportError).not.toHaveBeenCalled();
      expect(f.ken.newSession).toHaveBeenCalledWith(false);
      expect(f.history).toEqual([]);
      const nextRun = accept(f, "NEW question");
      await nextRun.completion;
      expect(f.next.turns[0]?.reply).toBe("NEW: NEW question reply");
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.signal.aborted).toBe(false);
    },
  );

  it("consumes late listener snapshots without publishing or leaking listeners", async () => {
    const f = await fixture();
    const run = await running(f);
    const publish = f.attached[0]!;
    expect(publish("ken_text_delta", { text: "current" })).toBe(true);
    f.transition(); f.broadcast.mockClear();
    for (const type of ["ken_text_delta", "ken_thinking_delta", "ken_tool_call_start", "ken_tool_call_end", "ken_turn_end", "ken_error"]) {
      expect(publish(type, { text: "OLD" })).toBe(false);
    }
    expect(f.listeners.size).toBe(0);
    f.provider.resolve(); await run.completion;
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.clearPendingState).toHaveBeenCalled();
  });

  it("suppresses deferred OLD provider rejection after transition", async () => {
    const f = await fixture(); const run = await running(f);
    f.transition(); f.broadcast.mockClear();
    f.provider.reject(new Error("late OLD failure"));
    await run.completion;
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.ken.newSession).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.running).toBe(false);
  });

  it("reports current provider rejection and retires partial context", async () => {
    const f = await fixture(); const run = await running(f);
    f.provider.reject(new Error("provider failed")); await run.completion;
    expect(f.broadcast).toHaveBeenCalledWith("ken_error", expect.objectContaining({ ken: run.identity }));
    expect(f.history).toEqual([]);
    expect(f.lifecycle.running).toBe(false);
    expect(await f.read("OLD")).toBe("");
  });

  it("OLD finally cannot clear NEW ownership: fail-fast during retirement, then safe subsequent run", async () => {
    const f = await fixture(); const oldRun = await running(f, "OLD question");
    const retirement = deferred(); const retiring = deferred();
    f.ken.newSession.mockImplementationOnce(async () => { retiring.resolve(); await retirement.promise; f.history.length = 0; });
    expect(f.lifecycle.cancel(oldRun.identity)).toBe(true);
    f.transition(); f.broadcast.mockClear();
    expect(f.lifecycle.prompt("NEW question", f.lifecycle.target).status).toBe(409);
    f.provider.resolve(); await retiring.promise;
    expect(f.lifecycle.prompt("NEW question", f.lifecycle.target).status).toBe(409);
    expect(f.ken.prompt).toHaveBeenCalledTimes(1);
    retirement.resolve(); await oldRun.completion;
    expect(f.broadcast).not.toHaveBeenCalled();
    const newProvider = deferred(); const entered = deferred();
    f.ken.prompt.mockImplementationOnce(async () => { entered.resolve(); await newProvider.promise; });
    const newRun = accept(f, "NEW question"); await entered.promise;
    expect(f.lifecycle.cancel(oldRun.identity)).toBe(false);
    expect(f.lifecycle.running).toBe(true);
    expect(f.signal.aborted).toBe(false);
    newProvider.resolve(); await newRun.completion;
    expect(f.lifecycle.running).toBe(false);
  });

  it("cancel preserves persisted completed turns but resets partial aborted mentor memory", async () => {
    const f = await fixture(); const first = await running(f); f.provider.resolve(); await first.completion;
    const gate = deferred(); const entered = deferred();
    f.ken.prompt.mockImplementationOnce(async () => { f.history.push("partial"); entered.resolve(); await gate.promise; });
    const second = accept(f); await entered.promise;
    f.lifecycle.cancel(second.identity); gate.resolve(); await second.completion;
    expect(f.old.turns).toHaveLength(1);
    expect(f.history).toEqual([]);
    expect(f.lifecycle.target.activationEpoch).toBe(first.identity.activationEpoch);
  });

  it("holds the mentor slot through a queued model switch and never races another provider", async () => {
    const f = await fixture(); const run = await running(f);
    const switched = deferred(); const switchEntered = deferred();
    f.switchModel.mockImplementationOnce(async () => { switchEntered.resolve(); await switched.promise; });
    await f.lifecycle.syncModel("next-model");
    f.provider.resolve(); await switchEntered.promise;
    expect(f.lifecycle.prompt("too early", f.lifecycle.target).status).toBe(409);
    switched.resolve(); await run.completion;
    const again = accept(f); await again.completion;
    expect(f.ken.prompt).toHaveBeenCalledTimes(2);
  });

  it("invalidates delayed startup model switching before digest/provider and clears queued models", async () => {
    const f = await fixture(); const gate = deferred(); const entered = deferred();
    f.switchModel.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const run = accept(f); f.initialization.resolve(); await entered.promise;
    await f.lifecycle.syncModel("stale-pending");
    f.transition(); f.broadcast.mockClear(); gate.resolve(); await run.completion;
    expect(f.buildContext).not.toHaveBeenCalled();
    expect(f.ken.prompt).not.toHaveBeenCalled();
    expect(f.switchModel).not.toHaveBeenCalledWith(f.ken, "stale-pending");
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("retires only after an idle model switch settles", async () => {
    const f = await fixture(); const first = await running(f); f.provider.resolve(); await first.completion;
    const gate = deferred(); const entered = deferred();
    f.switchModel.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const switching = f.lifecycle.syncModel("idle-model"); await entered.promise;
    f.transition();
    expect(f.ken.newSession).not.toHaveBeenCalled();
    expect(f.lifecycle.prompt("busy", f.lifecycle.target).status).toBe(409);
    gate.resolve(); await switching;
    expect(f.ken.newSession).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.running).toBe(false);
  });

  it.each(["checkpoint", "compaction", "failed-checkpoint"] as const)(
    "retains epoch and context across %s overlapping a provider, then appends to verified current destination", async (kind) => {
      const f = await fixture(); const run = await running(f);
      const destination = f.build("OLD", "checkpoint");
      if (kind === "compaction") f.setBuild(destination);
      else {
        const finish = f.lifecycle.beginTransition(true);
        // Failure leaves the source authoritative, without reviving invalid runs.
        if (kind === "checkpoint") f.setBuild(destination);
        finish();
      }
      expect(f.lifecycle.target.activationEpoch).toBe(run.identity.activationEpoch);
      f.provider.resolve(); await run.completion;
      expect(f.ken.newSession).not.toHaveBeenCalled();
      expect(f.history).toHaveLength(2);
      expect(await f.read(kind === "failed-checkpoint" ? "OLD" : "checkpoint")).toContain("OLD: question reply");
      if (kind !== "failed-checkpoint") expect(f.old.persistKenTurn).not.toHaveBeenCalled();
    },
  );

  it("same-conversation checkpoint append conflict is retryable without suppressing completion or resetting valid memory", async () => {
    const f = await fixture(); const run = await running(f);
    const finish = f.lifecycle.beginTransition(true);
    f.provider.resolve(); await run.completion;
    expect(f.old.persistKenTurn).not.toHaveBeenCalled();
    expect(f.broadcast).toHaveBeenCalledWith("ken_error", expect.objectContaining({ ken: run.identity, retryable: true }));
    expect(f.broadcast).toHaveBeenCalledWith("ken_run_end", { ken: run.identity });
    expect(f.ken.newSession).not.toHaveBeenCalled();
    expect(f.history).toHaveLength(2);
    finish();
    expect(f.lifecycle.target.activationEpoch).toBe(run.identity.activationEpoch);
  });

  it.each(["history-replacement", "failed-reset"] as const)("invalidates %s even when conversation ID stays the same", async () => {
    const f = await fixture(); const run = await running(f);
    const finish = f.lifecycle.beginTransition();
    finish(); // Actual authoritative source remains OLD, including on failure.
    expect(f.lifecycle.target.conversationId).toBe("OLD");
    expect(f.lifecycle.target.activationEpoch).not.toBe(run.identity.activationEpoch);
    f.broadcast.mockClear(); f.provider.resolve(); await run.completion;
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.ken.newSession).toHaveBeenCalledWith(false);
    const again = accept(f); await again.completion;
    expect(f.old.turns).toHaveLength(1);
  });

  it("append wins: reset is rejected before invalidation until durable append releases", async () => {
    const f = await fixture(); const run = await running(f);
    const append = deferred(); const entered = deferred();
    f.old.persistKenTurn.mockImplementationOnce(async () => { entered.resolve(); await append.promise; });
    f.provider.resolve(); await entered.promise;
    expect(f.mutations.owner?.kind).toBe("ken-append");
    expect(() => f.lifecycle.beginTransition()).toThrow(KenLifecycleBusyError);
    const perform = vi.fn();
    const reset = await runAppSidecarNewSessionMutation({
      mutations: f.mutations, busyState: { running: false, autopilotActive: false, runLifecycleRunning: false }, perform,
    });
    expect(reset.status).toBe(409); expect(perform).not.toHaveBeenCalled();
    expect(f.lifecycle.target.activationEpoch).toBe(run.identity.activationEpoch);
    append.resolve(); await run.completion;
    f.transition(); await f.lifecycle.settled;
    expect(f.lifecycle.target.conversationId).toBe("NEW");
  });

  it("reset wins: startup is rejected and OLD append never runs; reset does not await provider", async () => {
    const f = await fixture(); const run = await running(f);
    const reset = await runAppSidecarNewSessionMutation({
      mutations: f.mutations, busyState: { running: false, autopilotActive: false, runLifecycleRunning: false },
      perform: async () => { f.transition(); },
    });
    expect(reset.status).toBe(200);
    expect(f.lifecycle.prompt("NEW", f.lifecycle.target).status).toBe(409);
    f.provider.resolve(); await run.completion;
    expect(f.old.persistKenTurn).not.toHaveBeenCalled();
    expect(f.next.persistKenTurn).not.toHaveBeenCalled();
  });

  it("phase scope leaves the coordinator available for the launcher's synchronous lease", async () => {
    const f = await fixture();
    const finish = f.lifecycle.beginTransition(false, true);
    const lease = f.mutations.tryAcquire("phase-start"); expect(lease).not.toBeNull();
    expect(f.lifecycle.prompt("during phase setup", f.lifecycle.target).status).toBe(409);
    f.setBuild(f.next); lease!.release(); finish(); await f.lifecycle.settled;
    expect(f.lifecycle.target.conversationId).toBe("NEW");
  });

  it("another pane keeps its own target, signal, provider and persistence", async () => {
    const a = await fixture(); const b = await fixture();
    const aRun = await running(a); const bRun = await running(b);
    a.transition(); a.provider.resolve(); await aRun.completion;
    expect(b.signal.aborted).toBe(false);
    expect(b.lifecycle.target.activationEpoch).toBe(bRun.identity.activationEpoch);
    b.provider.resolve(); await bRun.completion;
    expect(b.old.turns).toHaveLength(1);
    expect(b.ken.newSession).not.toHaveBeenCalled();
  });

  it("initialization rejection is non-retryable and cannot allocate replacement instances", async () => {
    const f = await fixture(); const run = accept(f); await f.enteredInitialization.promise;
    f.initialization.reject(new Error("partial resources")); await run.completion;
    expect(f.lifecycle.running).toBe(false);
    const retry = f.lifecycle.prompt("retry", f.lifecycle.target);
    expect(retry).toMatchObject({ status: 503, body: { retryable: false, error: "ken_initialization_failed" } });
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.initialize).toHaveBeenCalledTimes(1);
    expect(f.ken.newSession).not.toHaveBeenCalled();
    expect(f.broadcast).toHaveBeenCalledWith("ken_error", expect.objectContaining({ retryable: false, ken: run.identity }));
  });

  it("late rejected initialization latches safely without broadcasting into NEW", async () => {
    const f = await fixture(); const run = accept(f); await f.enteredInitialization.promise;
    f.transition(); f.broadcast.mockClear();
    f.initialization.reject(new Error("partial resources")); await run.completion;
    expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.lifecycle.prompt("NEW", f.lifecycle.target)).toMatchObject({ status: 503, body: { retryable: false } });
    expect(f.lifecycle.running).toBe(false);
  });

  it("failed retirement fails closed, releases ownership, and can retry reset without new allocation", async () => {
    const f = await fixture(); const run = await running(f);
    f.ken.newSession.mockRejectedValueOnce(new Error("reset failed"));
    f.lifecycle.cancel(run.identity); f.provider.resolve(); await run.completion;
    expect(f.lifecycle.running).toBe(false);
    expect(f.lifecycle.prompt("retry reset", f.lifecycle.target).status).toBe(409);
    await f.lifecycle.settled;
    const retry = accept(f); await retry.completion;
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});

describe("core before-transition integration", () => {
  // The existing reviewer-store pattern: isolated home/store, fake provider,
  // disabled MCP/customization, and only public AgentSession operations.
  async function withCoreStore(run: (create: () => Promise<InstanceType<typeof AgentSession>>, store: string) => Promise<void>) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ken-core-store-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const store = path.join(root, "sessions");
    const restoreHome = useFakeHome(home);
    try {
      await fs.mkdir(cwd, { recursive: true });
      await fs.mkdir(path.join(home, ".gg"), { recursive: true });
      await fs.writeFile(path.join(home, ".gg", "auth.json"), JSON.stringify({ openai: {
        accessToken: ["test", "token"].join("-"), refreshToken: ["test", "refresh"].join("-"),
        expiresAt: Date.now() + 3_600_000, accountId: "chatgpt-account",
      } }));
      await fs.writeFile(path.join(home, ".gg", "settings.json"), JSON.stringify({ autoCompact: false }));
      await run(async () => {
        const session = new AgentSession({
          provider: "openai", model: "gpt-6-astra", cwd, sessionRootDir: store,
          systemPrompt: "deterministic test", mcpEnabled: false,
          projectCustomization: false, selfCorrectionHooks: false,
        });
        await session.initialize();
        return session;
      }, store);
    } finally {
      restoreHome();
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("branch invalidates before its first awaited sessionManager.load and rebinds on rejection", async () => {
    await withCoreStore(async (create) => {
      const core = await create();
      const sourcePath = core.getState().sessionPath;
      const source = await fs.readFile(sourcePath, "utf8");
      const identity = core.getConversationIdentity();
      // A real empty conversation loads successfully, then rejects the rewind.
      // This exercises the await boundary without inducing an unrelated missing-
      // file stream error in SessionManager's reader.
      const f = await fixture(); const run = await running(f);
      const finalized = vi.fn();
      const before = vi.fn(() => {
        const finish = f.lifecycle.beginTransition();
        return () => { finish(); finalized(); };
      });
      core.setBeforeConversationTransition(before);
      const branch = core.branch();
      // No await between invocation and these ownership assertions.
      expect(before).toHaveBeenCalledExactlyOnceWith("history");
      expect(finalized).not.toHaveBeenCalled();
      expect(f.signal.aborted).toBe(true);
      expect(f.lifecycle.target.activationEpoch).not.toBe(run.identity.activationEpoch);
      await expect(branch).rejects.toThrow("Cannot branch — already at the start of the conversation.");
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(core.getConversationIdentity()).toEqual(identity);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
      f.broadcast.mockClear(); f.provider.resolve(); await run.completion;
      expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.lifecycle.target.conversationId).toBe("OLD");
      expect(f.mutations.owner).toBeNull();
    });
  });

  it.each([
    { retain: false, boundary: "allocation" }, { retain: true, boundary: "allocation" },
    { retain: false, boundary: "required-append" }, { retain: true, boundary: "required-append" },
  ])("newSession($retain) preserves authoritative source on $boundary failure without reviving invalidated work", async ({ retain, boundary }) => {
    await withCoreStore(async (create, store) => {
      const core = await create();
      await core.prompt("source question"); // Suite's fake provider; never network.
      await core.persistKenTurn("source advice", "completed source reply");
      await core.persistAppMarker("user_hint", { kenSent: true });
      await core.setRoadmapPhaseLeaseMarker({
        version: 1, projectKey: canonicalProjectKey(path.join(path.dirname(store), "project")),
        phaseId: "phase", planId: null, planHash: null, leaseId: "lease", fence: 1, daemonInstanceId: "daemon",
      });
      const identity = core.getConversationIdentity();
      const sourcePath = core.getState().sessionPath;
      const messages = structuredClone(core.getMessages());
      const kenTurns = structuredClone(core.getKenTurns());
      const appMarkers = structuredClone(core.getAppMarkers());
      const source = await fs.readFile(sourcePath, "utf8");
      const f = await fixture();
      const lifecycle = createAppSidecarKenLifecycle({
        mutations: f.mutations, getBuildSession: () => core,
        ensureSession: async () => f.ken,
        buildContext: async (_build, text) => text,
        replyText: () => "pending reply", listen: () => () => {},
        footerExtras: () => ({}), broadcast: f.broadcast, reportError: f.reportError,
        switchModel: f.switchModel, currentModel: () => "model", clearPendingState: f.clearPendingState,
      });
      const run = lifecycle.prompt("pending question", lifecycle.target);
      if (run.status !== 202) throw new Error(`Unexpected rejection: ${run.status}`);
      await f.enteredProvider.promise;
      const finalized = vi.fn();
      core.setBeforeConversationTransition((kind) => {
        expect(core.getConversationIdentity()).toEqual(identity);
        expect(kind).toBe(retain ? "checkpoint" : "reset");
        const finish = lifecycle.beginTransition(kind === "checkpoint");
        return () => { finish(); finalized(); };
      });
      let allocatedDestination: string | undefined;
      const open = fs.open.bind(fs);
      let fault: ReturnType<typeof vi.spyOn> | undefined;
      if (boundary === "allocation") {
        // Real allocation failure; source bytes are held safely aside.
        await fs.rename(store, `${store}.held`);
        await fs.writeFile(store, "not a directory");
      } else {
        // Fail only the required destination write, after a real header has
        // been allocated. This is the filesystem boundary, not a private override.
        fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          if (String(args[0]) !== sourcePath && args[1] === "a") {
            allocatedDestination = String(args[0]);
            throw new Error("required destination append failed");
          }
          return open(...args);
        });
      }
      try {
        const reset = core.newSession(retain);
        expect(finalized).not.toHaveBeenCalled();
        expect(f.signal.aborted).toBe(!retain);
        if (boundary === "allocation") {
          await expect(reset).rejects.toMatchObject({ code: expect.stringMatching(/ENOTDIR|EEXIST/) });
        } else {
          await expect(reset).rejects.toMatchObject({ cause: { message: "required destination append failed" } });
        }
      } finally { fault?.mockRestore(); }
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(f.mutations.owner).toBeNull();
      expect.soft(core.getConversationIdentity()).toEqual(identity);
      expect.soft(core.getState().sessionPath).toBe(sourcePath);
      expect.soft(core.getMessages()).toEqual(messages);
      expect.soft(core.getKenTurns()).toEqual(kenTurns);
      expect.soft(core.getAppMarkers()).toEqual(appMarkers);
      expect.soft(lifecycle.target.conversationId).toBe(identity.conversationId);
      if (retain) expect.soft(lifecycle.target.activationEpoch).toBe(run.identity.activationEpoch);
      else expect.soft(lifecycle.target.activationEpoch).not.toBe(run.identity.activationEpoch);
      if (boundary === "allocation") {
        await fs.rm(store);
        await fs.rename(`${store}.held`, store);
      } else {
        expect(allocatedDestination).toBeDefined();
        await expect(fs.stat(allocatedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
      f.broadcast.mockClear();
      f.provider.resolve(); await run.completion;
      expect(core.getKenTurns()).toHaveLength(kenTurns.length + (retain ? 1 : 0));
      if (!retain) {
        expect(f.broadcast.mock.calls.filter(([type]) => type !== "extras")).toEqual([]);
        expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
        expect(f.history).toEqual([]);
      }
    });
  });

  it("checkpoint retention verifies the supplied conversation against the durable header before mutation", async () => {
    await withCoreStore(async (create) => {
      const core = await create(); const wrong = await create();
      const identity = core.getConversationIdentity();
      expect(wrong.getConversationIdentity().conversationId).not.toBe(identity.conversationId);
      const sourcePath = core.getState().sessionPath;
      const source = await fs.readFile(sourcePath, "utf8");
      const messages = [...core.getMessages()];
      const f = await fixture(); const run = await running(f);
      const finalized = vi.fn();
      const before = vi.fn((kind: "reset" | "restore" | "history" | "checkpoint") => {
        expect(kind).toBe("checkpoint");
        const finish = f.lifecycle.beginTransition(true);
        return () => { finish(); finalized(); };
      });
      core.setBeforeConversationTransition(before);
      const checkpoint = core.loadSessionCheckpoint(wrong.getState().sessionPath, identity.conversationId);
      expect(before).toHaveBeenCalledExactlyOnceWith("checkpoint");
      expect(finalized).not.toHaveBeenCalled();
      await expect(checkpoint).rejects.toThrow("Checkpoint conversation does not match");
      expect(finalized).toHaveBeenCalledTimes(1);
      expect(core.getConversationIdentity()).toEqual(identity);
      expect(core.getMessages()).toEqual(messages);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
      expect(f.lifecycle.target.activationEpoch).toBe(run.identity.activationEpoch);
      f.provider.resolve(); await run.completion;
      expect(f.old.turns).toHaveLength(1);
      expect(f.ken.newSession).not.toHaveBeenCalled();
    });
  });
});

describe("initialization and request validation", () => {
  it("retries only pre-allocation preparation failure, then initializes once", async () => {
    const ken = {};
    const create = vi.fn(async () => ken).mockRejectedValueOnce(new Error("prompt file unavailable"));
    const initialize = vi.fn(async () => {});
    const ensure = createKenSessionInitializer({ create, initialize });
    await expect(ensure(new AbortController().signal)).rejects.toThrow("prompt file unavailable");
    await expect(ensure(new AbortController().signal)).resolves.toBe(ken);
    await expect(ensure(new AbortController().signal)).resolves.toBe(ken);
    expect(create).toHaveBeenCalledTimes(2); expect(initialize).toHaveBeenCalledTimes(1);
  });
  it("does not retry resource allocation after an initialization failure", async () => {
    const create = vi.fn(async () => ({})); const initialize = vi.fn(async () => { throw new Error("partial"); });
    const ensure = createKenSessionInitializer({ create, initialize });
    await expect(ensure(new AbortController().signal)).rejects.toBeInstanceOf(KenInitializationError);
    await expect(ensure(new AbortController().signal)).rejects.toBeInstanceOf(KenInitializationError);
    expect(create).toHaveBeenCalledTimes(1); expect(initialize).toHaveBeenCalledTimes(1);
  });
  it("rejects non-string/empty prompt bodies without coercion and preserves valid text", () => {
    for (const value of [null, [], {}, { text: 1 }, { text: false }, { text: {} }, { text: " \n" }]) {
      expect(parseKenPromptInput(value)).toBeNull();
    }
    const target = { conversationId: "c", activationEpoch: "e" };
    expect(parseKenPromptInput({ text: " question\n", target })).toEqual({ text: " question\n", target });
    for (const text of [1, false, {}, " \n"]) expect(parseKenPromptInput({ text, target })).toBeNull();
  });
  it("requires full nonempty cancellation ownership metadata", () => {
    for (const value of [undefined, null, {}, { runId: "r" }, { conversationId: "c", activationEpoch: "e", runId: 3 }]) {
      expect(parseKenRunIdentity(value)).toBeNull();
    }
    expect(parseKenRunIdentity({ conversationId: "c", activationEpoch: "e", runId: "r" }))
      .toEqual({ conversationId: "c", activationEpoch: "e", runId: "r" });
  });
});
