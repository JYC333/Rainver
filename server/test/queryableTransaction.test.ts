import { describe, expect, it, vi } from "vitest";
import { withQueryableTransaction } from "../src/modules/routeUtils/common.js";

describe("withQueryableTransaction", () => {
  it("joins an existing PostgreSQL transaction client", async () => {
    const client = {
      query: vi.fn(),
      connect: vi.fn(() => {
        throw new Error("nested connect must not be called");
      }),
      release: vi.fn(),
    };

    const result = await withQueryableTransaction(client, async (db) => {
      expect(db).toBe(client);
      return "joined";
    });

    expect(result).toBe("joined");
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("owns begin/commit when given a pool", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => client),
    };

    await withQueryableTransaction(pool, async (db) => {
      expect(db).toBe(client);
      return undefined;
    });

    expect(pool.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN");
    expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
