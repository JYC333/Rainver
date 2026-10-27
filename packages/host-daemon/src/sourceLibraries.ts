import {execFile} from "node:child_process";
import {realpath} from "node:fs/promises";
import {promisify} from "node:util";
import {helperProcessEnv} from "./providerBinding.js";
const exec=promisify(execFile);
/** Only the daemon-selected, trusted Node binary is inspected. ldd is a trusted
 * host helper, never available to code. Mount exact dependency files, not /usr/lib. */
export async function sourceNodeLibraries(node:string):Promise<{source:string;target:string}[]>{
 const {stdout}=await exec("/usr/bin/ldd",[node],{env:helperProcessEnv({PATH:"/usr/bin:/bin",LANG:"C"}),timeout:5000});
 if(stdout.includes("not found"))throw new Error("source_runtime_libraries_missing");
 const paths=new Set<string>();
 for(const line of stdout.split("\n")){
  const path=line.match(/=> (\/\S+)/)?.[1] ?? line.match(/^\s*(\/\S+)/)?.[1];
  if(path)paths.add(path);
 }
 if(!paths.size)throw new Error("source_runtime_libraries_missing");
 return Promise.all([...paths].map(async target=>({source:await realpath(target),target})));
}
