import { StringDecoder } from "node:string_decoder";
/** Byte ceilings apply before decoding. A frame can span any number of chunks;
 * consuming multiple frames never changes the caller's protocol state checks. */
export class SourceFrameDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bytes = 0;
  private frameBytes=0;
  constructor(private readonly maxBytes: number, private readonly onFrame: (frame: unknown) => void, private readonly maxFrameBytes=maxBytes) {}
  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) throw new Error("source_channel_limit");
    let start=0,index:number;
    while((index=chunk.indexOf(10,start))>=0){
      this.frameBytes+=index-start;
      if(this.frameBytes>this.maxFrameBytes)throw new Error("source_frame_limit");
      this.frameBytes=0;start=index+1;
    }
    this.frameBytes+=chunk.length-start;
    if(this.frameBytes>this.maxFrameBytes)throw new Error("source_frame_limit");
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line=this.buffer.slice(0,newline); this.buffer=this.buffer.slice(newline+1);
      this.onFrame(JSON.parse(line));
    }
  }
  finish(): void {
    this.buffer+=this.decoder.end();
    if(this.buffer) throw new Error("source_channel_incomplete");
  }
}
