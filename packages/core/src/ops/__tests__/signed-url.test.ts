import { describe, test, expect } from "bun:test";
import { getOpDefinition, dispatchOp } from "../index.js";
import { createTestContext } from "../../test-utils.js";

describe("signed-url op", () => {
  const opDef = getOpDefinition("signed-url")!;

  test("is registered in op registry", () => {
    expect(opDef).toBeDefined();
    expect(opDef.handler).toBeInstanceOf(Function);
    expect(opDef.description).toContain("presigned URL");
  });

  test("schema accepts path only (uses default expiry)", () => {
    const result = opDef.schema.parse({ path: "/test.txt" });
    expect(result).toEqual({ path: "/test.txt" });
  });

  test("schema accepts path with expiresIn", () => {
    const result = opDef.schema.parse({ path: "/test.txt", expiresIn: 3600 });
    expect(result).toEqual({ path: "/test.txt", expiresIn: 3600 });
  });

  test("schema rejects expiresIn below 60 seconds", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 30 })).toThrow();
  });

  test("schema rejects expiresIn above 7 days (604800s)", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 700000 })).toThrow();
  });

  test("schema rejects non-integer expiresIn", () => {
    expect(() => opDef.schema.parse({ path: "/test.txt", expiresIn: 3600.5 })).toThrow();
  });

  test("schema rejects missing path", () => {
    expect(() => opDef.schema.parse({})).toThrow();
    expect(() => opDef.schema.parse({ expiresIn: 3600 })).toThrow();
  });

  test("schema accepts boundary values", () => {
    expect(opDef.schema.parse({ path: "/f", expiresIn: 60 })).toEqual({ path: "/f", expiresIn: 60 });
    expect(opDef.schema.parse({ path: "/f", expiresIn: 604800 })).toEqual({ path: "/f", expiresIn: 604800 });
  });

  test("presigned URL carries a charset for a text file", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/notes.md", content: "# t — em dash" });

    const result = (await dispatchOp(ctx, "signed-url", { path: "/notes.md" })) as {
      url: string;
    };

    const ct = new URL(result.url).searchParams.get("ct");
    expect(ct).toBe("text/markdown; charset=utf-8");
  });

  test("presigned URL for a binary file has no charset", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", {
      path: "/logo.png",
      content: "not really png bytes",
    });

    const result = (await dispatchOp(ctx, "signed-url", { path: "/logo.png" })) as {
      url: string;
    };

    const ct = new URL(result.url).searchParams.get("ct");
    expect(ct).toBe("image/png");
  });
});
