/**
 * The revision of a Proposal as a person sees it: a digest of its payload and its text. A decision that names the
 * revision it was made on (`proposal.accept` `expected_revision`) is refused once the Proposal changed since — another
 * tab, or a choice saved on its card in between — so what is accepted is exactly what was shown. Content-addressed:
 * the same payload and text are the same revision, whatever happened in between. `alias` is the `proposals` row.
 */
export const proposalRevisionSql = (alias: string) =>
  `encode(sha256(convert_to(COALESCE(${alias}.payload_json::text,'')||E'\\n'||COALESCE(${alias}.summary,''),'UTF8')),'hex')`;
