import { providerVendor } from "./vendors.js";

export function providerSupportsStructuredOutput(providerType: string): boolean {
  return providerVendor(providerType)?.supportsStructuredOutput ?? false;
}
