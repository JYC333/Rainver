import {SKILL_LOCAL_OPERATION_SCHEMAS,type OperationActor,type OperationInput,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import {HttpError} from '../routeUtils/common.js';
import {hidden,markedRefusal} from '../systemActions/operations/errors.js';
import type {OperationRegistration} from '../systemActions/operations/types.js';
import {lockSkillReviewProposals} from '../systemActions/operations/proposalTransitions.js';
import {PgProposalRepository} from '../proposals/repository.js';
import {PgSkillsRepository} from './repository.js';
import {SkillsService} from './service.js';
import {lockSkillScopeAuthority} from './scopeAuthority.js';
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
type Input=OperationInput<'skill.overlay.upsert'>|OperationInput<'skill.binding.propose'>|OperationInput<'skill.review.propose'>;
export function skillLocalRegistrations(definitions:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{
 return (Object.keys(SKILL_LOCAL_OPERATION_SCHEMAS) as (keyof typeof SKILL_LOCAL_OPERATION_SCHEMAS)[]).map(id=>({
  definition:definitions.get(id)!,successStatus:id==='skill.review.propose'?(out)=>(out as {created:boolean}).created?201:200:id==='skill.binding.propose'?201:200,
  async resolve(_db,raw,a){const i=raw as Input;return {authority:`space:${a.space_id}`,targets:{skill_package_id:i.skill_package_id},resourceType:'skill_package',resourceId:i.skill_package_id};},
  async authorize(db,raw,a){
   const i=raw as Input;
   // Transition admission precedes domain/permission locks, as on apply.
   if(id==='skill.review.propose')await lockSkillReviewProposals(db,a.space_id,[i.skill_package_id],true);
   const binding=id==='skill.review.propose'?(i as OperationInput<'skill.review.propose'>).binding:undefined;
   const scope=id==='skill.review.propose'?binding:i as OperationInput<'skill.overlay.upsert'>;
   // A review without an initial binding needs membership, not Space management.
   if(scope)await lockSkillScopeAuthority(db,person(a),scope.scope_type,scope.scope_id??null);
   else {
    const {lockActivePerson}=await import('../access/activePerson.js');await lockActivePerson(db,a.space_id,a.on_behalf_of_user_id!);
   }
   if(!await new PgSkillsRepository(db).getSkillPackage(person(a),i.skill_package_id))throw hidden();
  },
  async authorizeResult(db,raw,a){
   if(id==='skill.overlay.upsert')return;
   const receipt=raw as {space_id:string;proposal_id:string};
   if(receipt.space_id!==a.space_id||!await new PgProposalRepository(db).getVisible(a.space_id,a.on_behalf_of_user_id!,receipt.proposal_id))throw hidden();
  },
  classifyError(e){return e instanceof HttpError?markedRefusal(e,'skills'):undefined;},
  async execute(db,raw,a){
   const {skill_package_id,...body}=raw as Input,repo=new PgSkillsRepository(db),service=new SkillsService(repo);
   if(id==='skill.binding.propose'){
    const proposal=await repo.createSkillBindingProposal(person(a),skill_package_id,body);
    return {space_id:a.space_id,proposal_id:proposal.id};
   }
   if(id==='skill.review.propose'){
    const result=await service.createSkillReviewProposal(person(a),skill_package_id,body);
    return {space_id:a.space_id,proposal_id:result.proposal.id,created:result.created};
   }
   return service.upsertSkillLocalOverlay(person(a),skill_package_id,body);
  },
 }));
}
