/** Vendor metadata accidentally logged as stderr by the ACP wrapper. */
export function isRuntimeMetadataDiagnostic(runtimeKey: string | undefined, line: string): boolean {
  if (runtimeKey !== "claude_code" || !line.startsWith("Unexpected case: ")) return false;
  try {
    const message: unknown = JSON.parse(line.slice("Unexpected case: ".length));
    return typeof message === "object" && message !== null
      && "type" in message && message.type === "system"
      && "subtype" in message && message.subtype === "permission_check_status";
  } catch {
    return false;
  }
}
