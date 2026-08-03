# Validation courte - Bloc 7

Date : 2026-08-03.

## Resultat

Le relais existe. Il authentifie un publisher, ouvre une session, diffuse les paquets audio sans les
modifier aux auditeurs de la page `/live`, et remet tout le monde hors ligne des que le publisher
disparait. La conception complete est dans `docs/relay-node.md`.

Le relais tourne en local et a ete verifie deux fois : par les tests automatiques, et par un
demarrage reel du processus tel que l'hebergeur le lancera.

## Fichiers du bloc

- `relay/config.ts` : variables d'environnement, refus d'un demarrage sans token.
- `relay/token.ts` : comparaison du token en temps constant.
- `relay/protocol.ts` : messages JSON v1 lus et construits par le relais.
- `relay/incoming.ts` : lecture des octets recus et controle d'un paquet audio.
- `relay/publisher-connection.ts` : une connexion publisher, de son token a ses paquets.
- `relay/listener-hub.ts` : auditeurs, etat, diffusion, retard et coupure.
- `relay/http-routes.ts` : reponses HTTP, dont la route de sante.
- `relay/server.ts` : serveur HTTP, deux chemins WebSocket, publisher unique.
- `relay/main.ts` : demarrage, journal, arret propre.
- `Dockerfile` et `.dockerignore` : image deployee par Sliplane.
- `scripts/new-token.js` : token de publication aleatoire.
- `src/protocol/audio-packet.ts` : ajout de `inspectAudioPacket`, validation sans copie du payload.

## Recherche Internet

- `ws`, patrons `noServer` et battement de coeur : https://github.com/websockets/ws/blob/master/README.md
- Retard d'envoi et `bufferedAmount` : https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
- Diffusion et clients lents : https://websockets.readthedocs.io/en/stable/topics/broadcast.html
- Deploiement Sliplane, `PORT` et controle de sante : https://docs.sliplane.io/services/deploying-a-service/
- Comparaison de secret en temps constant : https://til.simonwillison.net/node/constant-time-compare-strings

Decisions venues de cette recherche :

- **Deux serveurs WebSocket `noServer` derriere un seul serveur HTTP.** C'est le patron documente par
  `ws` pour separer deux chemins. Il permet aussi de refuser une connexion avant toute negociation.
- **Ralentir la diffusion pour attendre un auditeur lent est une mauvaise idee.** La documentation de
  la bibliotheque `websockets` explique pourquoi : synchroniser tout le monde sur le plus lent
  degrade l'ecoute de tous, et le plus lent ne rattrapera pas son retard. Le relais abandonne donc
  les paquets d'un auditeur en retard, puis coupe une connexion bloquee.
- **`PORT` entre 8080 et 65535, controle de sante en GET qui doit repondre 2XX sans authentification.**
  C'est ce qu'impose Sliplane. La racine repond comme `/health`, parce que le chemin par defaut du
  controle est `/`.
- **SHA-256 avant `timingSafeEqual`.** `timingSafeEqual` refuse deux tampons de tailles differentes,
  ce qui ferait fuiter la longueur du token. Deux empreintes de 32 octets suppriment cette fuite.
- **Sliplane accepte les services WebSocket.** Leur documentation montre un second service dedie a un
  serveur temps reel derriere leur proxy.

## Verification executee

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 157
pass 157
fail 0
OK: tous les tests natifs de la queue audio passent
OK: tous les tests natifs Opus passent
OK: tous les tests natifs du pont loopback passent
```

Le bloc ajoute 52 tests aux 105 existants. La suite complete a ete lancee trois fois de suite sans
echec, pour verifier que les tests reseau ne dependent pas du rythme de la machine.

Un demarrage reel a aussi ete fait, avec le processus lance comme sur le serveur :

```text
node relay/main.ts   (PORT=8123, VASSI_PUBLISHER_TOKEN pose, VASSI_MAX_LISTENERS=3)
```

La route de sante repond `live: false`, un auditeur recoit l'etat hors ligne, un publisher
authentifie ouvre une session, l'auditeur recoit l'etat en direct puis le paquet audio, et la sante
passe a `live: true` avec `framesRelayed: 1`. Le journal contient les evenements attendus et aucun
token.

## Verifications courtes de la roadmap

1. **Le bon token est accepte et le mauvais refuse.**
   Test `accepte le bon token et refuse le mauvais sans jamais le renvoyer`. Le mauvais token recoit
   `auth_error invalid_token` et une fermeture 1008. Aucun message recu ne contient le token attendu
   ni le token propose.

2. **Un listener avant le live voit l'etat hors ligne.**
   Test `envoie l'etat hors ligne au listener arrive avant le live`. Le premier message recu est
   exactement `{"type":"stream_state","protocolVersion":1,"live":false}`, et aucun octet audio ne
   suit.

3. **Deux listeners pendant le live recoivent les memes paquets dans le meme ordre.**
   Test `diffuse les memes paquets dans le meme ordre a deux listeners`. Les trois paquets sont
   identiques octet pour octet des deux cotes et dans le meme ordre. Le second listener, arrive apres
   le debut du live, a recu son etat en direct avant tout paquet audio.

4. **Arreter le publisher remet les listeners hors ligne.**
   Tests `repasse les listeners hors ligne apres stream_stop` et
   `repasse les listeners hors ligne quand le publisher disparait`. Les deux chemins produisent le
   meme resultat : l'arret annonce et la disparition brutale de la connexion.

## Autres tests ajoutes

Le vrai publisher du device est branche sur le vrai relais dans `tests/relay-publisher-e2e.test.ts`.
Les autres tests utilisent des clients de test ; celui-ci verifie que les deux moities, ecrites aux
blocs 6 et 7, se comprennent reellement :

- un direct complet du device jusqu'a l'auditeur, avec des payloads identiques d'un bout a l'autre ;
- l'arret depuis le device qui remet la page hors ligne ;
- un mauvais token qui arrete le device sur une erreur lisible, sans exposer le token ;
- le device remplace par un autre publisher, qui reconnecte et reprend sa place avec une nouvelle
  session.

Refus et protections :

- audio ou `stream_start` avant le token : connexion fermee, rien n'est diffuse ;
- frame avant `stream_start` : refusee, connexion gardee, la session suivante fonctionne ;
- paquet tronque, magic invalide, session etrangere : refuses sans interrompre le direct ;
- `stream_start` hors des valeurs v1 : connexion fermee, aucun direct ouvert ;
- `stream_stop` visant une autre session : refuse, le direct continue ;
- message inconnu : signale sans fermer ;
- version de protocole differente : connexion fermee ;
- trame plus grande que le plus grand paquet du protocole : connexion fermee, relais toujours sain ;
- limite d'auditeurs et limite de connexions publisher en attente : refus en HTTP 503 ;
- chemin inconnu : refus en HTTP 404, aucune connexion WebSocket ouverte ;
- auditeur qui envoie des donnees : ferme en 1003.

Temps et retard, verifies avec de faux sockets et une horloge de test :

- delai d'authentification de cinq secondes, arrete des que le token est accepte ;
- deux pings sans reponse coupent une connexion, un signe de vie la garde ;
- un auditeur en retard perd des paquets puis reprend la diffusion quand il rattrape ;
- un auditeur bloque est coupe et retire de la liste ;
- au plus un message d'erreur par seconde, alors que le compteur de refus continue d'avancer.

Coherence du projet :

- meme version exacte de `ws` dans le relais, le device et les tests ;
- l'image Docker copie bien le relais et le module de protocole partage, et lance `relay/main.ts` ;
- aucun fichier du relais n'ecrit dans la console ni ne journalise le token ;
- `inspectAudioPacket` applique exactement les memes regles que la lecture complete d'un paquet.

## Points decides pendant l'implementation

1. **Le dernier publisher authentifie prend la place.** La roadmap demandait un seul publisher a la
   fois. Refuser le nouveau venu aurait bloque un vrai cas : une connexion morte, pas encore
   detectee, garde la place jusqu'a son delai de silence, et le device reconnecte serait refuse
   pendant environ une minute. Le remplacement supprime ce blocage sans affaiblir la protection,
   puisqu'il faut toujours le token.

2. **Un paquet abime ne ferme pas la connexion.** Fermer aurait transforme un octet perdu en coupure
   du live. Seules les fautes qui laissent le flux dans un etat inconnu ferment la connexion.

3. **`server_error` plutot que `auth_error` pour les fautes de protocole.** Le device traite
   `auth_error` comme une panne definitive qui demande une action de Vassi. Une authentification
   trop lente sur un reseau charge doit rester une coupure ordinaire suivie d'une reconnexion.

4. **Le relais refuse de demarrer sans token utilisable.** Un relais qui demarre avec un token vide
   accepterait n'importe quel publisher. Une panne visible dans les journaux vaut mieux qu'un service
   ouvert.

5. **Validation du paquet sans copie du payload.** `inspectAudioPacket` a ete ajoute au module de
   protocole partage plutot que reecrit dans le relais. Le device, le relais et plus tard la page
   utilisent donc la meme implementation, qui ne peut pas diverger.

## Defauts trouves pendant la revue du bloc 8

Quatre points ont ete corriges en relisant le relais avant de brancher le player dessus. Aucun ne
changeait le son diffuse ; trois touchaient au diagnostic, un a une garde interne.

1. **`packetsRefused` n'avancait qu'a la fermeture du publisher.** Le compteur etait ajoute au total
   du relais dans `handleClosed`, et il repartait de zero a chaque `stream_start`. La route de sante
   affichait donc zero paquet refuse pendant qu'un publisher en refusait cinquante par seconde,
   c'est-a-dire exactement au moment ou quelqu'un la consulte. Le serveur est maintenant prevenu a
   chaque refus, par un rappel `onPacketRefused`, et le compteur ne redemarre plus entre deux
   sessions.

2. **`/health` cachait les paquets abandonnes pour un auditeur en retard.** Le hub comptait
   `framesDropped` et `closedSilent` sans les exposer. Ces deux nombres distinguent deux pannes qui
   s'entendent pareil : un son troue venu de la connexion de l'auditeur, ou un son troue venu d'avant
   le relais. `/health` renvoie desormais `listenerFramesDropped` et `listenersClosedSilent`.

3. **La limite d'auditeurs n'etait verifiee que sur le chemin d'entree.** Le refus HTTP 503 avant
   l'ouverture reste le comportement normal, mais la liste elle-meme n'appliquait pas la limite
   qu'elle porte. Elle refuse maintenant l'auditeur de trop et le ferme avec le code 1013.

4. **`setSession` parcourait la liste sans la copier**, alors que `broadcast` la copiait deja. Une
   erreur de socket retire son auditeur pendant la boucle : les deux parcours suivent maintenant la
   meme regle.

Quatre tests verrouillent ces comportements. La suite du bloc 7 passe sans autre modification.

## Defaut trouve pendant la relecture du bloc

Un auditeur dont la connexion disparaissait pendant l'envoi de son premier etat entrait quand meme
dans la liste de diffusion. Le compteur d'auditeurs et la limite de places restaient donc faux
jusqu'a l'arrivee de son evenement de fermeture. La liste n'accepte maintenant qu'une connexion
encore ouverte apres cet envoi, et un test verrouille ce comportement.

## Bloc precedent

Le publisher du bloc 6 fonctionne sans aucune modification : les quatre tests bout en bout utilisent
`device/node/publisher.js` tel quel. Aucun fichier du device n'a ete touche par ce bloc.

## Limites reportees

- Le relais n'est pas encore deploye sur Sliplane. Le domaine, `www.vassi.click` ou un sous-domaine
  dedie, reste a choisir avec Vassi, et la connexion `wss://` reelle sera verifiee a ce moment.
- L'arret propre depend de `SIGTERM`, envoye par Docker. Il n'est pas verifiable tel quel sous
  Windows ; les deux etapes qu'il declenche, l'annonce hors ligne et la fermeture, sont testees
  separement.
- Aucun test de charge n'est fait : le perimetre prevoit peu d'auditeurs. La protection contre un
  auditeur lent est verifiee avec de faux sockets, pas avec un vrai reseau lent.
- La page `/live` n'existe pas encore : les auditeurs de ces tests sont des clients WebSocket. Le
  vrai player arrive au bloc 8.

## Decision

Le Bloc 7 est valide en local sur ses quatre verifications courtes. Le deploiement Sliplane reste a
faire avec Vassi.
