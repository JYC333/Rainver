import {KNOWLEDGE_PROPOSAL_SCHEMAS,type OperationActor,type RegisteredSystemActionDefinition} from '@rainver/protocol';
import type {OperationRegistration,ResolvedOperation} from '../systemActions/operations/types.js';
import {hidden} from '../systemActions/operations/errors.js';
import {classifyProposalRefusal,proposalWriter} from './proposalRefusal.js';
import {contentDecisionFromDb} from '../access/contentAccessQuery.js';
import {discoverKnowledgeProposalAuthority,lockKnowledgeProposalAuthority} from './proposalAuthority.js';
import {PgKnowledgeRepository} from './repository.js';
type Input=Record<string,any>;
type Scope=ResolvedOperation&{bound:Awaited<ReturnType<typeof discoverKnowledgeProposalAuthority>>};
const person=(a:OperationActor)=>({spaceId:a.space_id,userId:a.on_behalf_of_user_id!});
export function knowledgeProposalRegistrations(defs:ReadonlyMap<string,RegisteredSystemActionDefinition>):OperationRegistration[]{return Object.keys(KNOWLEDGE_PROPOSAL_SCHEMAS).map(id=>({
 definition:defs.get(id)!,successStatus:202,
 normalizeInput(raw){const i=raw as Input;return id==='knowledge.item.propose_create'||id==='knowledge.claim.propose_create'?{...i,visibility:i.project_id?'space_shared':'private'}:i;},...(id==='knowledge.item.propose_create'||id==='knowledge.claim.propose_create'?{userContentCreation:true as const}:{}),
 async resolve(db,raw,a){const i=raw as Input,bound=await discoverKnowledgeProposalAuthority(db,i,a);return {authority:bound.target?`knowledge_proposal:${bound.target}`:`space:${a.space_id}`,targets:bound,resourceType:'proposal',resourceId:null,bound} as Scope;},
 async authorize(db,raw,a,s){await lockKnowledgeProposalAuthority(db,raw as Input,a,(s as Scope).bound);},
 async authorizeResult(db,raw,a){const out=raw as {id:string;space_id:string};if(out.space_id!==a.space_id||await contentDecisionFromDb(db,person(a),'proposal',out.id,{includeOversight:false})!=='full')throw hidden();},
 classifyError:classifyProposalRefusal,
 async execute(db,raw,a){return proposalWriter(async()=>{const i=raw as Input,{item_id: _item,claim_id: _claim,relation_id: _relation,...body}=i,r=new PgKnowledgeRepository(db),p=person(a);let out:{id:unknown};
  if(id==='knowledge.item.propose_create')out=await r.proposeCreate(p,body);
  else if(id==='knowledge.item.propose_update')out=await r.proposeUpdate(p,i.item_id,body);
  else if(id==='knowledge.item.propose_archive')out=await r.proposeArchive(p,i.item_id);
  else if(id==='knowledge.claim.propose_create')out=await r.proposeClaimCreate(p,body);
  else if(id==='knowledge.claim.propose_update')out=await r.proposeClaimUpdate(p,i.claim_id,body);
  else if(id==='knowledge.claim.propose_archive')out=await r.proposeClaimArchive(p,i.claim_id);
  else if(id==='knowledge.relation.propose_create')out=await r.proposeObjectRelation(p,body) as {id:unknown};
  else out=await r.proposeObjectRelationArchive(p,i.relation_id);
  return {id:out.id,space_id:a.space_id};
 });},
}));}
