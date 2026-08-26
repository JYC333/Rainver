import {
  addDecimal,
  compareDecimal,
  decimalEquals,
  type DecimalValue,
  isZeroDecimal,
  negateDecimal,
  parseDecimal,
} from "./decimal.js";

const COMMODITY_SYMBOL_RE = /^[A-Z][A-Z0-9_-]*$/;

export class Amount {
  readonly number: DecimalValue;
  readonly currency: string;

  constructor(number: string | DecimalValue, currency: string) {
    assertCommoditySymbol(currency);
    this.number = parseDecimal(number);
    this.currency = currency;
    Object.freeze(this);
  }

  static of(number: string | DecimalValue, currency: string): Amount {
    return new Amount(number, currency);
  }

  add(other: Amount): Amount {
    this.assertSameCurrency(other);
    return new Amount(addDecimal(this.number, other.number), this.currency);
  }

  negate(): Amount {
    return new Amount(negateDecimal(this.number), this.currency);
  }

  isZero(): boolean {
    return isZeroDecimal(this.number);
  }

  compare(other: Amount): number {
    this.assertSameCurrency(other);
    return compareDecimal(this.number, other.number);
  }

  equals(other: Amount): boolean {
    return this.currency === other.currency && decimalEquals(this.number, other.number);
  }

  toString(): string {
    return `${this.number.decimal} ${this.currency}`;
  }

  private assertSameCurrency(other: Amount): void {
    if (this.currency !== other.currency) {
      throw new Error(`Currency mismatch: ${this.currency} != ${other.currency}`);
    }
  }
}

export function assertCommoditySymbol(symbol: string): void {
  if (!COMMODITY_SYMBOL_RE.test(symbol)) {
    throw new Error(`Invalid commodity symbol: ${symbol}`);
  }
}

export function isCommoditySymbol(value: string): boolean {
  return COMMODITY_SYMBOL_RE.test(value);
}
