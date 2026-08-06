# Roadmap — Vassi Stream

## But

Créer un device Max for Live placé sur la piste master d’Ableton Live. Un clic lance un live stéréo sur la page `/session` du site. La page publique fournit un statut et un bouton Play/Pause.

Le système doit fonctionner sans application compagnon, sans abonnement supplémentaire et sans modifier le son du master dans Ableton.

## Périmètre fixé

- Un device Max for Live Audio Effect `.amxd`.
- Un seul publisher : le device de Vassi.
- Plusieurs listeners publics, peu nombreux.
- Codec Opus stéréo uniquement.
- Profil par défaut : **Studio, Opus 256 kbit/s**.
- Trois profils qualité : Stable 128, Haute 192, Studio 256 kbit/s.
- Trois profils de latence : Faible 200 ms, Équilibrée 400 ms, Stable 800 ms.
- Relais Node.js sur le VPS Sliplane existant.
- Page Svelte 5 `/session` sur `vassi.click`.

Hors périmètre de cette version : PCM, WebRTC, MSE, WebM, Ogg, OBS, historique, enregistrement, chat, talkback, plusieurs publishers et changement de profil pendant un live.

Les chemins `/publisher` et `/listener` du relais nomment les deux prises du système, pas des pages : Ableton se branche sur la première, la page publique sur la seconde. L'adresse que le professeur ouvre est la page `/session` du site ; elle sera présentée comme `live.vassi.click/session` une fois la règle de routage posée, ce que la v1 ne fait pas encore. Des directs nommés, par exemple un pour les cours et un pour un concert, s'obtiendraient plus tard en ajoutant un segment à ces chemins — `wss://live.vassi.click/listener/concert` — sans rien renommer. Cette extension demande plusieurs sessions simultanées dans le relais, ce que la v1 ne fait pas.

## Architecture cible

```text
Ableton Master
    │
    ▼
Device Max for Live
    ├── plugin~ ───────────────────────────────► plugout~
    │     Le chemin audible reste direct.
    │
    ├── vassi.encoder~
    │     Objet MSP natif inclus dans le device.
    │     Capture passive → queue bornée → 48 kHz → Opus 20 ms.
    │
    └── node.script
          Paquets Opus → WSS → statut Max.
                         │
                         ▼
Relais Node.js Sliplane
    Publisher authentifié → broadcast brut → listeners publics
                         │
                         ▼
Page Svelte /session
    WebSocket → Worker Opus/WASM → AudioWorklet → navigateur
```

`vassi.encoder~` est un objet natif chargé par Max, pas une application externe. `node.script` est démarré automatiquement par le device : Vassi n’a rien à ouvrir à côté d’Ableton.

## Principes techniques à respecter

- Le callback audio MSP copie seulement les données dans une queue préallouée. Il ne fait ni réseau, ni encodage, ni attente, ni allocation.
- Un worker de l’objet natif rééchantillonne vers 48 kHz et encode les frames Opus hors du thread audio.
- Une frame contient 960 échantillons par canal, soit 20 ms à 48 kHz.
- Le relais ne décode, ne réencode, ne remuxe et ne stocke jamais l’audio.
- Une queue pleine abandonne l’audio le plus ancien afin de rester en direct ; elle ne doit jamais grandir sans limite.
- La page ne lit pas les paquets avec `MediaSource`. Elle les décode dans un Worker puis les joue avec AudioWorklet.
- Aucun token de publication ne doit être commité, affiché au navigateur ou écrit dans les logs.
- Les fichiers de code restent courts, simples, commentés au présent et découpés par responsabilité.

## Contrat de protocole v1

La spécification complète est créée pendant le bloc 1 dans `docs/protocol-v1.md`. Les règles suivantes sont déjà figées.

### Connexions

- Publisher : `wss://<domaine-relai>/publisher`.
- Listener : `wss://<domaine-relai>/listener`.
- Le publisher envoie un message JSON `publisher_auth` avec son token après ouverture de la connexion.
- Après acceptation, il envoie `stream_start`, puis les paquets binaires.
- À l’arrêt, il envoie `stream_stop`.
- Le serveur envoie immédiatement l’état courant à chaque listener.
- Le serveur envoie un ping WebSocket toutes les 20 secondes.

### Messages JSON essentiels

Tous contiennent `type` et `protocolVersion: 1`.

- `publisher_auth` : token de publication.
- `stream_start` : `sessionId`, codec, bitrate, sample rate, canaux, durée de frame, profil de latence.
- `stream_stop` : `sessionId` et raison simple.
- `stream_state` : indique `live: true` ou `live: false` aux listeners.
- `auth_ok`, `auth_error`, `server_error` : réponses explicites.

### Paquet audio binaire

Les entiers sont big-endian.

| Offset | Taille | Champ |
|---:|---:|---|
| 0 | 4 | magic ASCII `VSA1` |
| 4 | 1 | version `1` |
| 5 | 1 | codec Opus `1` |
| 6 | 1 | flags, bit 0 = discontinuité |
| 7 | 1 | canaux `2` |
| 8 | 4 | `sessionId` |
| 12 | 4 | `sequenceNumber` |
| 16 | 8 | timestamp relatif en microsecondes |
| 24 | 2 | nombre d’échantillons : `960` |
| 26 | 2 | taille du payload |
| 28 | N | paquet Opus brut |

Le serveur valide la taille, le magic et la version puis diffuse les octets sans les modifier.

## Règle de validation allégée

Chaque bloc est terminé lorsque :

- son résultat est utilisable ;
- sa courte vérification fonctionne ;
- le bloc précédent continue de fonctionner.

Une note courte dans `docs/validation/` est utile mais non obligatoire. Les longues sessions, tests de charge et mesures précises sont réservés au bloc final, seulement si un problème réel apparaît.

---

# Blocs d’implémentation

## Bloc 0 — Préparer l’environnement

**But :** connaître les versions et la cible réelle avant de développer.

### À faire

- [x] Relever les versions de Windows, Ableton Live, Max et Node for Max.
- [x] Confirmer que la première cible est Windows x64.
- [x] Relever les sample rates utilisés dans les projets Ableton de Vassi.
- [x] Choisir le navigateur utilisé par Vassi et celui du professeur pour le premier test.
- [x] Préparer un court fichier audio stéréo de test.
- [x] Noter l’URL publique du site cible : `https://www.vassi.click`.
- [x] Tester WSS sur l’URL exacte du relais quand le relais existe. Fait le 2026-08-05 : `npm.cmd run relay:check -- https://live.vassi.click` passe ses trois contrôles — route de santé, connexion listener réelle, et refus d’un publisher sans token valide (fermeture avec le code 1008).

### Vérification courte

- [x] Les versions, les deux navigateurs et les sample rates sont notés.
- [x] Le fichier de test est lisible dans Ableton.

### Terminé

- [x] **Bloc 0 validé.**

## Bloc 1 — Spécifier et tester le protocole

**Dépendances :** bloc 0.

**But :** éviter que Max, le serveur et le navigateur inventent chacun un format différent.

### À faire

- [x] Créer `docs/protocol-v1.md` à partir du contrat ci-dessus.
- [x] Écrire les exemples JSON de démarrage, arrêt et état hors ligne.
- [x] Écrire un petit module TypeScript qui encode et lit l’en-tête binaire.
- [x] Créer quelques paquets de test : valide, tronqué et mauvaise version.
- [x] Définir clairement la création d’une nouvelle session après reconnexion.

### Vérification courte

- [x] Un paquet encodé est relu avec les mêmes champs et les mêmes octets.
- [x] Un paquet tronqué est refusé sans faire planter le programme.

### Terminé

- [x] **Bloc 1 validé.**

## Bloc 2 — Créer l’objet MSP de capture passive

**Dépendances :** blocs 0 et 1.

**But :** recevoir le master dans un objet natif sans toucher au son qui sort d’Ableton.

### À faire

- [x] Rechercher brièvement Max SDK et Min-DevKit pour la version de Max cible, puis choisir l’un des deux.
- [x] Créer l’objet `vassi.encoder~` avec deux entrées signal.
- [x] Implémenter `dsp64` et une routine audio minimale.
- [x] Créer un patch test : `plugin~` va directement vers `plugout~` et est aussi connecté à `vassi.encoder~`.
- [x] Faire remonter un compteur de blocs reçu seulement pour le diagnostic.
- [x] Vérifier qu’aucune allocation, aucun log et aucun appel réseau ne se trouvent dans la routine audio.

### Vérification courte

- [x] L’objet se charge dans Max et dans Ableton sans erreur.
- [x] Le compteur indique que les deux canaux sont reçus.
- [x] Activer ou désactiver l’objet ne change pas le son du master.

### Terminé

- [x] **Bloc 2 validé.**

## Bloc 3 — Ajouter la queue audio et le worker

**Dépendances :** bloc 2.

**But :** déplacer tout le travail coûteux hors du callback audio.

### À faire

- [x] Créer une queue SPSC préallouée pour les deux canaux.
- [x] Définir une taille fixe de queue en millisecondes.
- [x] Copier les samples reçus vers cette queue dans la routine audio.
- [x] Créer un worker qui lit la queue et peut être démarré ou arrêté proprement.
- [x] Lorsqu’elle est pleine, supprimer les données les plus anciennes et compter l’événement.
- [x] Exposer des diagnostics simples : taille de queue et nombre d’overflows.

### Vérification courte

- [x] Un motif gauche/droite connu ressort dans le bon ordre du worker.
- [x] La queue ne dépasse pas sa capacité.
- [x] Démarrer puis arrêter le device ne provoque pas de crash.

### Terminé

- [x] **Bloc 3 validé.**

## Bloc 4 — Rééchantillonner et encoder en Opus

**Dépendances :** bloc 3.

**But :** produire des paquets Opus stéréo lisibles par le navigateur.

### À faire

- [x] Intégrer un resampler libre validé, par exemple SpeexDSP.
- [x] Intégrer libopus dans l’objet natif.
- [x] Gérer au minimum 44,1 et 48 kHz en entrée
- [x] Convertir le flux en 48 kHz stéréo dans le worker.
- [x] Accumuler 960 samples par canal puis encoder une frame Opus de 20 ms.
- [x] Utiliser `OPUS_APPLICATION_AUDIO`.
- [x] Appliquer les profils 128, 192 et 256 kbit/s.
- [x] Définir Studio 256 kbit/s comme défaut.
- [x] Réinitialiser l’encodeur et la séquence à chaque nouveau live.
- [x] Après une perte audio locale, réinitialiser l’encodeur avant la frame suivante et poser le flag de discontinuité sans changer de session.

### Vérification courte

- [x] Les paquets produits sont décodables par libopus.
- [x] Un test gauche seul et droite seule reste correctement stéréo après décodage.
- [x] Une écoute de quelques minutes en Studio ne produit pas de coupure Ableton.
- [x] Vassi confirme que Studio est assez transparent pour son usage.

### Terminé

- [x] **Bloc 4 validé.**

## Bloc 5 — Relier l’encodeur à Node for Max

**Dépendances :** bloc 4.

**But :** remettre les paquets Opus à Node sans lui transmettre de PCM.

**Décision de transport.** Le pont par messages Max est écarté avant implémentation. Le canal Max vers Node
sérialise chaque message en JSON, et Cycling ‘74 a confirmé une croissance mémoire sans limite proportionnelle
à ce trafic. La solution unique retenue est un socket TCP loopback : Node écoute sur `127.0.0.1`, annonce son
port, et l’objet natif s’y connecte. UDP est écarté à cause de ses pertes silencieuses, de son absence d’état
de connexion et du piège Windows `WSAECONNRESET`. Le détail est dans `docs/bridge-vsf1.md`.

### À faire

- [x] Choisir un seul mécanisme de transport et écrire la décision dans `docs/bridge-vsf1.md`.
- [x] Définir le format de frame interne `VSF1` : séquence, timestamp, flags et octets Opus.
- [x] Envoyer les frames depuis le worker par socket loopback, jamais depuis la routine audio.
- [x] Faire recevoir les octets directement en `Buffer` dans `node.script`, sans base64 ni liste Max.
- [x] Borner l’audio en attente entre l’objet et Node, et marquer la frame suivante après une perte.
- [x] Faire remonter les états simples `ready`, `error` et `stopped`.

### Vérification courte

- [x] Node reçoit les mêmes octets que ceux produits par l’encodeur.
- [x] Cinq minutes de lecture à 50 paquets par seconde restent stables : 15000 frames reçues sur 15000, zéro trou de séquence, 50,0 frames/s mesurées (`node scripts/measure-bridge.js 15000 20`).
- [x] Une seule solution est conservée : le socket TCP loopback, le pont par messages Max n’existe pas dans le code.
- [x] Déposer `Vassi Stream - Test pont` sur le Master dans Ableton et confirmer que `node.script` démarre, annonce son port et fait passer l’encodeur en `connected`. Validé par Vassi le 2026-08-03 : `connected`, `ready`, port annoncé, `Encodées`, `Envoyées` et `Recues` en hausse ensemble, `Perdues` et `Trous` à zéro, son du master inchangé.
- [x] Corriger le compteur par canal : il mesure maintenant les blocs qui portent réellement du son au lieu d’un drapeau de câblage que `reset` effaçait. Le champ s’appelle `Signal L/R`.

### Terminé

- [x] **Bloc 5 validé.**

## Bloc 6 — Créer le publisher Node interne

**Dépendances :** blocs 1 et 5.

**But :** ouvrir la connexion WSS, envoyer le protocole et signaler clairement l’état au device.

La conception complète est dans `docs/publisher-node.md`.

### À faire

- [x] Créer les modules simples : configuration, protocole, WebSocket, reconnexion et adaptateur Max API.
- [x] Utiliser `max-api` et `ws` avec versions verrouillées. `ws@8.21.1` est épinglé exactement des deux côtés ; `max-api` reste fourni par Node for Max via `NODE_PATH`, il n’existe pas sur npm sous une forme utilisable hors de Max.
- [x] Lire URL et token depuis une configuration persistante non commité : `%APPDATA%\Vassi Stream\publisher.json`, écrit par `npm.cmd run config:publisher`. Le token est débarrassé de ses espaces de début et de fin : un token collé depuis un gestionnaire de mots de passe en emporte souvent un.
- [x] Implémenter les états `STOPPED`, `CONNECTING`, `LIVE`, `RECONNECTING` et `ERROR`.
- [x] Authentifier le publisher avant de démarrer l’encodeur.
- [x] Envoyer `stream_start` avant la première frame audio.
- [x] Construire l’en-tête binaire v1 sans modifier le payload Opus.
- [x] À la perte de connexion : arrêter l’encodeur, appliquer le backoff `1, 2, 4, 8, 16, 30 s` avec jitter puis créer une nouvelle session après reconnexion.
- [x] Ne jamais laisser `bufferedAmount` accumuler de l’audio ancien : au-delà de 8192 octets, soit environ 250 ms en Studio, la frame est abandonnée et la suivante porte le bit de discontinuité.

### Vérification courte

- [x] Un faux serveur accepte le token puis reçoit `stream_start` et une frame valide.
- [x] Un mauvais token donne une erreur lisible sans exposer le token.
- [x] Une coupure du faux serveur déclenche une reconnexion et un nouveau `sessionId`.

### Terminé

- [x] **Bloc 6 validé.** `npm.cmd run check` : 99 tests, 0 échec. Détail dans `docs/validation/phase-6.md`.

## Bloc 7 — Créer le relais Sliplane

**Dépendances :** blocs 1 et 6.

**But :** diffuser des paquets audio opaques du publisher vers les listeners.

La conception complète est dans `docs/relay-node.md`.

**Décision sur le publisher unique.** La règle « un seul publisher à la fois » est conservée, mais le
nouveau venu authentifié remplace le précédent au lieu d’être refusé. Refuser aurait créé un blocage
réel : une connexion morte que le relais n’a pas encore détectée, après une coupure Wi-Fi par
exemple, garderait la place pendant environ une minute et empêcherait le device reconnecté de
reprendre le live. Le token reste nécessaire pour prendre la place.

### À faire

- [x] Créer les endpoints WebSocket publisher et listener.
- [x] Stocker le token publisher dans une variable d’environnement Sliplane. Le relais refuse de démarrer sans token d’au moins 32 caractères ; `npm.cmd run token:new` en produit un.
- [x] Refuser les frames avant authentification et `stream_start`.
- [x] N’accepter qu’un publisher à la fois : le dernier authentifié prend la place, les connexions sans token sont limitées à quatre et fermées après cinq secondes.
- [x] Garder seulement la configuration de session, jamais l’historique audio.
- [x] Envoyer l’état actuel à chaque nouveau listener, avant tout paquet audio.
- [x] Diffuser les frames valides sans transformation.
- [x] Fermer les listeners très lents plutôt que créer un backlog infini : abandon des paquets au-delà de la tolérance du profil de latence de l'auditeur (cible + 1000 ms, comme le player avant de tout jeter), fermeture au-delà de 8000 ms de retard — un temps, pas un nombre d'octets (voir `docs/validation/incident-meet-2026-08-06.md`, section 4).
- [x] Envoyer `live: false` quand le publisher disparaît, avec ou sans `stream_stop`.
- [x] Ajouter une route `/health` et quelques compteurs simples : état live, listeners, dernier paquet reçu. Les compteurs avancent pendant le direct et pas seulement à la fermeture d'une connexion, parce que la santé se consulte pendant la panne. `listenerFramesDropped` distingue un son troué venu de la connexion de l'auditeur d'un son troué venu d'avant le relais.
- [x] Faire porter la limite d'auditeurs par la liste elle-même, en plus du refus HTTP 503 prononcé avant l'ouverture de la connexion.

### Vérification courte

- [x] Le bon token est accepté et le mauvais refusé.
- [x] Un listener avant le live voit l’état hors ligne.
- [x] Deux listeners pendant le live reçoivent les mêmes paquets dans le même ordre.
- [x] Arrêter le publisher remet les listeners hors ligne.
- [x] Déployer le relais sur Sliplane, choisir le domaine et vérifier une connexion `wss://` réelle. Fait le 2026-08-05 sur `live.vassi.click` : `npm.cmd run relay:check -- https://live.vassi.click` passe ses trois contrôles.

### Terminé

- [x] **Bloc 7 validé.** `npm.cmd run check` : 207 tests, 0 échec après les corrections de revue. Le relais est déployé et vérifié sur `live.vassi.click` le 2026-08-05. Détail dans `docs/validation/phase-7.md`.

## Bloc 8 — Créer le moteur audio navigateur

**Dépendances :** blocs 1 et 7.

**But :** décoder le flux Opus et le jouer de façon continue dans le navigateur.

La conception complète est dans `docs/player-web.md`.

**Décision sur le fichier de l'AudioWorklet.** Un module chargé par `audioWorklet.addModule()` ne peut
pas utiliser d'`import` sous Safari, et le professeur est sur macOS. `src/player/pcm-worklet.js` ne
contient donc aucun `import`. La file PCM y est définie et exportée : le worker de décodage et les
tests importent ce même fichier, donc la file n'existe qu'en un seul exemplaire.

### À faire

- [x] Choisir une bibliothèque Opus/WASM libre et maintenue, puis verrouiller sa version. `opus-decoder@0.7.11`, licence MIT, épinglé exactement. C'est la seule bibliothèque répandue qui décode des frames Opus **brutes** ; les autres attendent un conteneur Ogg que le protocole n'utilise pas.
- [x] Héberger localement le JavaScript et le WASM utilisés par le player. Le WebAssembly est inclus dans le JavaScript du paquet : rien n'est téléchargé depuis un CDN et rien n'est à copier à la main.
- [x] Créer un client WebSocket listener qui sépare les messages JSON et binaires.
- [x] Valider l’en-tête d’une frame avant de l’envoyer au décodeur. La validation vient de `src/protocol/audio-packet.ts`, le module déjà partagé par le device et le relais.
- [x] Décoder dans un Worker, jamais dans le thread UI.
- [x] Créer une queue PCM stéréo bornée entre Worker et AudioWorklet.
- [x] Utiliser `SharedArrayBuffer` et `Atomics` si les en-têtes COOP/COEP sont disponibles. Sans eux, les blocs sont transférés par un `MessagePort` : la file, la lecture et le silence sont identiques dans les deux modes.
- [x] Créer un AudioWorklet qui consomme la queue et produit du silence lors d’un manque de données.
- [x] Implémenter les états `OFFLINE`, `READY`, `BUFFERING`, `PLAYING`, `REBUFFERING`, `PAUSED` et `ERROR`.
- [x] Respecter les seuils de latence transmis par la session.
- [x] Vider le décodeur et le buffer lors d’une nouvelle session.
- [x] Lors d’un flag de discontinuité, vider le PCM, réinitialiser le décodeur, décoder la frame marquée puis rebufferiser sans rejouer la durée abandonnée. Un trou dans les numéros de séquence reçoit le même traitement : le relais ne modifie jamais un paquet, donc il ne peut pas poser le bit lui-même quand il abandonne les paquets d'un auditeur en retard.

### Vérification courte

Ces quatre points demandent une oreille et un navigateur : `npm.cmd run player:fixture` sert la page de
test et rejoue la fixture Opus produite par l'encodeur réel du device à travers un vrai relais local.

- [x] Une fixture Opus est entendue en stéréo dans le navigateur choisi. Le décodage lui-même est déjà vérifié sous Node : la fixture ressort à 440 Hz à gauche et 880 Hz à droite, mesuré sur les échantillons décodés.
- [x] Play attend le buffer puis lance le son.
- [x] Pause arrête le son et reprise repart du direct.
- [x] Une coupure simulée produit un rebuffer, pas un crash. Le bouton de la page coupe le publisher pendant trois secondes.

### Terminé

- [x] **Bloc 8 validé.** Le code est écrit et testé : `npm.cmd run check` donne 207 tests, 0 échec, dont le décodage d'une vraie fixture Opus jusqu'aux échantillons et le socket listener branché sur le vrai relais. Reste l'écoute dans Firefox et dans Safari, à faire avec Vassi : `npm.cmd run player:fixture`. Détail dans `docs/validation/phase-8.md`.

## Bloc 8b — Durcir la robustesse du moteur audio navigateur

**Dépendances :** bloc 8.

**But :** valider le moteur audio dans des conditions proches du vrai usage et corriger les failles de robustesse avant de brancher la page publique.

La conception complète est dans `docs/player-web.md`, sections « Dérive de retard », « Panne et
seconde chance » et « Diagnostics ».

**Décision sur l'outil de vérification.** Le premier essai de la page dans Firefox a trouvé trois
défauts, tous dans l'outil de test et aucun dans le moteur : le serveur s'arrêtait sur une adresse
inconnue, le publisher de fixture envoyait 32 paquets par seconde au lieu de 50, et une coupure
simulée lançait deux reconnexions concurrentes. Les trois donnaient au moteur l'apparence d'une
panne. L'outil de test est donc tenu au même niveau d'exigence que le reste du code : corrigé,
mesuré et couvert par des tests. Le détail et les mesures sont dans `docs/validation/phase-8b.md`.

### À faire

- [x] Vérifier le lancement et la reprise sur Firefox, y compris le premier clic, le buffer initial et la reprise après coupure. Les trois passages.
- [x] Faire un essai de 15 à 30 minutes avec plusieurs pauses, reprises et reconnexions réseau courtes. Détail dans `docs/validation/phase-8b.md`.
- [x] Tester le mode sans `SharedArrayBuffer` sous charge réelle et mesurer la stabilité du transport par `MessagePort`. La mesure existe : le compteur « Blocs abandonnés » monte quand un port ne suit plus et reste à zéro en mémoire partagée. Fait le 2026-08-05 : essai Google Meet à deux caméras avec partage d'écran (9 min 23 s, gels du thread principal jusqu'à 8,8 s) et essai écran fermé (8 min 30 s, un gel de 8 min) en mode messages — « Blocs abandonnés » reste à zéro dans les deux.
- [x] Corriger l'outil de vérification : arrêt du serveur sur une adresse inconnue, débit du publisher de fixture, double reconnexion après une coupure demandée.
- [x] Ajouter des diagnostics utiles côté moteur : paquets reçus, underruns, dernière erreur, dernière session et état du worker/worklet. `diagnostics()` rend les compteurs, `explainPlayer()` les range entre réseau, décodage et contexte audio.
- [x] Durcir les transitions critiques : arrêt pendant le chargement, fermeture pendant une reconnexion, contexte audio suspendu, worker en erreur.
- [x] Rattraper la dérive de retard. Un contexte audio arrêté par le système laisse le décodeur remplir la file, et la lecture reprend alors définitivement en retard. Au-delà du seuil du profil plus une seconde, le son en attente est jeté et la lecture repart du direct.
- [x] Laisser une seconde chance après une panne : un nouveau clic sur Play démonte tout et rebâtit, au lieu de bloquer la page jusqu'au rechargement.
- [x] Vérifier que les cas de panne n’endommagent ni la session ni la file PCM, et que le direct reprend proprement après récupération.

### Vérification courte

- [x] Le son sort correctement dans Firefox et Safari sans crash ni état bloqué.
- [x] Une coupure courte puis un retour du relais provoquent un rebuffer, puis une reprise propre.
- [x] Le mode sans `SharedArrayBuffer` reste utilisable et ne produit pas de boucle ni de blocage.
- [x] Les diagnostics affichés permettent de distinguer un problème réseau, un problème de décodage et un problème de contexte audio.

### Terminé

- [x] **Bloc 8b validé.** Le code est écrit et testé : `npm.cmd run check` donne 312 tests, 0 échec. Le mode messages est vérifié sous charge réelle le 2026-08-05. Détail dans `docs/validation/phase-8b.md`.

**Correction du 2026-08-05, après revue.** Trois points repris sans rouvrir le bloc, `npm.cmd test`
donnant 331 tests et 0 échec :

- La hauteur du filet du processeur audio ne se lisait pas dans le code. La formule demandait
  `cible + 2000 ms`, le plafond des deux tiers de la file ramenait les trois profils à 2000 ms, et
  personne ne pouvait deviner que la marge réelle de Stable valait 200 ms et non 1000. La borne est
  maintenant nommée (`NET_CEILING_MAX_MS`) et appliquée là où le plafond se calcule ; le tableau des
  valeurs réelles est dans le code, dans `docs/validation/phase-8b.md`, et fixé par un test.
- Le message `limit` n'était vérifié nulle part — c'est là que vivait le défaut ci-dessus. Six tests
  l'entourent désormais : les trois profils, le suivi d'une nouvelle session, et le filet lui-même
  dans `process()`, qui n'était couvert que par sa file.
- Un défaut trouvé par ces tests : un direct relancé sur un autre profil pendant que la page
  bufferise déjà ne renvoyait aucune borne au processeur audio. La machine d'états ne prévient que
  lorsque son état change de nom, et `BUFFERING` vers `BUFFERING` n'en est pas un. La hauteur de saut
  restait celle du direct précédent. Corrigé dans `audio-player.ts`.

## Bloc 9 — Créer la page Svelte `/session`

**Dépendances :** bloc 8 et bloc 8b.

**But :** rendre le player utilisable publiquement avec une interface minimale.

**Décision sur l'adresse (2026-08-05).** La page est servie par le site `vassi.click`, à la route
`/session`. Le nom `/suivi-live` est abandonné. L'adresse finalement montrée au professeur,
`live.vassi.click/session`, demande une règle de routage encore à poser : `live.vassi.click` pointe
aujourd'hui sur le relais Sliplane, pas sur le site. Cette règle ne change aucune ligne de la page —
la route s'appelle déjà `/session` — mais elle reste à faire, et tant qu'elle n'existe pas la page
s'ouvre à `www.vassi.click/session`.

**Décision sur le partage du code (2026-08-05).** Le moteur audio vit dans ce dépôt et le site en
garde une copie automatique dans `frontend/src/lib/vassi-stream/`, produite par
`npm.cmd run player:sync` et surveillée par `npm.cmd run player:check`, qui fait partie de
`npm.cmd run check`. Le site se construit depuis son seul dossier `frontend/`, donc le moteur doit
s'y trouver physiquement. Un sous-module git a été écarté parce que Sliplane clone le dépôt sans
initialiser les sous-modules : le site aurait cessé de se construire. Un paquet npm a été écarté
parce qu'il faudrait publier une version à chaque correction du moteur, c'est-à-dire pendant les
blocs 10 et 11. Le détail complet est dans `docs/pont-site-web.md`.

**Décision sur COOP/COEP.** Les en-têtes ne sont pas posés. Ils casseraient les scripts umami et les
images venues de `api.vassi.click` sur tout le site, et le mode sans `SharedArrayBuffer` est déjà
validé sous charge réelle au bloc 8b. La ligne « si `SharedArrayBuffer` est utilisé » se lit donc :
il ne l'est pas, donc pas d'en-têtes.

### À faire

- [x] Ajouter la route `/session` au site Svelte existant.
- [x] Isoler le moteur audio des composants visuels. `utils/directState.svelte.ts` est le seul
      fichier qui parle au moteur ; les composants ne reçoivent que du texte et un rappel.
- [x] Afficher les états : Hors ligne, Prêt, Chargement, Lecture, Reconnexion et Erreur. En pause
      s'y ajoute, sans quoi un clic sur Pause ne changerait rien à l'écran.
- [x] Ajouter un bouton Play/Pause accessible. Un vrai `<button>`, et l'état dans une région
      `aria-live="polite"`.
- [x] Créer AudioContext seulement après une action utilisateur. `connecter()` n'ouvre que le
      WebSocket ; le contexte audio naît dans `basculer()`, appelé par le clic.
- [x] ~~Ajouter les en-têtes COOP/COEP si `SharedArrayBuffer` est utilisé~~ — sans objet, voir la
      décision ci-dessus.
- [x] Ne pas afficher de détail serveur ou de secret.

### Vérification courte

- [x] Le bundle navigateur ne contient aucun token publisher. Vérifié sur le build réel : la seule
      adresse présente est `wss://live.vassi.click/listener`, et le mot `publisher` n'apparaît dans
      aucun fichier livré au navigateur.
- [ ] Sans publisher, la page affiche Hors ligne.
- [ ] Avec publisher, elle affiche Prêt puis Lecture après clic sur Play.
- [ ] Le bouton Pause coupe réellement le son.

Les trois derniers points demandent un navigateur et le device en marche. Le relais déployé est en
revanche vérifié : `npm.cmd run relay:check -- https://live.vassi.click` passe ses trois contrôles.

### Terminé

- [ ] **Bloc 9 validé.** Le code est écrit et vérifié : `npm.cmd run check` donne 321 tests, 0 échec,
      et le site donne `svelte-check` à 0 erreur puis un `npm run build` qui passe. Reste l'écoute
      réelle dans un navigateur, à faire avec Vassi. Détail dans `docs/validation/phase-9.md`.

**Correction du 2026-08-05, après revue.** Le champ `commit` du manifeste enregistrait le commit
**parent** de la copie, et personne ne pouvait le voir : `player:sync` tourne avant le commit qui
contient la copie, donc il lit le `HEAD` précédent, et le manifeste n'était réécrit que si les
empreintes changeaient — resynchroniser après coup ne corrigeait donc rien. Deux changements ferment
le piège : le manifeste porte `<commit>+modifie` quand le moteur n'est pas commité, et il est réécrit
quand ce seul champ change, en gardant sa date de copie. `player:check` le signale sans échouer.
L'ordre des trois gestes est écrit dans `docs/pont-site-web.md`.

## Bloc 10 — Finaliser l’interface Max for Live

**Dépendances :** blocs 5, 6 et 9.

**But :** rendre tout le système utilisable depuis le seul device Ableton.

La conception complète est dans `docs/device-max.md`.

**Décision sur la construction du patcher.** Le device compte 64 objets et 77 câbles, soit plusieurs
milliers de lignes de JSON que personne ne relirait. Il est donc décrit par du code, dans
`scripts/device-patcher/`, et écrit par `npm.cmd run device:build`. Une fois le device ouvert dans
Max, c'est le `.maxpat` qui fait foi : Vassi peut y déplacer les objets et enregistrer. Les tests
portent sur le fichier livré, pas sur le générateur, donc ils restent valables après une retouche
faite dans Max — c'est le moment où ils servent le plus.

**Décision sur le thème (2026-08-04, révisée).** La première version suivait le thème d'Ableton par
une règle négative : aucune couleur n'était écrite nulle part. Vassi a demandé une repasse visuelle
pour que le device se rapproche de Wavetable — fond presque noir, onglets et menus dans le style
LCD des devices Ableton — et a explicitement autorisé les couleurs en dur pour cet objectif après
avoir vu le choix posé entre deux options : un thème dynamique avec un simple écran LCD sombre sur
la bande d'affichage, ou un fond presque noir fixé partout comme Wavetable. Vassi a choisi la
seconde option.

Cela suppose un rappel important : **Wavetable n'est pas un device Max for Live**. C'est un device
natif d'Ableton, dans son propre moteur graphique, qui reste sombre en permanence quel que soit le
thème choisi dans les préférences de Live. Un device Max for Live ne peut suivre qu'un thème à la
fois — celui de Live, ou un thème qui lui est propre — et ne reproduira jamais Wavetable au pixel
près. Six couleurs sont donc maintenant écrites en dur, toutes regroupées dans `PALETTE`
(`scripts/device-patcher/parts.js`) et sourcées dans le thème Sombre réel d'Ableton
(`Resources/Themes/03Dark.ask`), jamais choisies à l'œil. Le détail complet, avec le tableau des
couleurs et leurs clés d'origine, est dans `docs/device-max.md`.

Le comportement standard des objets `live.*` recommandé par Ableton (`livemode` sur `live.tab`,
`outputmode` Mouse Up sur `live.text`) reste suivi à la lettre : seule la couleur change de
politique, pas le reste des [Max for Live Production
Guidelines](https://github.com/Ableton/maxdevtools/blob/main/m4l-production-guidelines/m4l-production-guidelines.md).

### À faire

- [x] Créer le device final avec `plugin~ -> plugout~` direct et `vassi.encoder~` en branche de capture.
- [x] Démarrer `node.script` automatiquement à l’ouverture du device, sans démarrer le live. `live.thisdevice` attend le chargement complet, puis 1,5 s, puis demande le port et l'état de la configuration. Rien ne se connecte au relais.
- [x] Ajouter un bouton Lancer/Arrêter. Un `live.text` en mode interrupteur, dessiné en style LCD : c'est la commande principale du device, elle mérite la surface d'un bouton plutôt qu'une case à cocher.
- [x] Basculer entre la page du direct et la page des réglages par des onglets `live.tab`. La première version employait un bouton unique qui changeait de texte ; sans paramètre attaché, il n'avait aucune valeur où retenir sa position, renvoyait le même 1 à chaque clic, et la page des réglages ne se refermait plus jamais.
- [ ] Faire en sorte que l'UI du device soit conforme et indisociables visuellement des devices natifs Ableton Live (couleurs, layout, espacements, labels, logique, typographies etc). Le device n'utilise que des objets `live.*`, la police Ableton Sans, et des positions entières. Les tailles sont celles des prototypes d'objets livrés avec Max (`resources/object-prototypes/m4l`), les marges sont égales des deux côtés, les onglets et menus sont en mode LCD, et quatre tests gardent ces règles sur le fichier livré. **À confirmer à l'œil avec Vassi.**
- [x] ~~Faire en sorte que l'UI du device suive le thème de couleur Ableton configuré par l'utilisateur~~ — abandonné par décision explicite de Vassi (voir « Décision sur le thème » ci-dessus) : le device impose maintenant un fond fixe, presque noir, sourcé dans le thème Sombre réel d'Ableton, indépendant du thème choisi dans les préférences de Live. Un test vérifie que toute couleur écrite vient bien de cette palette unique. **À confirmer à l'œil avec Vassi, dans les deux thèmes de Live.**
- [x] Pouvoir juger la mise en page sans ouvrir Ableton. `npm.cmd run device:preview` dessine les deux pages dans les deux thèmes de Live à partir du `.maxpat` : une maquette ne remplace pas Max, mais elle montre les débordements et les alignements de travers, ce qu'une relecture de coordonnées ne fait pas.
- [x] Ajouter les réglages Qualité et Latence à trois positions chacun et afficher les valeurs sélectionnées en texte. Deux `live.menu` de type Enum : c'est ce que Live pose devant un choix nommé, et « Équilibrée 400 ms » ne tient pas dans les 44 pixels d'un dial d'Ableton.
- [x] Définir Studio et Équilibrée comme valeurs par défaut.
- [x] Verrouiller les deux réglages pendant un live pour la v1. Le verrou suit l'état annoncé par le publisher : fermé en Connexion, Live et Reconnexion, ouvert en Arrêté et Erreur. Une panne rend donc les réglages, et repose le bouton, au lieu de laisser croire à un direct qui n'existe plus.
- [x] Afficher Arrêté, Connexion, Live, Reconnexion ou Erreur.
- [x] Démarrer dans cet ordre : connexion, authentification, `stream_start`, puis encodeur.
- [x] Arrêter dans cet ordre : encodeur, `stream_stop`, nettoyage de session.
- [x] Bloquer les doubles clics qui créeraient deux sessions. Le refus vit dans `publisher.js` et non dans le patch : une commande MIDI répétée ou une automation demanderaient la même chose qu'un double clic.
- [x] Rendre l’adresse du relais et le token modifiables depuis le device, dans deux champs texte et un bouton Enregistrer. Installer le système sur un nouvel ordinateur doit se faire sans ouvrir de terminal : poser le device, coller deux valeurs, cliquer. C’est le seul but de cette ligne.
- [x] Garder le token hors de l’état sauvegardé du device. Ableton enregistre l’état d’un device dans le projet `.als` ; un token qui y entrerait partirait avec le projet à chaque partage ou sauvegarde en ligne. Le token va dans `%APPDATA%\Vassi Stream\publisher.json`, propre à la machine, et le device n’en affiche jamais que les quatre derniers caractères.
- [x] Afficher dans le device si la configuration est présente et si le relais répond, pour qu’une erreur de collage se voie tout de suite. Le bouton Tester le relais interroge la route publique `/health` : aucun token ne circule pour cette vérification.
- [x] Documenter la configuration initiale de l’URL et du token sans commiter le secret. `docs/device-max.md`, section « Installer sur un nouvel ordinateur ».

### Vérification courte

Ces quatre points demandent Ableton et le relais déployé.

- [ ] Un clic démarre un live et la page devient prête.
- [ ] Un clic d’arrêt coupe le flux et la page repasse hors ligne.
- [ ] Une erreur réseau est affichée sans modifier le son du master.
- [ ] Les valeurs Studio et Équilibrée restent sauvegardées dans Ableton.

### Terminé

- [ ] **Bloc 10 validé.** Le code est écrit et testé : `npm.cmd run check` donne 303 tests, 0 échec. Reste la première ouverture dans Ableton, à faire avec Vassi. Détail dans `docs/validation/phase-10.md`.

## Bloc 11 — Vérifier le parcours réel et livrer

**Dépendances :** blocs 7 à 10.

**But :** vérifier le scénario réel avant de geler le device.

### À faire

- [ ] Faire un live de 15 à 30 minutes depuis Ableton vers la page `/session`.
- [ ] Faire écouter le flux dans le navigateur du professeur ou dans celui qui sera réellement utilisé.
- [ ] Faire un essai avec Google Meet actif.
- [ ] Vérifier une coupure réseau courte et le retour du live.
- [ ] Vérifier qu’un second listener peut rejoindre le live.
- [x] Le son du live persiste même si un user sur mobile éteint son écran (android KO après quelques
      minutes, ios KO instantanemment) — **traité autant que le web le permet, et pas plus.** Aucune
      page web ne peut garder un AudioWorklet en marche sur un iPhone verrouillé : iOS met alors le
      contexte audio dans l'état `interrupted`, dont la définition même est que la page n'a pas la
      main. Ce qui est fait : l'intention audio est déclarée (`navigator.audioSession`), ce qui règle
      au passage le son coupé par le bouton silencieux ; les commandes de l'écran verrouillé sont
      posées (`navigator.mediaSession`) ; et le son revient au direct dès le retour au premier plan,
      sans recharger la page. Détail et contournements écartés dans `docs/player-web.md`, section
      « Téléphone en veille et page en arrière-plan ». **Reste à mesurer sur de vrais téléphones.**
- [ ] Noter la latence ressentie et les éventuelles coupures.
- [ ] Ajuster les profils de latence seulement si ce test réel le justifie.
- [ ] Geler le device avec l’objet natif et les dépendances Node incluses.
- [x] Déployer la page `/session` sur le site. Le relais, lui, est déjà déployé et vérifié.
- [ ] Poser la règle de routage qui fait répondre `live.vassi.click/session`, ou décider que
      l’adresse publique reste celle du site.

### Vérification courte

- [ ] Le device gelé fonctionne après réouverture d’Ableton.
- [ ] Aucun `npm install` ni logiciel externe n’est nécessaire pour lancer le live.
- [ ] Le professeur entend le master stéréo pendant Google Meet.
- [ ] Le master Ableton reste inchangé.
- [ ] Vassi accepte la qualité Studio et la latence du profil choisi.

### Terminé

- [ ] **Projet validé par Vassi.**

## Après cette roadmap

Cette roadmap s’arrête quand le système fonctionne pour Vassi. Ce qu’il faudrait faire pour le
publier en open source — licence, nom, macOS, page d’écoute autonome, auto-hébergement — est décrit
dans `docs/Roadmap-v2.md`. Aucun de ses blocs ne rouvre une décision prise ici.

## Rappel pour l’agent qui implémente

Avant un bloc, relire `Agents.md`, `Concept.md` et cette roadmap. Faire une recherche Internet ciblée avant d’ajouter une bibliothèque ou d’utiliser une API peu connue. Expliquer le choix avant de coder.

Après un bloc, exécuter la vérification courte, relire le code ajouté et noter les éventuelles limites. Ne pas ajouter des fonctionnalités hors périmètre sans accord explicite de Vassi et mise à jour préalable de cette roadmap.
