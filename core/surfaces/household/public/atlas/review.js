export const reviewStates={
 confirmed:{label:'Confirmé',plural:'Confirmés',symbol:'✓'},
 unreviewed:{label:'À vérifier',plural:'À vérifier',symbol:'◌'},
 hypothesis:{label:'Piste à confirmer',plural:'Pistes',symbol:'◇'},
 dismissed:{label:'Écarté',plural:'Écartés',symbol:'×'}
};
export function reviewState(event){return Object.hasOwn(reviewStates,event.reviewState)?event.reviewState:'unreviewed';}
export function reviewLabel(event){const state=reviewState(event);if(event.core)return event.core.souvenirNoteId?'Souvenir gardé':state==='confirmed'?'Retenu dans AgentX':state==='dismissed'?'Écarté dans AgentX':'À relire';return state==='confirmed'&&event.reviewUpdatedAt?'Confirmé par vous':state==='confirmed'&&event.confirmationBasis==='owner-testimony'?'Déclaré par toi':reviewStates[state].label;}
