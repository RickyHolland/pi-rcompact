/** Capacity recovery preserves filtered evidence and tool schemas, forking the rendered prefix. */
import {hasCapability, isLoopbackHttp} from "./engine-capabilities";
export function isSushiPrefillRefusal(model:any,message:unknown):boolean {
 return hasCapability(model,'prefillCapacityRecovery') && model?.api==='openai-completions' && isLoopbackHttp(model) && typeof message==='string' && (/\bPrefillDoesNotFit\b/.test(message) || /Context \d+ does not fit available GPU memory at KV(?:4|8), prefill chunk \d+\. Maximum context: \d+ tokens\. Reduce context or free memory\./.test(message));
}
export function freshSummaryPrefix(payload:any,nonce:string):any {
 if(!Array.isArray(payload?.messages))throw new Error('Capacity recovery requires captured messages');
 const marker=`[CHECKPOINT RECOVERY ${nonce}] Use the preserved evidence below; omit this diagnostic marker from the checkpoint.\n`;
 const messages=payload.messages.slice();
 const first=messages[0];
 if(first && ['system','developer'].includes(first.role)){
  if(typeof first.content==='string')messages[0]={...first,content:marker+first.content};
  else if(Array.isArray(first.content))messages[0]={...first,content:[{type:'text',text:marker},...first.content]};
  else throw new Error('Capacity recovery cannot preserve the system content');
 }else messages.unshift({role:'system',content:marker});
 // Qwen's template renders tool definitions before system text. A system-only
 // marker still shares that long tool prefix and can pin the entire hot entry.
 let tools=payload.tools;
 if(Array.isArray(tools)&&tools.length){
  const firstTool=tools[0];
  if(firstTool?.type!=='function'||!firstTool.function||typeof firstTool.function.name!=='string'||(firstTool.function.description!==undefined&&typeof firstTool.function.description!=='string'))throw new Error('Capacity recovery cannot preserve the first tool definition');
  tools=[{...firstTool,function:{...firstTool.function,description:marker+(firstTool.function.description??'')}},...tools.slice(1)];
 }
 return {...payload,messages,...(tools===undefined?{}:{tools})};
}
/** Only a successfully stopped thinking-only response is eligible for recovery. */
export function isThinkingOnlySummary(message: any): boolean {
  return message?.stopReason === "stop" && Array.isArray(message.content) &&
    message.content.some((b: any) => b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) &&
    !message.content.some((b: any) => b.type === "toolCall" || (b.type === "text" && b.text?.trim()));
}

export const CHECKPOINT_HEADINGS = ["Goal", "Constraints & Preferences", "Progress", "Key Decisions", "Next Steps", "Critical Context"];
export function hasCheckpointHeadings(text: string): boolean {
 return CHECKPOINT_HEADINGS.every(heading=>text.split("\n").some(line=>line.trim()===`## ${heading}`));
}
export function needsSummaryFormatRecovery(message: any): boolean {
 if(message?.stopReason!=="stop" || !Array.isArray(message.content) || message.content.some((b:any)=>b.type==="toolCall"))return false;
 const text=message.content.filter((b:any)=>b.type==="text" && typeof b.text==="string").map((b:any)=>b.text).join("\n").trim();
 return text.length>0 && !hasCheckpointHeadings(text);
}
