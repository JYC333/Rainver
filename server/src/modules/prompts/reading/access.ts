import {PromptRepository} from '../repository.js';
import {HttpError,type Queryable,type SpaceUserIdentity} from '../../routeUtils/common.js';
import {assertCanWriteAssetOwnerScope,normalizeVersionScopeForWrite} from '../../evolution/assetAccess.js';
import {READING_METHOD_KEY} from './runtime.js';
import {findPromptAssetForKey} from '../repository.js';
export async function readingAsset(db:Queryable,identity:SpaceUserIdentity,write=true,key=READING_METHOD_KEY){
 const found=await findPromptAssetForKey(db,identity,key);
 if(!found)throw new HttpError(409,'Initialize the reading method catalog first',{code:'reading_method_not_initialized',detail:'Initialize the reading method catalog from the Reading method workspace first.'});
 if(write)await assertCanWriteAssetOwnerScope(db,identity,found.row);
 return found.row;
}
export async function readingCandidate(db:Queryable,identity:SpaceUserIdentity,id:string,projectId:string|null,key=READING_METHOD_KEY){
 const asset=await readingAsset(db,identity);const versions=await new PromptRepository(db).listVersions(identity,key);
 const version=versions.find(v=>v.id===id);
 if(!version || !['draft','candidate','testing'].includes(String(version.status)))throw new HttpError(409,'Choose a current draft/candidate reading method');
 if(version.scope_type!==(projectId?'project':'space') || version.scope_id!==(projectId??identity.spaceId))throw new HttpError(403,'Candidate scope does not match this comparison');
 await normalizeVersionScopeForWrite(db,identity,version.scope_type as string,version.scope_id as string);
 return {asset,version};
}
