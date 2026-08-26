import type { RootType } from "./directives.js";

const ROOT_TYPES: Record<string, RootType> = {
  Assets: "assets",
  Liabilities: "liabilities",
  Equity: "equity",
  Income: "income",
  Expenses: "expenses",
};

export function rootTypeForAccountName(accountName: string): RootType {
  const parts = accountName.split(":");
  if (parts.length < 2 || parts.some((part) => part.trim() === "")) {
    throw new Error(`Invalid account name: ${accountName}`);
  }
  const rootType = ROOT_TYPES[parts[0]!];
  if (!rootType) {
    throw new Error(`Invalid account root: ${parts[0]}`);
  }
  return rootType;
}
