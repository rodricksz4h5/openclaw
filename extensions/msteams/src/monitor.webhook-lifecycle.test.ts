import { createEmptyPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import {
  getMSTeamsMonitorTestState,
  getMSTeamsRouteBaseUrl,
  holdMSTeamsWebhookBodies,
} from "./monitor-lifecycle.test-support.js";
import { monitorMSTeamsProvider } from "./monitor.js";

const {
  routes,
  monitorReady,
  registerRouteMock,
  handleSdkRequest,
  loadMSTeamsSdkWithAuth,
  logger,
} = getMSTeamsMonitorTestState();

describe("Microsoft Teams Gateway webhook lifecycle", () => {
  it.each(["/ready?tenant=one", "/api/channels/teams", "/%61pi/channels/teams"])(
    "refuses unavailable %s without a legacy callback",
    async (path) => {
      const cfg = createConfig();
      updateMSTeamsConfig(cfg, { webhook: { path }, legacyWebhook: false });
      await expect(
        monitorMSTeamsProvider({ cfg, runtime: createRuntime(), ...createStores() }),
      ).rejects.toThrow("18789/api/messages");
      expect(registerRouteMock).not.toHaveBeenCalled();

      updateMSTeamsConfig(cfg, { legacyWebhook: undefined });
      const abort = new AbortController();
      const task = monitorMSTeamsProvider({
        cfg,
        runtime: createRuntime(),
        abortSignal: abort.signal,
        ...createStores(),
      });
      await monitorReady.current.promise;
      expect(routes.get(path)?.legacyListener).toEqual({ port: 3978 });
      abort.abort();
      await task;
    },
  );

  it("cleans up ingress when Gateway route registration fails", async () => {
    registerRouteMock.mockImplementationOnce(() => {
      throw new Error("route already owned");
    });
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(),
        runtime: createRuntime(),
        ...createStores(),
      }),
    ).rejects.toThrow("route already owned");
    expect(getMSTeamsIngressMockState().instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("rejects requests without Bearer token before SDK route", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await monitorReady.current.promise;
    expect(routes.get("/api/messages")?.legacyListener).toBeUndefined();
    const unauthorized = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: "Unauthorized" });

    const authorized = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(authorized.status).toBe(200);

    abort.abort();
    await task;
  });

  it("bounds partial bodies across aliases and releases capacity after SDK failures", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { webhook: { path: "/teams/events" } });
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    await monitorReady.current.promise;
    const capacity = 8;
    const held = await holdMSTeamsWebhookBodies("/teams/events", capacity);
    const post = () =>
      fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
        method: "POST",
        headers: { authorization: "Bearer x" },
        body: "{}",
      });
    try {
      const overflow = await post();
      expect(overflow.status).toBe(429);
      expect(await overflow.text()).toBe("Too Many Requests");
      expect(await held.complete()).toEqual(Array<number>(capacity).fill(200));
      for (let index = 0; index < capacity; index += 1) {
        handleSdkRequest.mockRejectedValueOnce(new Error("synthetic SDK failure"));
      }
      const failures = await Promise.allSettled(Array.from({ length: capacity }, post));
      expect(failures.every((result) => result.status === "rejected")).toBe(true);
      const recovered = await post();
      expect(recovered.status).toBe(200);
      await recovered.text();
    } finally {
      await held.stop();
      abort.abort();
      await task;
    }
  });

  it("requires the per-run QA token and direct loopback before SDK dispatch", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    Object.defineProperty(globalThis, Symbol.for("openclaw.msteams.privateQaRuntime"), {
      configurable: true,
      value: { connectorUrl: "http://127.0.0.1:1/", nonce: "qa-nonce", botToken: "qa-token" },
    });
    const abort = new AbortController();
    const cfg = createConfig();
    cfg.gateway = { trustedProxies: ["127.0.0.2"] };
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
    });
    await monitorReady.current.promise;
    try {
      for (const [clientIp, authorization, proxyHeader, proxyValue, expectedStatus] of [
        ["198.51.100.10", "Bearer qa-token", "", "", 401],
        ["198.51.100.10", "Bearer qa-token", "x-forwarded-for", "127.0.0.1", 401],
        ["127.0.0.1", "Bearer private-qa", "", "", 401],
        ["127.0.0.2", "Bearer qa-token", "x-forwarded-for", "198.51.100.10", 401],
        ["127.0.0.2", "Bearer qa-token", "x-forwarded-for", "127.0.0.1", 401],
        ["127.0.0.2", "Bearer qa-token", "x-forwarded-proto", "https", 401],
        ["127.0.0.2", "Bearer qa-token", "forwarded", "for=127.0.0.1", 401],
        ["127.0.0.2", "Bearer qa-token", "x-real-ip", "127.0.0.1", 401],
        ["127.0.0.2", "Bearer qa-token", "", "", 200],
        ["127.0.0.1", "Bearer qa-token", "", "", 200],
      ] as const) {
        const response = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
          method: "POST",
          headers: {
            authorization,
            "x-test-client-ip": clientIp,
            ...(proxyHeader ? { [proxyHeader]: proxyValue } : {}),
          },
        });
        expect(response.status).toBe(expectedStatus);
        await response.text();
      }
      expect(handleSdkRequest).toHaveBeenCalledTimes(2);
    } finally {
      abort.abort();
      await task;
    }
  });

  it("keeps oversized webhook parse failures JSON-shaped", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await monitorReady.current.promise;
    const response = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer valid-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(1024 * 1024) }),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Payload too large" });

    abort.abort();
    await task;
  });

  it("forwards legacy /api/messages requests to a custom webhook path", async () => {
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, {
      webhook: { path: "/teams/events" },
      legacyWebhook: { port: 44978 },
    });
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await monitorReady.current.promise;
    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      messagingEndpoint: "/teams/events",
    });
    expect(routes.get("/teams/events")?.legacyListener).toEqual({ port: 44978 });
    const response = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, {
      method: "POST",
      headers: { authorization: "Bearer valid" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ body: {} });

    abort.abort();
    await task;
  });

  it("serves the configured route when another plugin owns the deprecated alias", async () => {
    const registry = createEmptyPluginRegistry();
    const { registerPluginHttpRoute } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/webhook-ingress")
    >("openclaw/plugin-sdk/webhook-ingress");
    const unregisterOther = registerPluginHttpRoute({
      registry,
      path: "/api/messages",
      auth: "plugin",
      pluginId: "other-plugin",
      source: "webhook",
      handler: (_req, res) => {
        res.writeHead(200).end("other-plugin");
      },
      throwOnFailure: true,
    });
    const register = (route: Parameters<typeof registerPluginHttpRoute>[0]) =>
      registerPluginHttpRoute({ ...route, registry });
    registerRouteMock.mockImplementationOnce(register).mockImplementationOnce(register);
    const abort = new AbortController();
    const cfg = createConfig();
    updateMSTeamsConfig(cfg, { webhook: { path: "/teams/events" } });
    const statusSink = vi.fn();
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      statusSink,
      ...createStores(),
    });
    try {
      await Promise.race([monitorReady.current.promise, task]);
      expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/route conflict at \/api\/messages.*owned by other-plugin/),
      );
      for (const route of registry.httpRoutes) {
        routes.set(route.path, route);
      }
      const custom = await fetch(`${getMSTeamsRouteBaseUrl()}/teams/events`, {
        method: "POST",
        headers: { authorization: "Bearer valid" },
        body: JSON.stringify({ type: "message" }),
      });
      expect(custom.status).toBe(200);
      await expect(custom.json()).resolves.toEqual({ body: { type: "message" } });
      const alias = await fetch(`${getMSTeamsRouteBaseUrl()}/api/messages`, { method: "POST" });
      expect(alias.status).toBe(200);
      await expect(alias.text()).resolves.toBe("other-plugin");
      expect(handleSdkRequest).toHaveBeenCalledOnce();
    } finally {
      abort.abort();
      try {
        await task;
      } finally {
        expect(registry.httpRoutes.map((route) => route.pluginId)).toEqual(["other-plugin"]);
        unregisterOther();
      }
    }
  });
});
