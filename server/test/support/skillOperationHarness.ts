import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {resetTables} from './resetTables.js';
import {seedSpaceOwnerProject} from './domainSeeds.js';
import {buildModuleServer} from './moduleServer.js';
import {loadConfig} from '../../src/config.js';
import {skillsModule} from '../../src/modules/skills/index.js';
import {systemActionsModule} from '../../src/modules/systemActions/index.js';
import {PgSkillsRepository} from '../../src/modules/skills/repository.js';
import {previewSkillFiles} from '../../src/modules/skills/skillImporter.js';
export const skillFiles=[{path:'SKILL.md',content_base64:Buffer.from('---\nname: test\ndescription: A test Skill.\n---\nRead carefully.').toString('base64')}];
export async function seedSkillOperationHarness(pool:Pool,uri:string){
 await resetTables(pool,['skill_local_overlays','skill_packages','skill_sources','proposals','jobs','spaces','users'],{cascade:true});
 const space=randomUUID(),owner=randomUUID(),project=randomUUID();
 await seedSpaceOwnerProject(pool,{space,owner,project,spaceType:'household'});
 const preview=previewSkillFiles({files:skillFiles});
 const saved=await new PgSkillsRepository(pool).saveImportedSkill({spaceId:space,userId:owner},preview);
 const app=buildModuleServer(loadConfig({SERVER_DATABASE_URL:uri}),[skillsModule,systemActionsModule]);
 return {space,owner,project,pkg:String(saved.id),app,preview};
}
