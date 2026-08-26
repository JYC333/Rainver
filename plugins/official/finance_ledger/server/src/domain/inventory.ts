import { Amount } from "./amount.js";
import { Position } from "./position.js";

const CURRENCY_ORDER = new Map<string, number>([
  ["USD", 0],
  ["EUR", 1],
  ["JPY", 2],
  ["CAD", 3],
  ["GBP", 4],
  ["AUD", 5],
  ["NZD", 6],
  ["CHF", 7],
]);

export class Inventory {
  private readonly positionsByKey: Map<string, Position>;

  constructor(positions: readonly Position[] = []) {
    this.positionsByKey = new Map();
    for (const position of positions) {
      this.addPosition(position);
    }
  }

  static empty(): Inventory {
    return new Inventory();
  }

  clone(): Inventory {
    return new Inventory(this.positions());
  }

  addPosition(position: Position): this {
    const key = position.key();
    const existing = this.positionsByKey.get(key);
    const nextUnits = existing ? existing.units.add(position.units) : position.units;
    if (nextUnits.isZero()) {
      this.positionsByKey.delete(key);
    } else {
      this.positionsByKey.set(key, new Position(nextUnits, position.cost));
    }
    return this;
  }

  addAmount(amount: Amount): this {
    return this.addPosition(new Position(amount));
  }

  positions(): Position[] {
    return [...this.positionsByKey.values()].sort(comparePositions);
  }

  balanceByCurrency(): Map<string, Amount> {
    const balances = new Map<string, Amount>();
    for (const position of this.positionsByKey.values()) {
      const existing = balances.get(position.units.currency);
      balances.set(
        position.units.currency,
        existing ? existing.add(position.units) : position.units,
      );
    }
    return balances;
  }

  isEmpty(): boolean {
    return this.positionsByKey.size === 0;
  }
}

function comparePositions(left: Position, right: Position): number {
  const leftOrder = currencyOrder(left.units.currency);
  const rightOrder = currencyOrder(right.units.currency);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.key().localeCompare(right.key());
}

function currencyOrder(currency: string): number {
  return CURRENCY_ORDER.get(currency) ?? CURRENCY_ORDER.size + currency.length;
}
