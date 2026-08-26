import { ARXIV_CATEGORY_GROUPS } from "./arxivCategoryTaxonomy.js";

export interface SourceProviderCategoryOption {
  value: string;
  label: string;
}

export interface SourceProviderCategoryGroup {
  group: string;
  options: readonly SourceProviderCategoryOption[];
}

export interface SourceProviderSetupSchema {
  category_groups?: readonly SourceProviderCategoryGroup[];
}

const PROVIDER_SETUP_SCHEMAS: Readonly<Record<string, SourceProviderSetupSchema>> = {
  arxiv: {
    category_groups: ARXIV_CATEGORY_GROUPS,
  },
};

export function sourceProviderSetupSchema(providerKey: string): SourceProviderSetupSchema | null {
  return PROVIDER_SETUP_SCHEMAS[providerKey] ?? null;
}
