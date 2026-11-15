import {expect,it} from 'vitest';
import {CONTEXT_REPORT_OPERATION_SCHEMAS as schemas} from '../src/contextReportOperations.js';
it('binds exactly twelve report requests to strict inputs and content-free identity receipts',()=>{
 expect(Object.keys(schemas)).toHaveLength(12);
 for(const s of Object.values(schemas)){
  expect(s.input.safeParse({space_id:'forged',owner_user_id:'forged'}).success).toBe(false);
  const receipt={id:'11111111-1111-4111-8111-111111111111',job_id:'11111111-1111-4111-8111-111111111111',space_id:'22222222-2222-4222-8222-222222222222',status:'pending'};
  expect(s.output.safeParse(receipt).success).toBe(true);expect(s.output.safeParse({...receipt,report:{title:'secret'}}).success).toBe(false);
 }
});
it('keeps calibration and maintenance packet safety validation at admission',()=>{
 expect(schemas['memory.maintenance.scan'].input.safeParse({persist_report:false,create_packet:true}).success).toBe(false);
 expect(schemas['knowledge.eval.calibration.record'].input.safeParse({decisions:[{mechanic:'semantic_results_cache',decision:'adopt',access_safety_proof:'cache',eval_delta:{recall:1},evidence_artifact_ids:['x']}]}).success).toBe(false);
 expect(schemas['knowledge.eval.calibration.record'].input.safeParse({decisions:[{mechanic:'autocut',decision:'adopt',access_safety_proof:'proof'}]}).success).toBe(false);
});
