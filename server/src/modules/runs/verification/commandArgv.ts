import {parse} from 'shell-quote';

/** Decode words, never execute a shell or expand the control-plane environment.
 * Quoted program text and explicit argv entries may contain literal operators. */
export function verificationCommandArgv(value:unknown):string[]|null{
 let parts:unknown[];
 if(Array.isArray(value))parts=value;
 else if(typeof value==='string'&&value.trim()&&!/[\0\r\n]/.test(value)&&balancedQuotes(value)){
  try{
   parts=parse(value,()=>{throw new Error('Verification does not expand environment variables');})
    .map(part=>typeof part==='object'&&'op' in part&&part.op==='glob'?part.pattern:part);
  }catch{return null;}
 }else return null;
 if(!parts.length||!parts.every((part):part is string=>typeof part==='string'&&part.length>0&&!part.includes('\0')))return null;
 // An environment assignment is not an executable. Flags such as --workers=1
 // and executable paths containing '=' remain ordinary arguments.
 return /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0])?null:parts;
}

// shell-quote tolerates unfinished quotes; configuration must fail before save.
function balancedQuotes(command:string):boolean{
 let quote:string|null=null;
 for(let i=0;i<command.length;i++){
  const char=command[i];
  if(char==='\\'&&quote!=="'"){
   if(++i===command.length)return false;
   continue;
  }
  if(quote){if(char===quote)quote=null;}
  else if(char==='"'||char==="'")quote=char;
 }
 return quote===null;
}
