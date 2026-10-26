export function noteAttempt(state:{attempts:number}) { return ++state.attempts; }
export function decide(n:number,max:number) { return n>=max?'give_up':'retry'; }
export function logAttempt(n:number) { return n; }
export function finalizeFailed(reason:string) { return 'failed:'+reason; }
export function salvageCheckpoint(reason:string) { return 'partial:'+reason; }
export function settlePending(reason:string) { return 'pending:'+reason; }
export function armTimer(n:number) { return n; }
