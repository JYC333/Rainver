export const LIST_PAGE_SIZE = 100

/** Read every page of an offset-paginated list. */
export async function loadAllPages<T>(
  fetchPage: (
    limit: number,
    offset: number,
  ) => Promise<{ items: T[] }>,
): Promise<T[]> {
  const items: T[] = []
  for (;;) {
    const page = await fetchPage(LIST_PAGE_SIZE, items.length)
    items.push(...page.items)
    if (page.items.length < LIST_PAGE_SIZE) return items
  }
}
