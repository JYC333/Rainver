import { describe, expect, it } from 'vitest';
import { PROJECT_EXECUTION_SCHEMAS as experiments } from '../src/projectExecutionOperations.js';
import { PROJECT_FOLDER_SCHEMAS as folders } from '../src/projectFolderOperations.js';
import {PROJECT_FOLDER_IO_SCHEMAS as io,ProjectFolderIoStatusSchema} from '../src/projectFolderIoOperations.js';
const target={project_id:'project',definition_id:'definition'};
describe('Project execution command contracts',()=>{
  it('normalizes stable Experiment defaults and rejects authority or unknown field injection',()=>{
    const schema=experiments['experiment.definition.create'].input;
    expect(schema.parse({project_id:'project',name:'  Experiment  '})).toEqual({project_id:'project',name:'Experiment',objective:null,primary_hypothesis_thread_id:null});
    for(const extra of [{user_id:'owner'},{space_id:'space'},{origin:'manual'},{progress:{}},{unexpected:true}])expect(schema.safeParse({project_id:'project',name:'Experiment',...extra}).success).toBe(false);
    expect(experiments['experiment.definition.create'].output.safeParse({id:'id',space_id:'space',project_id:'project',definition_id:'id',name:'PRIVATE'}).success).toBe(false);
  });
  it('requires explicit draft protocols and complete bounded managed configurations',()=>{
    const schema=experiments['experiment.version.create'].input;
    expect(schema.safeParse({...target,executor_type:'manual'}).success).toBe(true);
    expect(schema.safeParse({...target,executor_type:'manual',status:'approved'}).success).toBe(false);
    expect(schema.safeParse({...target,executor_type:'managed_code_comparison'}).success).toBe(false);
    expect(schema.safeParse({...target,executor_type:'managed_code_comparison',config:{project_folder_id:'folder',timeout_seconds:-1}}).success).toBe(false);
    expect(schema.safeParse({...target,executor_type:'managed_code_comparison',config:{project_folder_id:'folder',host_id:'host'}}).success).toBe(false);
  });
  it('validates observation values and retains distinct experiment versus managed Run ids',()=>{
    const schema=experiments['experiment.observation.record'].input;
    expect(schema.safeParse({...target,experiment_run_id:'run',metric_name:'latency'}).success).toBe(false);
    expect(schema.safeParse({...target,experiment_run_id:'run',metric_name:'latency',value_number:0}).success).toBe(true);
    expect(schema.safeParse({...target,run_id:'managed',metric_name:'latency',value_number:0}).success).toBe(false);
    expect(experiments['experiment.interpretation.convert'].input.safeParse({project_id:'project',interpretation_id:'interpretation',confidence:2}).success).toBe(false);
  });
  it('separates Folder registration, metadata, activation and executable configuration authority',()=>{
    expect(folders['project.folder.update'].input.safeParse({project_id:'project',folder_id:'folder',root_path:'/private'}).success).toBe(false);
    expect(folders['project.folder.update'].input.safeParse({project_id:'project',folder_id:'folder',status:'unknown'}).success).toBe(false);
    expect(folders['project.folder.execution_config.create'].input.parse({project_id:'project',folder_id:'folder'})).toMatchObject({test_commands_json:[],validation_recipe_id:null});
    expect(folders['project.folder.location.activate'].input.safeParse({project_id:'project',folder_id:'folder',location_id:'location',host_owner_user_id:'owner'}).success).toBe(false);
  });
  it('requires byte/hash and exact-version draft contracts without accepting caller ownership',()=>{
    const input={project_id:'project',folder_id:'folder',target_kind:'new',relative_path:'notes/new.md',base_exists:false,base_sha256:null,content:'text',content_sha256:'a'.repeat(64),byte_size:4,source_encoding:'utf8',preserve_bom:false,line_ending_mode:'none'};
    const schema=folders['project.folder.draft.upsert'].input;
    expect(schema.parse(input)).toMatchObject({expected_version:null,workspace_location_id:null});
    for(const path of ['../escape','/absolute','a/../escape','a\\escape','a//escape'])expect(schema.safeParse({...input,relative_path:path}).success).toBe(false);
    expect(schema.safeParse({...input,owner_user_id:'another'}).success).toBe(false);
    expect(schema.safeParse({...input,byte_size:1048577}).success).toBe(false);
    expect(schema.safeParse({...input,base_exists:true}).success).toBe(false);
    expect(folders['project.folder.draft.discard'].input.safeParse({project_id:'project',folder_id:'folder',draft_id:'draft',draft_version:0}).success).toBe(false);
    expect(folders['project.folder.draft.upsert'].output.safeParse({id:'draft',space_id:'space',project_id:'project',folder_id:'folder',workspace_location_id:'location',version:1,content:'PRIVATE'}).success).toBe(false);
  });
  it('keeps unregister confirmation explicit and rejects caller-supplied Host cleanup targets',()=>{
    const schema=folders['project.folder.unregister'].input;
    expect(schema.parse({project_id:'project',folder_id:'folder'})).toEqual({project_id:'project',folder_id:'folder',confirm:false});
    expect(schema.safeParse({project_id:'project',folder_id:'folder',confirm:true,host_id:'host'}).success).toBe(false);
  });
  it('keeps external Folder commands purpose-specific and their accepted receipts body-free',()=>{
    expect(io['project.folder.create'].input.parse({project_id:'project',name:'Folder'})).toMatchObject({kind:'code',root_path:null,repo_url:null,is_primary:false});
    expect(io['project.folder.scan'].input.safeParse({project_id:'project',root_path:'/host/path'}).success).toBe(false);
    expect(io['project.folder.draft.save'].input.safeParse({project_id:'project',folder_id:'folder',draft_id:'draft',draft_version:0}).success).toBe(false);
    expect(io['project.folder.draft.save'].input.safeParse({project_id:'project',folder_id:'folder',draft_id:'draft',draft_version:1,content:'PRIVATE'}).success).toBe(false);
    expect(io['project.folder.revision.restore'].input.safeParse({project_id:'project',folder_id:'folder',revision_id:'revision',owner_user_id:'owner'}).success).toBe(false);
    const receipt={id:'intent',space_id:'space',project_id:'project',folder_id:'folder',job_id:'job'};
    expect(io['project.folder.create'].output.safeParse({...receipt,root_path:'/private'}).success).toBe(false);
    expect(ProjectFolderIoStatusSchema.safeParse({...receipt,kind:'save_draft',status:'prepared',error:null,result:null,frozen_json:{content:'PRIVATE'}}).success).toBe(false);
  });
});
