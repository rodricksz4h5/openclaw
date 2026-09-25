import * as Lark from "@larksuiteoapi/node-sdk";
import { getActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { FeishuConfigSchema } from "./config-schema.js";
import { cleanupFeishuMonitorStateForTests } from "./monitor.cleanup.test-helpers.js";
import { botNames, botOpenIds, setFeishuBotIdentityState } from "./monitor.state.js";
import { monitorWebhook } from "./monitor.transport.js";
import {
  createFeishuWebhookTestAccount,
  getGatewayPort,
  postSignedPayload,
  waitForWebhookRoute,
} from "./monitor.webhook.test-helpers.js";
import type { FeishuConfig } from "./types.js";

const legacyListener = vi.hoisted(() => ({
  value: undefined as { port: number; host?: string } | undefined,
}));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>()),
  getWebhookLegacyListener: () => legacyListener.value,
}));

afterEach(async () => {
  legacyListener.value = undefined;
  await cleanupFeishuMonitorStateForTests();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.resetModules();
});

describe("Feishu webhook route configuration", () => {
  it.each([
    { name: "normal stop after identity recovery", replacement: undefined },
    {
      name: "successor identity before transport registration",
      replacement: { botOpenId: "ou_successor", botName: "Successor" },
    },
    {
      name: "successor publishing the same identity",
      replacement: { botOpenId: "ou_recovered", botName: "Recovered" },
    },
  ])("preserves identity ownership during $name", async ({ replacement }) => {
    await getGatewayPort();
    const accountId = "identity-handoff";
    const account = createFeishuWebhookTestAccount(accountId, "/hook-identity-handoff");
    const abort = new AbortController();
    setFeishuBotIdentityState(accountId, { botOpenId: "ou_initial", botName: "Initial" });
    const monitor = monitorWebhook({
      account,
      accountId,
      abortSignal: abort.signal,
      eventDispatcher: new Lark.EventDispatcher({ encryptKey: "encrypt_key" }),
      runtime: createRuntimeSpies(),
    });
    try {
      setFeishuBotIdentityState(accountId, { botOpenId: "ou_recovered", botName: "Recovered" });
      abort.abort();
      if (replacement) {
        setFeishuBotIdentityState(accountId, replacement);
      }
      await monitor;
      expect(botOpenIds.get(accountId)).toBe(replacement?.botOpenId);
      expect(botNames.get(accountId)).toBe(replacement?.botName);
    } finally {
      abort.abort();
      await monitor;
    }
  });

  it.each([
    ...["/health", "/healthz", "/ready", "/readyz", "/startup", "/startupz"]
      .flatMap((path) => [path, `${path}?tenant=test`])
      .map((path) => ({ path, reason: "is reserved for Gateway probes" })),
    { path: "/api/channels/feishu", reason: "requires Gateway authentication" },
    { path: "/%61pi/channels/feishu?tenant=test", reason: "requires Gateway authentication" },
  ])(
    "keeps the default legacy listener for restricted path $path until explicitly disabled",
    async ({ path, reason }) => {
      const port = await getGatewayPort();
      const abortController = new AbortController();
      const invoke = vi.fn(async () => ({ accepted: true }));
      const account = createFeishuWebhookTestAccount("reserved-path", path);
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
      vi.spyOn(eventDispatcher, "invoke").mockImplementation(invoke);
      const params = {
        account: {
          ...account,
          config: FeishuConfigSchema.parse({ ...account.config, legacyWebhook: false }),
        },
        accountId: account.accountId,
        abortSignal: abortController.signal,
        eventDispatcher,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      };
      await expect(monitorWebhook(params)).rejects.toThrow(
        `webhookPath ${JSON.stringify(path)} ${reason}`,
      );
      legacyListener.value = { port: 3000, host: "127.0.0.1" };
      const monitor = monitorWebhook({
        ...params,
        account,
      });
      try {
        const response = await postSignedPayload(`http://127.0.0.1:${port}${path}`, {
          schema: "2.0",
          event: {},
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ accepted: true });
        expect(invoke).toHaveBeenCalledTimes(1);
        expect(params.runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("before setting legacyWebhook:false"),
        );
      } finally {
        legacyListener.value = undefined;
        abortController.abort();
        await monitor;
      }
    },
  );

  it.each<{
    name: string;
    configured?: FeishuConfig["legacyWebhook"];
    accountOverride?: FeishuConfig["legacyWebhook"];
    endpoint?: { port: number; host: string };
  }>([
    { name: "omitted setting", endpoint: { port: 3000, host: "127.0.0.1" } },
    {
      name: "omitted host",
      configured: { port: 3100 },
      endpoint: { port: 3100, host: "127.0.0.1" },
    },
    {
      name: "explicit wildcard",
      configured: { port: 3000, host: "0.0.0.0" },
      endpoint: { port: 3000, host: "0.0.0.0" },
    },
    {
      name: "explicit address",
      configured: { port: 3000, host: "127.0.0.2" },
      endpoint: { port: 3000, host: "127.0.0.2" },
    },
    { name: "disabled root", configured: false },
    { name: "account disable override", configured: { port: 3100 }, accountOverride: false },
  ])(
    "prepares the inherited legacy listener for $name and preserves Gateway delivery",
    async ({ configured, accountOverride, endpoint }) => {
      const path = "/hook-legacy-bind-address";
      const port = await getGatewayPort();
      const fixture = createFeishuWebhookTestAccount("legacy-bind-address", path);
      const account = resolveFeishuRuntimeAccount({
        accountId: fixture.accountId,
        cfg: {
          channels: {
            feishu: FeishuConfigSchema.parse({
              ...fixture.config,
              appId: "cli_test",
              appSecret: "secret_test",
              legacyWebhook: configured,
              accounts: {
                [fixture.accountId]:
                  accountOverride === undefined ? {} : { legacyWebhook: accountOverride },
              },
            }),
          },
        },
      });
      const abort = new AbortController();
      const eventDispatcher = new Lark.EventDispatcher({ encryptKey: "encrypt_key" });
      const invoke = vi.spyOn(eventDispatcher, "invoke").mockResolvedValue({ accepted: true });
      const monitor = monitorWebhook({
        account,
        accountId: account.accountId,
        abortSignal: abort.signal,
        eventDispatcher,
        runtime: createRuntimeSpies(),
      });
      const url = `http://127.0.0.1:${port}${path}`;
      try {
        await waitForWebhookRoute(url);
        expect(
          getActivePluginRegistry()?.httpRoutes.find((route) => route.path === path)
            ?.legacyListeners ?? [],
        ).toEqual(endpoint ? [endpoint] : []);
        legacyListener.value = endpoint ?? { port: 3000, host: "127.0.0.1" };
        let response = await postSignedPayload(url, { schema: "2.0", event: {} });
        if (!endpoint) {
          expect(response.status).toBe(404);
          expect(invoke).not.toHaveBeenCalled();
          legacyListener.value = undefined;
          response = await postSignedPayload(url, { schema: "2.0", event: {} });
        }
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ accepted: true });
        expect(invoke).toHaveBeenCalledOnce();
      } finally {
        legacyListener.value = undefined;
        abort.abort();
        await monitor;
      }
    },
  );
});
