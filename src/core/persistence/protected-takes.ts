import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../takes-fence.ts';
import { OperationError } from '../ops/contract.ts';

/**
 * Offset of the first occurrence of `marker` that is the sole non-whitespace
 * content of its line, at or after `from`. The real takes fence writer always
 * emits the markers block-level (alone on their lines), so a marker wrapped in
 * backticks or mid-prose — a page that DOCUMENTS the fence syntax, e.g. the
 * filing-rules skill — is not a fence and is skipped. Returns -1 if none.
 */
function standaloneMarker(body:string,marker:string,from=0):number {
  for(let i=from;i<=body.length;){
    const idx=body.indexOf(marker,i);
    if(idx<0) return -1;
    const lineStart=body.lastIndexOf('\n',idx)+1;
    const nl=body.indexOf('\n',idx);
    const lineEnd=nl<0?body.length:nl;
    if(body.slice(lineStart,lineEnd).trim()===marker) return idx;
    i=idx+marker.length;
  }
  return -1;
}
function fence(body:string):string|null {
  const start=standaloneMarker(body,TAKES_FENCE_BEGIN);
  if(start<0) return null;
  const end=standaloneMarker(body,TAKES_FENCE_END,start+TAKES_FENCE_BEGIN.length);
  if(end<0 || standaloneMarker(body,TAKES_FENCE_BEGIN,start+TAKES_FENCE_BEGIN.length)>=0) {
    throw new OperationError('invalid_params','The takes fence must be repaired before replacing this page.');
  }
  return body.slice(start,end+TAKES_FENCE_END.length);
}
/** Remote full-page reads omit takes; a round trip must preserve their canonical fence. */
export function preserveProtectedTakes(incoming:string,stored:string):string {
  const before=fence(stored),after=fence(incoming);
  if(after!==null && after!==before) throw new OperationError('permission_denied','Use the scoped takes operations to mutate a takes fence.');
  if(before===null || after!==null) return incoming;
  return `${incoming.trimEnd()}\n\n${before}\n`;
}
