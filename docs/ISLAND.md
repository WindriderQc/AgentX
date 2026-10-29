# Île : un agent seul sur une île Clawblox

Mis à jour le 2026-10-29 à 03:00 America/Toronto.

On refait l'expérience du MIT *Is this machine playing?*
([arXiv 2610.07130](https://arxiv.org/abs/2610.07130)) : un agent sans tâche,
seul sur une île simulée, avec une mémoire en fichiers. L'île est le moteur
open source de l'article, [Clawblox](https://github.com/nacloos/clawblox)
(licence MIT). L'agent est Codex, piloté par Clawblox. Il pense avec
`agentx-primary` au travers de la porte OpenAI de Core : jamais un nom de
modèle concret.

Cette page décrit la première version produit : l'onglet **Île** de Benchmark
et l'exécuteur de file `island`. Elle remplace les scripts du prototype
(`work/island/` de l'instance : `run_eko.py`, `queue_watch_launch.py`).

```
 Benchmark (onglet Île)        Core (file des travaux lourds)       hôte d'opération
 ┌──────────────────────┐      ┌───────────────────────────┐       ┌─────────────────────────┐
 │ Lancer ──────────────┼─────►│ demande « other/island » │◄──────┤ heavy-work-queue.cjs    │
 │ Parties, reçus       │◄─────┤ créneau, départ, reçu     │       │  island-watch / run     │
 │ Vue 3D, mémoire      │◄─────┼───────── rapports ─────────┼───────┤  island-settle          │
 └─────────┬────────────┘      └───────────────────────────┘       └───────────┬─────────────┘
           │ iframe                                                        ssh │ (ou local)
           ▼                                                                    ▼
 ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 │ hôte d'exécution (UGStation prévu)    island_runner.py                                   │
 │   île Clawblox (vue en direct)   bac à sable : Codex ── relais ──► Core /api/llm/v1      │
 │   clawblox app (relectures)      mémoire de l'agent entre les parties                    │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
```

## Ce qui décide d'un départ

« Lancer » inscrit une demande dans la file de Core et peut demander à Core
de placer un créneau (cette nuit ou dès que possible). **Un créneau ne lance
rien.** Le départ demande deux choses :

1. ton approbation : tu lances toi-même `island-watch` (ou `run`) sur l'hôte
   d'opération pour cette demande ;
2. l'admission de Core : la fenêtre est ouverte, aucun autre travail ne tient
   la machine, et l'hôte principal est prêt (pas réservé par Benchmark).

Core ne démarre jamais une partie seul : le lancement automatique
(`autoStart`) et « Run now » refusent ce type de demande.

## La demande de file

Une partie est une demande `kind: "other"` avec un exécuteur typé. Elle ne
porte ni commande, ni adresse, ni jeton, ni nom de modèle :

```json
{
  "key": "island:<identifiant unique>",
  "title": "Île — Eko, 60 min",
  "kind": "other",
  "hosts": ["<point d'accès Ollama du principal>"],
  "estimatedMinutes": 70,
  "source": {"type": "operator", "ref": "benchmark-island-tab"},
  "executor": {"mode": "island", "receiptRef": "island/<identifiant>.json",
               "agent": "Eko", "minutes": 60, "memory": "continue", "world": "mesa-island"}
}
```

- `minutes` : de 5 à 720. `estimatedMinutes` doit couvrir `minutes + 10`
  (démarrage de l'île, arrêt et preuve de libération).
- `memory` : `continue` reprend l'espace de travail de la dernière partie
  « continue » de cet agent ; `fresh` part des modèles et ne touche pas à la
  mémoire de l'agent qui a joué.
- `hosts` : le point d'accès de la voie principale au moment de « Lancer ».
  Si le pin a changé d'hôte avant le départ, la partie refuse avant toute
  marque de départ ; il faut alors une nouvelle demande.

## Déroulement (exécuteur `island`)

`node integrations/operations/heavy-work-queue.cjs` sur l'hôte d'opération
(le même outil que les autres exécuteurs) :

```bash
# Attendre que Core place la demande (cette nuit), puis partir à l'heure du créneau
node integrations/operations/heavy-work-queue.cjs island-watch --core <origine-core> --actor <toi> --id <demande> --when tonight

# Partir tout de suite, pour une demande déjà réservée dont la fenêtre est ouverte
node integrations/operations/heavy-work-queue.cjs run --core <origine-core> --actor <toi> --id <demande> --revision <révision>

# Reprendre le suivi d'une partie déjà partie (par exemple après une coupure) : ne relance jamais
node integrations/operations/heavy-work-queue.cjs island-settle --core <origine-core> --actor <toi> --id <demande>
```

Dans l'ordre :

1. **Vérifications refusables, avant toute marque :** l'hôte d'exécution
   répond, il est configuré et libre ; le principal est prêt, non réservé,
   son contexte est connu et son point d'accès est dans `hosts` ; aucune
   trace locale d'un départ précédent pour cette demande.
2. **Marque de départ durable** (`begin`), puis vérification de la fenêtre.
3. **Départ** sur l'hôte d'exécution, sous l'identifiant de la demande. Un
   identifiant ne part qu'une fois : un second départ est refusé.
   - L'hôte refuse (occupé, entrée invalide) : rien n'est parti, la marque
     est levée avec un reçu `island:not-started`.
   - Réponse perdue : on relit l'état de cette partie. Si elle n'y est pas
     sous cette marque, la demande devient `uncertain` et attend l'opérateur.
4. **Suivi** toutes les 30 s ; chaque lecture est rapportée à Benchmark.
   Sans réponse de l'hôte pendant 15 minutes, l'outil s'arrête et laisse la
   demande en cours : `island-settle` reprend plus tard.
5. **Fin :** reçu `agentx.operator-heavy-work/v1` écrit dans
   `$AGENTX_ACTION_RECEIPTS_DIR/island/<demande>-<départ>.receipt.json`, avec
   l'état de la partie, ses relances et l'état du principal après coup.
   - Libération prouvée (aucun processus de la partie restant, principal non
     réservé) : `operator-finish` avec l'empreinte SHA-256 du reçu. Si Core
     tient encore la dernière requête de l'agent, il refuse ; l'outil
     réessaie toutes les 30 s, 20 fois au plus.
   - Libération non prouvée : le reçu est gardé, la demande reste ouverte
     pour l'opérateur.

Le résultat dans Core porte l'autorité `operator-attestation` (opération
`island`) : c'est une attestation, pas un reçu natif observé par Core.

## L'hôte d'exécution

Décision du 2026-10-29 : l'île vivra sur **UGStation**, directement sous
Linux, sans VM (Dell OptiPlex 7020, i3-4130, 8 Go, SSD 480 Go, toujours
allumé ; aujourd'hui borne de la cuisine, jusqu'à ce qu'UGSmall la remplace).
Mesuré : l'île seule prend environ 32 Mo et 6 % d'un cœur ; un agent Codex
de 0,2 à 0,5 Go. Les deux premiers essais ont tourné sur devX.

Le code ne dépend pas de ce choix : l'outil de file parle à
`integrations/island/island_runner.py` en local ou par SSH, avec une petite
interface en JSON (`check`, `start`, `status`, `stop`, `memory`). L'adresse
et l'accès SSH d'UGStation ne sont pas encore connus ; ils restent des
réglages d'instance (`AGENTX_ISLAND_RUNNER=ssh:<cible>`).

Préparation prévue sur UGStation (rien n'y est installé à ce jour) :

- un compte Linux dédié aux agents, distinct du compte de la borne ;
- Clawblox avec les correctifs AgentX (bac à sable bubblewrap isolé) ;
- un pare-feu sortant qui n'autorise que la porte de Core ;
- `island_runner.py`, le venv Clawblox et la configuration ci-dessous sous ce
  compte, avec le serveur de relecture `clawblox app`.

Réglages de l'outil de file (environnement de l'hôte d'opération) :

| Variable | Rôle |
|---|---|
| `AGENTX_ISLAND_RUNNER` | `local`, ou `ssh:<cible>` (par exemple `ssh:devx`) |
| `AGENTX_ISLAND_RUNNER_SCRIPT` | chemin absolu de `island_runner.py` sur l'hôte d'exécution |
| `AGENTX_ISLAND_RUNNER_PYTHON` | interpréteur qui voit le module `clawblox` (le venv), `python3` par défaut |
| `AGENTX_ISLAND_RUNNER_LABEL` | nom affiché dans l'onglet (sinon la cible SSH) |
| `AGENTX_ACTION_RECEIPTS_DIR` | dossier privé des reçus (déjà utilisé par Benchmark) |

Réglages de l'hôte d'exécution, dans `~/.config/agentx/island-runner.json`
(ou `AGENTX_ISLAND_RUNNER_CONFIG`) :

```json
{
  "runsRoot": "/home/<compte>/codes/clawblox-runs/agentx",
  "worldsRoot": "/home/<compte>/codes/clawblox/worlds",
  "clawbloxBin": "/home/<compte>/codes/clawblox/target/release",
  "codex": "/home/<compte>/.local/bin/codex",
  "tokenFile": "/home/<compte>/.config/agentx/llm-gateway-<client>.token",
  "gatewayHost": "<nom public de Core>",
  "gatewayGuestPort": 8443,
  "worldPort": 18080,
  "timeZone": "America/Toronto",
  "netcheckBlocked": ["http://<core-lan>:3180/", "http://<ollama>:11434/api/tags"]
}
```

`runsRoot` doit rester court : Clawblox place les sockets des relais de
l'agent sous `<runsRoot>/<demande>/agents/<agent>/runtime/netrelay/`, et un
chemin de socket Unix ne dépasse pas 107 octets. Pour Eko, `runsRoot` tient
en 28 caractères au plus (par exemple `/home/eko/island/runs`) ; `check`
et `start` refusent un chemin trop long avant tout départ.

Clawblox doit porter les correctifs AgentX (isolation réseau, espaces de
processus et d'IPC propres, variables d'opérateur retirées, lecture des
journaux Codex dans la relecture). Le correctif versionné est dans
`integrations/island/clawblox-isolation.patch`, sur la base upstream `8be90a0`.
Le module doit annoncer `agentx_isolation_version() == 1` ; une version ancienne
est refusée avant de démarrer. Aucun changement du HOME du contrôleur n’est fait.

Chaque partie a son dossier `<runsRoot>/<demande>/` : `request.json`,
`state.json` (phase, relances, lien de la vue en direct), `world.log`,
`recordings/`, l'agent et son bac à sable, et `memory-after/`. La mémoire
d'un agent entre les parties est dans `<runsRoot>/memory/<agent>/`.
Seuls `SOUL.md`, `EPISODIC_MEMORY.md`, `EPISODIC_MEMORY.jsonl` et
`SEMANTIC_MEMORY.md` passent d’une partie à l’autre. Les autres fichiers,
les sessions et les credentials ne sont jamais repris ; les symlinks refusent.

Le bac à sable n’atteint plus le domaine Core entier : il reçoit un jeton
éphémère vers un relais local qui n’expose que les routes LLM nécessaires et
l’alias `agentx-primary`. Le vrai jeton d’un client de passerelle dédié reste
sur l’hôte. La clôture exige une observation native de libération du dispatch,
et non seulement l’absence de claim Benchmark. Voir le
[contrat de sécurité](../integrations/island/README.md).


Ce que la partie fait, repris du prototype :

- l'agent démarre avec `SOUL.md` (en lecture seule), les consignes de mémoire
  et le prompt système, dont les variables sont remplies (Clawblox ne le fait
  pas pour un prompt personnalisé) ;
- **relance après un blocage** : un tour terminé sans suite depuis 90 s (ce
  que laisse une réponse coupée par la limite de sortie) ou aucune activité
  depuis 15 min. L'agent est arrêté puis la même session reprend avec
  « continue » (Clawblox ne peut pas parler à un agent en cours). Au moins
  2 min entre deux relances, 30 au plus ;
- **rappel de mémoire** 5 minutes avant la fin de chaque épisode, par le même
  arrêt-reprise ;
- **remise à zéro du contexte chaque heure**, comme dans l'article : une partie
  de plus d'une heure est une suite d'épisodes (`episodeMinutes`, 60 par
  défaut, dans la configuration de l'hôte d'exécution). Le monde tourne d'un
  bout à l'autre et les fichiers de l'espace de travail restent ; à chaque
  épisode, Codex repart d'une session neuve avec « Begin. », donc sans
  l'historique de l'heure précédente. Ça borne aussi le coût : la porte de
  Core est sans cache et renvoie tout l'historique à chaque tour. Le reçu
  liste les épisodes (`episodes`) ; une reprise ratée fait échouer la partie ;
- un agent disparu, une absence d’activité initiale/récente, une relance
  impossible, un netcheck échoué ou un arrêt raté font échouer la partie.

Test du bac à sable sans modèle (ni file ni jeton) :

```bash
python island_runner.py start --run-id $(uuidgen) --netcheck --minutes 5
```

Le résultat est dans `agents/<agent>/workspace/netcheck.json` de la partie.

## L'onglet Île (Benchmark)

Quatre sections, dans une seule entrée du menu de Benchmark :

- **Lancer une partie** : agent, durée, mémoire (continuer ou neuve) et
  créneau (cette nuit, dès que possible ou sans créneau). Rien ne part : la
  demande attend ton approbation, puis l'admission de Core (voir
  « Déroulement » plus haut pour les commandes).
- **Parties** : début avec son fuseau, durée, état (celui de la file de Core
  d'abord) et deux boutons. Un clic sur la date ouvre le détail : agent et
  mémoire, relances, reçu (empreinte et autorité de Core) et la fiche JSON.
  L'agent pense toujours avec `agentx-primary` au travers de Core.
  - **Voir** : la vue 3D de Clawblox en direct pendant la partie, ou sa
    relecture ensuite, avec le panneau **Messages** qui déroule les pensées
    et les commandes de l'agent. Benchmark demande au serveur `clawblox app`
    de l'hôte d'exécution d'ouvrir l'enregistrement.
  - **Mémoire** : « Personnalité » (`SOUL.md`), « Journal »
    (`EPISODIC_MEMORY.jsonl`, en liste d'épisodes) et « Savoir »
    (`SEMANTIC_MEMORY.md`), avec un choix parmi les parties du même agent.
- **Vue 3D** et **Mémoire** restent cachées tant qu'aucune partie n'est
  choisie.

Réglages de Benchmark :

| Variable | Rôle |
|---|---|
| `AGENTX_ISLAND_VIEW_ORIGIN` | schéma et hôte (sans port) de l'hôte d'exécution vus du navigateur |
| `AGENTX_ISLAND_REPLAY_URL` | origine du serveur `clawblox app <runsRoot> --port <port>` |
| `AGENTX_ISLAND_GRAPHYSX_URL` | adresse d'une version de GraphysX-Web (par exemple `http://hôte:4231/`) ; « Voir » ouvre alors sa page `?app=island` |
| `AGENTX_ISLAND_RENDERER` | `clawblox` ou `graphysx` pour forcer le rendu ; sinon GraphysX dès que son adresse est réglée |

Le serveur de relecture se lance sur l'hôte d'exécution, à la racine des
parties :

```bash
clawblox app <runsRoot> --port 18092
```

Une page Benchmark servie en HTTPS ne peut pas afficher une vue en HTTP dans
la page : le navigateur la bloque. L'onglet propose alors « Ouvrir dans un
nouvel onglet ». Pour l'intégrer dans la page, il faut publier la vue en
HTTPS derrière le proxy de l'instance : c'est un choix d'instance, pas fait
ici.

Le port de l'île en direct sert aussi les commandes du monde (`/join`,
`/input`). L'onglet ne lie que le spectateur ; l'exposition de ce port sur le
réseau maison reste celle du prototype.

**Vue 3D interchangeable.** L'onglet ne connaît que trois choses par partie :
ce qu'on peut montrer, le lien en direct et le lien de relecture. Elles
viennent d'un « rendu » (`benchmark/src/services/island/islandViews.js`) ;
il y en a deux :

- **Clawblox** : ses propres pages (spectateur en direct, relecture de
  `clawblox app`).
- **GraphysX** : la page `?app=island` de GraphysX-Web (ciel, eau, ombres,
  panneau Messages, barre de lecture), qui dessine l'état que Clawblox diffuse
  sur `/spectate/ws`. Clawblox reste maître de la physique, du monde et des
  enregistrements : seule la page change. En direct, la source est le port
  du monde et le jeton spectateur passe dans le fragment
  (`#spectator_token=…`), jamais dans la query string ; en relecture, la
  source est la session ouverte par `clawblox app`
  (`<AGENTX_ISLAND_REPLAY_URL>/sessions/<id>`). `embed=1` compacte l'en-tête
  pour l'onglet.

Comme pour Clawblox, une page GraphysX servie en HTTP s'ouvre dans un nouvel
onglet depuis un Benchmark en HTTPS. La page publique de GraphysX (HTTPS) ne
peut pas lire un `ws://` du réseau maison : il faut une version servie sur le
réseau local, ou un relais HTTPS de même origine.

## Conception (pas encore construite) : classer « a joué » contre « neuf »

L'article mesure si le jeu libre rend l'agent meilleur sur quatre épreuves
de l'île. On les ajouterait au classement existant de Benchmark, sans
deuxième classement.

**Les quatre épreuves.** Chacune est une partie courte (10 à 15 min) sur
l'île, avec une consigne écrite au lieu de « tu n'as pas de tâche », et un
score lu dans l'état du monde à la fin, sans juge :

| Épreuve | Consigne | Score (0 à 10) |
|---|---|---|
| `many-5-towers` | faire le plus de tours de 5 blocs | nombre de tours de 5 blocs debout, plafonné |
| `objects-on-spire` | poser le plus d'objets sur la Spire | objets au sommet de la Spire à la fin |
| `tallest-tower` | construire la tour la plus haute | hauteur du plus haut empilement stable |
| `throw-on-spire` | lancer des objets pour qu'ils restent sur la Spire | objets lancés restés sur la Spire |

Les plafonds sont fixés après une première série de référence, puis figés
dans la version de l'épreuve. Le monde `mesa-island` a déjà la Spire et
l'action de lancer ; la consigne et la lecture du score restent à écrire.

**Les bras comparés.** Même harnais (Codex), même alias `agentx-primary`,
même île ; seule la mémoire change :

- **Eko neuf** : espace de travail des modèles (`memory: fresh`) ;
- **Eko a joué N h** : copie gelée de la mémoire d'Eko après N heures de jeu
  libre (par exemple 3 h, 10 h). L'épreuve part de cette copie et ne la
  modifie pas.

**Dans le classement.** Chaque bras est une ligne d'agent, comme les agents
natifs le sont déjà (« un agent est sa propre entrée ») :
`harness:island:<agent>:<mémoire>` comme hôte, étiquetée avec la quantité de
jeu et l'empreinte de la mémoire gelée. Une nouvelle catégorie `island`
regroupe les quatre épreuves ; la ligne d'Eko neuf sert de bras témoin.
L'écart « a joué − neuf » par épreuve, avec l'intervalle sur au moins trois
répétitions, est le résultat de l'expérience.

**Ce qu'il faudrait construire.** Un mode `task` dans `island_runner.py`
(consigne et lecture du score par le script Lua du monde), un champ
`task`/`memorySnapshot` dans l'exécuteur `island`, des résultats écrits dans
`BenchmarkResult` avec le reçu de la partie, et la catégorie `island` dans
la liste partagée. Chaque épreuve est du travail lourd : elle passe par la
file comme une partie.

## Limites connues

- Core ne voit pas l'hôte d'exécution : la fin est une attestation de
  l'opérateur, et une partie « en cours » ne se règle qu'avec
  `island-settle` (ou `recover` après vérification).
- Le trafic de l'agent passe par un client de passerelle existant de l'hôte
  d'exécution ; un client dédié demanderait une modification de
  `AGENTX_LLM_GATEWAY_CLIENTS` et un redémarrage de Core.
- La limite de sortie par défaut de Core (`AGENTX_DEFAULT_MAX_OUTPUT_TOKENS`)
  coupe parfois une réponse ; la relance la contourne.
- Pas de remise à zéro horaire du contexte comme dans l'article ; à ajouter
  pour les longues parties.
- Les étiquettes de comportement (bouton **Behaviours** de la relecture)
  demandent un modèle qui relit les parties : travail lourd, pas encore fait.
- La vue 3D est celle de Clawblox. Une vue GraphysX-Web se brancherait comme
  second rendu ; elle attend la décision sur le placement de GraphysX.
- Remplacer Codex par un autre harnais (DSH, OpenCode) reste une décision du
  propriétaire.
