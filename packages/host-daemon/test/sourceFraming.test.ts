import {expect,it} from "vitest";
import {SourceFrameDecoder} from "../src/sourceFraming.js";
it("A1 decodes coalesced frames and every byte split including emoji",()=>{
 const frames:unknown[]=[];const data=Buffer.from(JSON.stringify({text:"中🙂".repeat(20000)})+'\n'+JSON.stringify({done:true})+'\n');
 const decoder=new SourceFrameDecoder(data.length,x=>frames.push(x));for(const byte of data)decoder.push(Buffer.from([byte]));decoder.finish();
 expect(frames).toEqual([{text:"中🙂".repeat(20000)},{done:true}]);
 const combined:unknown[]=[];const second=new SourceFrameDecoder(data.length,x=>combined.push(x));second.push(data);second.finish();expect(combined).toEqual(frames);
});
it("rejects incomplete or oversized byte streams",()=>{
 const decoder=new SourceFrameDecoder(2,()=>{});expect(()=>decoder.push(Buffer.from("🙂"))).toThrow("limit");
 const partial=new SourceFrameDecoder(100,()=>{});partial.push(Buffer.from('{"x":1}'));expect(()=>partial.finish()).toThrow("incomplete");
});
