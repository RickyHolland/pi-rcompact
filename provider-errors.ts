/** Preserve retry classification when Splash reports a 503 inside an HTTP 200 SSE stream. */
export function normalizeSplashError(model:any,message:any) {
  if(model?.provider!=='splash' || message?.stopReason!=='error' || typeof message.errorMessage!=='string')return message;
  if(!/^the inference engine stopped unexpectedly and is restarting; retry the request$/i.test(message.errorMessage.trim()))return message;
  return {...message,errorMessage:'503 Service unavailable: '+message.errorMessage};
}

export function classifySplashStream(model:any,source:any) {
  // Test/custom providers can return a promise or ordinary value. Only wrap
  // real event streams, preserving every unrelated property and method.
  if(model?.provider!=='splash'||!source?.[Symbol.asyncIterator]||typeof source.result!=='function')return source;
  return new Proxy(source,{get(target,key){
    if(key==='result')return async()=>normalizeSplashError(model,await target.result());
    if(key===Symbol.asyncIterator)return async function*(){
      for await(const event of target){
        yield event.type==='error'?{...event,error:normalizeSplashError(model,event.error)}:event;
      }
    };
    const value=Reflect.get(target,key,target);
    return typeof value==='function'?value.bind(target):value;
  }});
}
