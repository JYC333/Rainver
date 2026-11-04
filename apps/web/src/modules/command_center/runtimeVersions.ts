/** Unknown and prerelease versions cannot establish a safe stable upgrade. */
export function hasStableUpdate(current: string | null, latest: string | null | undefined): boolean {
  const installed = current?.match(/\bv?(\d+)\.(\d+)\.(\d+)(?![\d.+-])/)
  const available = latest?.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!installed || !available) return false
  for (let index = 1; index <= 3; index++) {
    const left = Number(available[index]), right = Number(installed[index])
    if (left !== right) return left > right
  }
  return false
}
