import { describe, expect, it } from "vitest";
import { vercel } from "./vercel.js";

describe("vercel()", () => {
  it("returns a SandboxProvider with tag 'isolated' and name 'vercel'", () => {
    const provider = vercel();
    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("vercel");
  });

  it("has a create function", () => {
    const provider = vercel();
    expect(typeof provider.create).toBe("function");
  });

  it("accepts a token option", () => {
    // Should not throw
    const provider = vercel({ token: "my-token" });
    expect(provider.tag).toBe("isolated");
  });

  it("passes through Vercel SDK options", () => {
    // Should not throw when arbitrary SDK options are provided
    const provider = vercel({
      template: "node-22",
      timeoutMs: 30_000,
    });
    expect(provider.tag).toBe("isolated");
  });
});
