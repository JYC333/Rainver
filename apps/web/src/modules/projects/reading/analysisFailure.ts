/** Stable, localized categories; never expose raw model output or server logs. */
export function analysisFailureKey(code:string|null){
 if(code&&['briefing_output_invalid','briefing_output_truncated'].includes(code))return 'projectReading.analysisFailure.output'
 if(code&&/attempts_exhausted|daily_limit|budget|quota/.test(code))return 'projectReading.analysisFailure.limit'
 if(code&&/changed|superseded/.test(code))return 'projectReading.analysisFailure.changed'
 if(code&&/access|consent|permission|egress/.test(code))return 'projectReading.analysisFailure.access'
 if(code&&/^source_|theme_collection_failed/.test(code))return 'projectReading.analysisFailure.collection'
 return 'projectReading.analysisFailure.other'
}
