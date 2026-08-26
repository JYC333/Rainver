import { Amount, assertCommoditySymbol } from "./amount.js";
import { decimalEquals, type DecimalValue, parseDecimal } from "./decimal.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class Cost {
  readonly number: DecimalValue;
  readonly currency: string;
  readonly date: string | null;
  readonly label: string | null;

  constructor(input: {
    number: string | DecimalValue;
    currency: string;
    date?: string | null;
    label?: string | null;
  }) {
    assertCommoditySymbol(input.currency);
    assertIsoDate(input.date ?? null);
    this.number = parseDecimal(input.number);
    this.currency = input.currency;
    this.date = input.date ?? null;
    this.label = input.label ?? null;
    Object.freeze(this);
  }

  equals(other: Cost): boolean {
    return (
      this.currency === other.currency &&
      this.date === other.date &&
      this.label === other.label &&
      decimalEquals(this.number, other.number)
    );
  }

  key(): string {
    return `${this.number.decimal}|${this.currency}|${this.date ?? ""}|${this.label ?? ""}`;
  }

  toString(): string {
    const parts = [`${this.number.decimal} ${this.currency}`];
    if (this.date) parts.push(this.date);
    if (this.label) parts.push(`"${this.label}"`);
    return parts.join(", ");
  }
}

export class CostSpec {
  readonly numberPer: DecimalValue | null;
  readonly numberTotal: DecimalValue | null;
  readonly currency: string | null;
  readonly date: string | null;
  readonly label: string | null;
  readonly merge: boolean | null;

  constructor(input: {
    numberPer?: string | DecimalValue | null;
    numberTotal?: string | DecimalValue | null;
    currency?: string | null;
    date?: string | null;
    label?: string | null;
    merge?: boolean | null;
  }) {
    if (input.currency != null) assertCommoditySymbol(input.currency);
    assertIsoDate(input.date ?? null);
    this.numberPer = input.numberPer == null ? null : parseDecimal(input.numberPer);
    this.numberTotal = input.numberTotal == null ? null : parseDecimal(input.numberTotal);
    this.currency = input.currency ?? null;
    this.date = input.date ?? null;
    this.label = input.label ?? null;
    this.merge = input.merge ?? null;
    Object.freeze(this);
  }

  toString(): string {
    const amountParts: string[] = [];
    if (this.numberPer) amountParts.push(this.numberPer.decimal);
    if (this.numberTotal) amountParts.push(`# ${this.numberTotal.decimal}`);
    if (this.currency) amountParts.push(this.currency);

    const parts = [];
    if (amountParts.length > 0) parts.push(amountParts.join(" "));
    if (this.date) parts.push(this.date);
    if (this.label) parts.push(`"${this.label}"`);
    if (this.merge) parts.push("*");
    return parts.join(", ");
  }
}

export class Position {
  readonly units: Amount;
  readonly cost: Cost | null;

  constructor(units: Amount, cost?: Cost | null) {
    this.units = units;
    this.cost = cost ?? null;
    Object.freeze(this);
  }

  negate(): Position {
    return new Position(this.units.negate(), this.cost);
  }

  equals(other: Position): boolean {
    const costsEqual =
      this.cost === null ? other.cost === null : other.cost !== null && this.cost.equals(other.cost);
    return this.units.equals(other.units) && costsEqual;
  }

  currencyPair(): readonly [string, string | null] {
    return [this.units.currency, this.cost?.currency ?? null] as const;
  }

  key(): string {
    return `${this.units.currency}|${this.cost?.key() ?? ""}`;
  }

  toString(): string {
    if (!this.cost) return this.units.toString();
    return `${this.units.toString()} {${this.cost.toString()}}`;
  }
}

function assertIsoDate(value: string | null): void {
  if (value !== null && !ISO_DATE_RE.test(value)) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
}
