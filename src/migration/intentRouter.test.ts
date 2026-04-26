import { describe, expect, test } from "bun:test";
import { decisionToSlashCommand, routeIntent } from "./intentRouter.js";

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
});
