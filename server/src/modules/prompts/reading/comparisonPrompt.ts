import {PROMPT_REVISION_FIXTURE,ReadingMethodGeneratedOutputSchema} from '@rainver/protocol';
import {HttpError} from '../../routeUtils/common.js';
import {sha256Json} from '../hash.js';
import {readingMethodBlock} from './runtime.js';
export function assertRevisionSample(target:string|undefined,pages:unknown){
 if(target==='prompt.revision.method'&&sha256Json(pages)!==sha256Json(PROMPT_REVISION_FIXTURE.pages))throw new HttpError(422,'Revision methods use the controlled prompt-and-feedback example');
}
export function comparisonPrompt(target:string|undefined,strategy:string,context:unknown,pages:unknown){
 return target==='prompt.revision.method'?`${strategy}\nReturn ONLY JSON with schema "reading_method_revision.v1", method (40..12000 characters), summary, changes. Revise the supplied prompt, not a product investigation.\n${JSON.stringify({baseline_method:PROMPT_REVISION_FIXTURE.pages[0].text,description:PROMPT_REVISION_FIXTURE.pages[1].text})}`:readingMethodBlock(strategy,context)+`\nOFFLINE CONTROLLED COMPARISON. Use only these supplied pages; cite supporting URLs and report unknowns. Return a readable Markdown investigation. No browsing/tools.\n${JSON.stringify(pages)}`;
}
export function revisionComparisonText(text:string){
 let value:unknown;try{value=JSON.parse(text);}catch{throw new HttpError(422,'Revision comparison requires valid JSON');}
 const parsed=ReadingMethodGeneratedOutputSchema.safeParse(value);if(!parsed.success)throw new HttpError(422,'Invalid revision comparison output');
 return `# Revised prompt\n${parsed.data.method}\n\n## Changes\n${parsed.data.summary}\n${parsed.data.changes.map(c=>'- '+c).join('\n')}`;
}
