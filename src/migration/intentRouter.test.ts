import { describe, expect, test } from "bun:test";
import { decisionToSlashCommand, routeIntent, routeToolIntent } from "./intentRouter.js";

describe("intent router", () => {
  test("turns a neutral benchmark request into a no-context rewrite command", async () => {
    const decision = await routeIntent(
      "benchmark run migrate https://github.com/gothinkster/node-express-realworld-example-app to csharp with no context",
      false,
    );

    expect(decision?.noContext).toBe(true);
    expect(decisionToSlashCommand(decision!)).toBe(
      "migrate rewrite --repo https://github.com/gothinkster/node-express-realworld-example-app --to csharp --no-context --yes",
    );
  });

  test("keeps normal migration requests context-aware", async () => {
    const decision = await routeIntent(
      "migrate https://github.com/myorg/legacy-api to csharp",
      false,
    );

    expect(decision?.noContext).toBe(false);
    expect(decisionToSlashCommand(decision!)).toBe(
      "migrate rewrite --repo https://github.com/myorg/legacy-api --to csharp --yes",
    );
  });

  test("routes plain-English dashboard open requests to the latest run", () => {
    const decision = routeToolIntent("open it in the dashboard");

    expect(decision?.command).toBe("migrate dashboard --open");
  });

  test("routes dashboard requests with a repo url to the matching run", () => {
    const decision = routeToolIntent("show dashboard for https://github.com/eminbayrak/node-orders-api");

    expect(decision?.command).toBe("migrate dashboard https://github.com/eminbayrak/node-orders-api --open");
  });

  test("routes result-folder, status, setup, guide, and clean intents", () => {
    expect(routeToolIntent("open the result folder for node-orders-api")?.command).toBe("migrate open node-orders-api");
    expect(routeToolIntent("what migration work is ready?")?.command).toBe("migrate status");
    expect(routeToolIntent("connect claude code with mcp")?.command).toBe("setup");
    expect(routeToolIntent("what commands can I use?")?.command).toBe("guide");
    expect(routeToolIntent("delete all old migration run folders")?.command).toBe("migrate clean --all");
  });
});
