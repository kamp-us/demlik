import {MAX_ATTEMPTS,BACKOFF} from './limits.js';
import {noteAttempt,decide,logAttempt,finalizeFailed,salvageCheckpoint,settlePending,armTimer} from './helpers.js';
export function reDispatchOrGiveUp(state:{attempts:number}) {
  const count=noteAttempt(state);
  const decision=decide(count,MAX_ATTEMPTS);
  logAttempt(count);
  if(decision==='give_up') {
    return finalizeFailed(decision);
  }
  return String(armTimer(BACKOFF));
}
export function recoverTransientStep(state:{attempts:number}) {
  const count=noteAttempt(state);
  const decision=decide(count,MAX_ATTEMPTS);
  logAttempt(count);
  if(decision==='give_up') {
    return salvageCheckpoint(decision);
  }
  return String(armTimer(BACKOFF));
}
