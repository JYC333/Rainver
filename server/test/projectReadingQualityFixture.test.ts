import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';

// Corpus integrity only. No model is invoked and null human evaluation is intentional.
const corpus=JSON.parse(readFileSync(new URL('./fixtures/projectReadingQuality.v1.json',import.meta.url),'utf8')) as {
 schema_version:number;label:string;rubric:string[];cases:Array<{
 id:string;purposes:string[];project_facts:string[];favorite:boolean;
 inputs:Array<{id:string;url:string;kind:string;origin:string;published_at:string;passages:Array<{anchor:string;text:string}>}>;
 supported:string[];unsupported:string[];gaps:string[];expected_citations:Array<{input_id:string;anchor:string}>;human_evaluation:null;
 }>;
};
describe('Project Reading synthetic human-evaluation corpus integrity (not semantic quality)',()=>{
 it('keeps the version, required scenarios and unassessed rubric explicit',()=>{
  expect(corpus.schema_version).toBe(1);expect(corpus.label).toContain('SYNTHETIC');expect(corpus.rubric).toHaveLength(7);
  expect(corpus.cases.map(c=>c.id)).toEqual(['learning','systems','syndication','conflict','old-new-discovery','homepage-only','missing-project','unfavorited','two-purposes']);
  expect(new Set(corpus.cases.map(c=>c.id)).size).toBe(corpus.cases.length);
 });
 it.each(corpus.cases)('$id supplies bounded identifiable evidence and citations, not invented evaluation results',c=>{
  expect(c.human_evaluation).toBeNull();expect(c.purposes.length).toBeGreaterThan(0);
  expect(c.supported.length).toBeGreaterThan(0);expect(c.unsupported.length).toBeGreaterThan(0);expect(c.gaps.length).toBeGreaterThan(0);
  const ids=new Set(c.inputs.map(i=>i.id));expect(ids.size).toBe(c.inputs.length);
  expect(c.inputs.length).toBeLessThanOrEqual(3);
  for(const input of c.inputs){
   expect(new URL(input.url).hostname).toBe('synthetic.example');expect(['original','analysis']).toContain(input.kind);
   expect(Number.isFinite(Date.parse(input.published_at))).toBe(true);expect(input.origin).toBeTruthy();
   expect(input.passages.reduce((n,p)=>n+p.text.length,0)).toBeLessThan(6000);
  }
  for(const citation of c.expected_citations){const input=c.inputs.find(i=>i.id===citation.input_id);expect(input).toBeDefined();expect(input!.passages.some(p=>p.anchor===citation.anchor)).toBe(true);}
 });
 it('retains the traps that require a human judgment instead of a schema pass',()=>{
  const by=(id:string)=>corpus.cases.find(c=>c.id===id)!;
  expect(new Set(by('syndication').inputs.filter(i=>i.kind==='original').map(i=>i.origin)).size).toBe(1);
  expect(by('syndication').inputs.some(i=>i.kind==='analysis')).toBe(true);
  expect(by('missing-project').project_facts).toEqual([]);expect(by('unfavorited').favorite).toBe(false);
  expect(by('two-purposes').purposes).toHaveLength(2);expect(by('two-purposes').inputs).toHaveLength(1);
  expect(by('homepage-only').inputs).toHaveLength(1);expect(by('old-new-discovery').inputs[0].published_at).toBe('2017-05-01');
 });
});
