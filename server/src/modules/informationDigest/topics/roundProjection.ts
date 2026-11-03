/** Output validation errors belong to an actual analysis version, not to the
 * collection barrier after that version has been removed. Admission, Source,
 * context and budget errors remain valid even before an analysis exists. */
export function projectRoundState(round:{status:string;error_code:string|null},analysisPresent:boolean){
 if(round.status==='blocked'&&!analysisPresent&&['briefing_output_invalid','briefing_output_truncated'].includes(round.error_code??''))return {status:'awaiting_analysis',error_code:null};
 return {status:round.status,error_code:round.error_code};
}
