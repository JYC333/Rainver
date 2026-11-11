import {expect,it} from 'vitest';
import {ProjectUpdateFrameSchema} from '../src/index.js';
it('keeps project invalidations content-free and bounded to known frame types',()=>{
 for(const type of ['ready','changed','denied'])expect(ProjectUpdateFrameSchema.parse({type})).toEqual({type});
 for(const input of [{type:'unknown'},{type:'changed',content:'private'},{type:'changed',project_id:'foreign'},{type:'changed',count:3}])expect(ProjectUpdateFrameSchema.safeParse(input).success).toBe(false);
});
