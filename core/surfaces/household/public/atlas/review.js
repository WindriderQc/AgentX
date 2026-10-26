export const reviewStates={
 confirmed:{label:'Confirmé',plural:'Confirmés',symbol:'✓'},
 unreviewed:{label:'À vérifier',plural:'À vérifier',symbol:'◌'},
 hypothesis:{label:'Piste à confirmer',plural:'Pistes',symbol:'◇'},
 dismissed:{label:'Écarté',plural:'Écartés',symbol:'×'}
};
export function reviewState(event){return Object.hasOwn(reviewStates,event.reviewState)?event.reviewState:'unreviewed';}
export function reviewLabel(event){const state=reviewState(event);if(state==='confirmed')return event.core?.assertionState==='confirmed'?'Confirmé par toi':event.confirmationBasis==='owner-testimony'?'Déclaré par toi':'Confirmé';if(state!=='dismissed'&&['owner-testimony','owner-tentative'].includes(event.confirmationBasis))return 'Déclaré par toi';if(event.core?.recordedAssertionState==='confirmed'&&event.core.confirmationCurrent===false)return 'Modifié depuis ta confirmation';return reviewStates[state].label;}
