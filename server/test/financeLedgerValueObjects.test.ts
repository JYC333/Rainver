import { describe, expect, it } from "vitest";
import { loadFinanceLedgerRuntime } from "./financeLedgerRuntime.js";

const {
  decimal: { addDecimal, compareDecimal, parseDecimal },
  amount: { Amount, isCommoditySymbol },
  booking: { Booking, parseBooking },
  inventory: { Inventory },
  position: { Cost, CostSpec, Position },
} = loadFinanceLedgerRuntime();

describe("finance ledger decimal values", () => {
  it("preserves decimal scale and uses exact bigint arithmetic", () => {
    const left = parseDecimal("9007199254740993.10");
    const right = parseDecimal("0.90");
    const result = addDecimal(left, right);

    expect(result.decimal).toBe("9007199254740994.00");
    expect(result.scale).toBe(2);
  });

  it("compares decimals independent of display scale", () => {
    expect(compareDecimal(parseDecimal("1.0"), parseDecimal("1.00"))).toBe(0);
    expect(compareDecimal(parseDecimal("-1.01"), parseDecimal("-1.00"))).toBe(-1);
  });
});

describe("finance ledger Amount", () => {
  it("adds amounts with matching commodities", () => {
    const result = Amount.of("12.50", "GBP").add(Amount.of("-2.50", "GBP"));
    expect(result.toString()).toBe("10.00 GBP");
  });

  it("rejects mismatched commodities", () => {
    expect(() => Amount.of("1", "GBP").add(Amount.of("1", "USD"))).toThrow(
      "Currency mismatch",
    );
  });

  it("validates Beancount-style uppercase commodity symbols", () => {
    expect(isCommoditySymbol("AAPL")).toBe(true);
    expect(isCommoditySymbol("USD-TEST_1")).toBe(true);
    expect(isCommoditySymbol("usd")).toBe(false);
  });
});

describe("finance ledger cost and position values", () => {
  it("formats costs and positions deterministically", () => {
    const cost = new Cost({
      number: "504.30",
      currency: "USD",
      date: "2026-07-02",
      label: "lot-1",
    });
    const position = new Position(Amount.of("4", "HOOL"), cost);

    expect(cost.toString()).toBe('504.30 USD, 2026-07-02, "lot-1"');
    expect(position.toString()).toBe('4 HOOL {504.30 USD, 2026-07-02, "lot-1"}');
  });

  it("represents unresolved cost specs without resolving lots", () => {
    const spec = new CostSpec({
      numberPer: "10.00",
      numberTotal: "1.50",
      currency: "USD",
      merge: true,
    });

    expect(spec.toString()).toBe("10.00 # 1.50 USD, *");
  });
});

describe("finance ledger Inventory", () => {
  it("aggregates positions by unit commodity and cost", () => {
    const cost = new Cost({ number: "10.00", currency: "USD", date: "2026-07-02" });
    const inventory = Inventory.empty()
      .addPosition(new Position(Amount.of("2", "HOOL"), cost))
      .addPosition(new Position(Amount.of("3", "HOOL"), cost))
      .addAmount(Amount.of("5.00", "USD"));

    expect(inventory.positions().map((position) => position.toString())).toEqual([
      "5.00 USD",
      "5 HOOL {10.00 USD, 2026-07-02}",
    ]);
    expect(inventory.balanceByCurrency().get("HOOL")?.toString()).toBe("5 HOOL");
  });

  it("removes positions that net to zero", () => {
    const inventory = Inventory.empty()
      .addAmount(Amount.of("1.00", "USD"))
      .addAmount(Amount.of("-1.00", "USD"));

    expect(inventory.isEmpty()).toBe(true);
  });
});

describe("finance ledger Booking", () => {
  it("matches Beancount booking method names", () => {
    expect(Object.values(Booking)).toEqual([
      "STRICT",
      "STRICT_WITH_SIZE",
      "NONE",
      "AVERAGE",
      "FIFO",
      "LIFO",
      "HIFO",
    ]);
    expect(parseBooking("FIFO")).toBe(Booking.FIFO);
    expect(parseBooking(null)).toBeNull();
    expect(() => parseBooking("UNKNOWN")).toThrow("Invalid booking method");
  });
});
