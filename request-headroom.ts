/** Final-payload guard for Splash. Tokenizer calls perform no inference. */
export function fitOutputBudget(payload: any, inputTokens: number, contextWindow: number) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error('Invalid context measurement');
  const fields=['max_tokens','max_completion_tokens','max_output_tokens'].filter(k=>payload[k]!==undefined);
  if (fields.length>1) throw new Error('Conflicting output-token limits');
  const field=fields[0]??'max_tokens';
  const wanted=payload[field];
  if (wanted===undefined) return payload; // Preserve Splash's own default output budget.
  if (wanted!==undefined && (!Number.isSafeInteger(wanted)||wanted<=0)) return payload; // Provider reports invalid input.
  const available=contextWindow-inputTokens;
  if (wanted<=available) return payload;
  // Do not create a zero-token or trivially small continuation. Pi recognises
  // this error and enters its existing compact-and-retry recovery once.
  if (available<1024) throw new Error(`context_length_exceeded: prompt leaves insufficient output headroom (${inputTokens} input tokens in ${contextWindow}-token context)`);
  return {...payload,[field]:available};
}

export function createHeadroomGuard(fetcher: typeof fetch = fetch) {
  const capabilities=new Map<string,{until:number,window:number|null}>();
  return async (model:any,payload:any,signal?:AbortSignal) => {
    if (model?.provider!=='splash' || model?.api!=='openai-completions' || !Array.isArray(payload?.messages)) return {payload};
    let url:URL;
    try {url=new URL(model.baseUrl);} catch {return {payload};}
    if (url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password) return {payload};
    const base=url.origin;
    const signals=[AbortSignal.timeout(45000),...(signal?[signal]:[])];
    const combined=AbortSignal.any(signals);
    const request=async(path:string,body?:any)=>{
      const response=await fetcher(base+path,{method:body===undefined?'GET':'POST',redirect:'error',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:combined});
      if(!response.ok) throw new Error('Tokenizer unavailable');
      return response.json();
    };
    let inputTokens:number;
    let window:number;
    try {
      let capability=capabilities.get(base);
      if (!capability || capability.until<Date.now()) {
        const status=await request('/status');
        capability={until:Date.now()+30000,window:status.schema_version===6 && Number.isSafeInteger(status.maximum_context_tokens) ? status.maximum_context_tokens : null};
        capabilities.set(base,capability);
      }
      if (!capability.window) return {payload};
      // Image embeddings have additional native rows which the text tokenizer
      // cannot measure. Keep provider validation for multimodal requests.
      if (payload.messages.some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type!=='text'))) return {payload};
      window=Math.min(capability.window,model.contextWindow>0?model.contextWindow:capability.window);
      const rendered=await request('/apply-template',payload);
      if(typeof rendered.prompt!=='string')throw new Error('Invalid template response');
      const measured=await request('/tokenize',{content:rendered.prompt});
      if(!Array.isArray(measured.tokens))throw new Error('Invalid tokenizer response');
      inputTokens=measured.tokens.length;
    } catch(error) {
      if(signal?.aborted)throw error;
      // A temporarily unavailable/older tokenizer must not prevent ordinary
      // inference. Provider overflow recovery still clears the failed capture.
      return {payload};
    }
    return {payload:fitOutputBudget(payload,inputTokens,window),inputTokens};
  };
}
