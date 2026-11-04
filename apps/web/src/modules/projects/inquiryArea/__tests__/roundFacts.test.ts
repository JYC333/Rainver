// @vitest-environment node
import {describe,expect,it} from 'vitest'
import {inquiryRoundFacts} from '../roundFacts'
import type {InquiryThreadDetail,InquiryThreadStep} from '../../../../types/api'
const step=(round_number:number,iteration_id:string|null)=>({round_number,iteration_id} as InquiryThreadStep)
const detail=(round_number:number,round_started_at:string|null)=>({problem_summary:{round_number,round_started_at,round_start_ref:{kind:'thread',id:'t'},version:1,revision:0,current_focus:null}} as InquiryThreadDetail)
describe('legacy workspace round compatibility',()=>{
 it('position-only Iterations do not move the window',()=>{
  expect(inquiryRoundFacts(detail(1,null),[step(1,'position-only')]).roundSteps).toHaveLength(1)
 })
 it('no-change close-out advances the round without an Iteration',()=>{
  const facts=inquiryRoundFacts(detail(2,'2026-11-04T10:00:00Z'),[step(1,null),step(2,null)])
  expect(facts).toMatchObject({round:2,closedRounds:1,roundStartedAt:'2026-11-04T10:00:00Z'})
  expect(facts.roundSteps).toEqual([step(2,null)])
 })
 it('compensation preserves the real boundary instead of subtracting cognitive history',()=>{
  expect(inquiryRoundFacts(detail(2,'boundary'),[step(1,'original'),step(2,'compensation')])).toMatchObject({round:2,roundSteps:[step(2,'compensation')]})
 })
})
