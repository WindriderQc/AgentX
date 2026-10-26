const rows = [
 ['1986-03-18','people','Le début de l’histoire','Naissance de Camille à Montréal. Un souvenir familial ajouté pour cette démonstration.',5,'Montréal'],
 ['1992-09-01','work','La première rentrée','Début de l’école primaire. Une nouvelle routine et les premiers amis de classe.',4,'Montréal'],
 ['1998-07-15','travel','Un été au bord du lac','Quelques semaines de vacances en famille, entre baignades et journées à vélo.',3,'Laurentides'],
 ['2003-06-20','work','Le diplôme en poche','Fin des études secondaires et préparation de la prochaine étape.',4,'Montréal'],
 ['2005-09-05','work','Les années étudiantes','Début des études universitaires à Sherbrooke.',5,'Sherbrooke'],
 ['2005-09-03','home','Le premier appartement','Installation dans un appartement partagé près du campus.',4,'Sherbrooke'],
 ['2007-04-10','people','Une amitié qui commence','Un échange organise une première sortie avec Alex. La date de la première rencontre réelle reste à préciser.',3,'Sherbrooke'],
 ['2008-08-12','travel','Un billet pour l’Europe','Un voyage de trois semaines, conservé dans des réservations et des cartes postales.',4,'Europe'],
 ['2009-05-29','work','La fin d’un chapitre','Diplôme universitaire obtenu, selon le souvenir déclaré de Camille.',5,'Sherbrooke'],
 ['2009-09-14','work','Le premier jour au studio','Début d’un emploi dans une équipe de création.',4,'Sherbrooke'],
 ['2010-06-19','people','Un week-end avec les amis','Un souper partagé et une randonnée le lendemain.',2,'Estrie'],
 ['2011-01-20','health','Reprendre la course','Inscription à un groupe de course du quartier.',2,'Sherbrooke'],
 ['2012-08-10','travel','Au rythme de la Gaspésie','Une semaine de route entre le fleuve, les villages et les sentiers.',4,'Gaspésie'],
 ['2013-11-09','work','Un projet qui prend forme','Présentation du premier grand projet de l’équipe.',3,'Sherbrooke'],
 ['2014-06-12','home','Un bail, une nouvelle adresse','Camille écrit avoir signé un bail à Québec. Le déménagement est prévu le 28 juin.',5,'Québec'],
 ['2014-06-20','home','Les cartons s’empilent','Préparation du déménagement et réservation du camion.',3,'Sherbrooke'],
 ['2014-06-28','home','Prendre racine à Québec','Le déménagement est prévu le 28 juin. Un courriel du 30 rapporte qu’il est terminé durant le week-end : le jour exact reste à confirmer.',5,'Québec'],
 ['2014-07-08','people','Les premiers voisins','Invitation à un souper dans le nouveau quartier.',2,'Québec'],
 ['2014-07-12','daily','Une première soirée ici','Un souvenir ordinaire du nouvel appartement : un repas, de la musique et des cartons encore fermés.',2,'Québec'],
 ['2015-02-04','health','Une nouvelle routine','Début d’un entraînement hebdomadaire.',2,'Québec'],
 ['2015-09-20','travel','La ville à pied','Découverte des quartiers pendant une fin de semaine.',2,'Québec'],
 ['2016-06-18','people','Tous réunis pour l’été','Une rencontre familiale au bord du fleuve.',4,'Québec'],
 ['2017-03-16','work','Se lancer à son compte','Camille annonce le début d’une activité indépendante. Le premier contrat est retrouvé dans la même correspondance.',5,'Québec'],
 ['2017-04-03','work','Le premier contrat','Un premier mandat signé ouvre la nouvelle activité.',4,'Québec'],
 ['2018-08-22','travel','Une parenthèse dans les montagnes','Quelques jours de marche et de découverte.',3,'Charlevoix'],
 ['2019-10-12','home','Une maison à imaginer','Première visite d’une maison, sans preuve d’un achat à cette date.',4,'Québec'],
 ['2020-05-10','daily','Le jardin du printemps','Un projet de jardin et des journées à l’extérieur.',2,'Québec'],
 ['2020-11-06','work','Travailler autrement','Mise en place d’un nouvel espace de travail à domicile.',3,'Québec'],
 ['2021-07-16','people','Enfin tous ensemble','Retrouvailles entre proches, après plusieurs mois sans rencontre documentée.',4,'Québec'],
 ['2022-08-06','travel','La route de l’Atlantique','Un voyage d’été entre paysages maritimes et petites escales.',4,'Maritimes'],
 ['2023-03-11','work','Apprendre, encore','Inscription à une formation suivie au printemps.',3,'Québec'],
 ['2023-09-19','health','Trouver son rythme','Un rendez-vous de suivi et une nouvelle routine déclarée.',2,'Québec'],
 ['2024-05-26','daily','Les petits projets du dimanche','Réparation d’un vélo et préparation de l’été.',2,'Québec'],
 ['2024-10-05','people','Un anniversaire entouré','Une soirée avec les personnes qui comptent.',3,'Québec'],
 ['2025-06-21','travel','Partir sans se presser','Une semaine de vacances et un itinéraire volontairement ouvert.',4,'Bas-Saint-Laurent'],
 ['2025-11-14','work','Un atelier pour créer','Installation d’un petit atelier personnel.',4,'Québec'],
 ['2026-04-18','daily','Des idées plein les carnets','Un nouveau projet personnel rassemble notes, croquis et essais.',3,'Québec'],
 ['2026-08-12','travel','Une journée au grand air','Une randonnée de fin d’été, retrouvée dans un échange de photos.',3,'Charlevoix']
];
export const demoSources = {};
export const demoEvents = rows.map((r,index)=>{
 const id=`demo-${index}`,mid=`demo-source-${index}`;
 demoSources[mid]={id:mid,threadId:id,date:`${r[0]}T14:00:00-04:00`,from:'Camille <camille@example.test>',to:'Alex <alex@example.test>',subject:r[2],body:`EXTRAIT FICTIF POUR LA DÉMONSTRATION\n\n${r[3]}\n\nCamille`,attachments:[],demo:true};
 return {id,title:r[2],description:r[3],date:r[0],originalDate:r[0],precision:'day',category:r[1],importance:r[4],place:r[5],status:'Scénario fictif',sourceIds:[mid],threadId:id,correspondent:'Camille · Alex',subject:r[2],origin:'demo',attachments:0,reviewState:[6,14,15,16,25].includes(index)?'unreviewed':'confirmed'};
});
demoEvents.push(
 {id:'demo-piste-installation',title:'Une installation progressive à Québec ?',description:'Le bail, le déménagement et les premières invitations dans le quartier pourraient former un même épisode d’installation.',date:'2014-07-15',originalDate:'2014-07',precision:'month',category:'home',importance:3,place:'Québec',status:'Rapprochement proposé · démo',reviewState:'hypothesis',rationale:'Les courriels du 12 juin, du 28 juin et du 8 juillet évoquent des étapes proches dans le temps et le même lieu. Leur regroupement en une période d’installation reste une proposition.',sourceIds:['demo-source-14','demo-source-16','demo-source-17'],relatedEventIds:['demo-14','demo-16','demo-17'],threadId:'demo-piste-installation',correspondent:'Camille · Alex',subject:'Plusieurs échanges rapprochés',origin:'demo',attachments:0},
 {id:'demo-piste-independance',title:'Une transition vers l’indépendance ?',description:'L’annonce de l’activité et le premier contrat suggèrent une transition professionnelle au printemps 2017. La période exacte reste à confirmer.',date:'2017-03-15',originalDate:'2017-03',precision:'month',category:'work',importance:3,place:'Québec',status:'Rapprochement proposé · démo',reviewState:'hypothesis',rationale:'Une annonce du 16 mars est suivie d’un premier contrat le 3 avril. Ces deux éléments suggèrent une transition, sans suffire à dater la fin de la situation précédente.',sourceIds:['demo-source-22','demo-source-23'],relatedEventIds:['demo-22','demo-23'],threadId:'demo-piste-independance',correspondent:'Camille · Alex',subject:'Annonce et premier contrat',origin:'demo',attachments:0},
 {id:'demo-piste-voyages',title:'Un rituel de voyages d’été ?',description:'Plusieurs voyages documentés durant l’été pourraient constituer un fil récurrent dans cette histoire. C’est une lecture proposée, pas un rituel confirmé.',date:'2025-06-15',originalDate:'2025-06',precision:'month',category:'travel',importance:2,status:'Motif proposé · démo',reviewState:'hypothesis',rationale:'Des séjours en 2012, 2022 et 2025 se situent pendant l’été. La récurrence est suggestive; les archives ne montrent pas toutes les années.',sourceIds:['demo-source-12','demo-source-29','demo-source-34'],relatedEventIds:['demo-12','demo-29','demo-34'],threadId:'demo-piste-voyages',correspondent:'Camille · Alex',subject:'Plusieurs étés dans les archives',origin:'demo',attachments:0}
);
