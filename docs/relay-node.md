# Relais Node du bloc 7

Ce document decrit le relais deploye sur Sliplane : la partie qui recoit le flux du device et le
rediffuse aux auditeurs de la page `/live`. Le contrat public reste `docs/protocol-v1.md`.

## Chaine complete

```text
device Max for Live  --WSS /publisher-->  relais Sliplane  --WSS /listener-->  page /live
                                              |
                                              +--> GET /health
```

Le relais ne decode jamais l'audio. Il valide la structure d'un paquet, puis il envoie exactement
les memes octets a chaque auditeur. Il ne garde aucun historique : un auditeur qui arrive pendant un
live entend le direct, jamais ce qui precede.

## Fichiers

| Fichier | Responsabilite |
|---|---|
| `relay/config.ts` | lire et valider les variables d'environnement |
| `relay/token.ts` | comparer le token en temps constant |
| `relay/protocol.ts` | messages JSON v1 lus et construits par le relais |
| `relay/incoming.ts` | lire les octets recus et controler un paquet audio |
| `relay/publisher-connection.ts` | une connexion publisher : token, session, refus |
| `relay/listener-hub.ts` | liste des auditeurs, etat, diffusion, retard et coupure |
| `relay/http-routes.ts` | reponses HTTP : sante, 404, refus d'une connexion |
| `relay/server.ts` | serveur HTTP, routage des deux chemins, publisher unique |
| `relay/main.ts` | demarrage, journal, arret propre |
| `Dockerfile` | image deployee par Sliplane |

La validation d'un paquet audio n'est pas reecrite ici : elle vient de `src/protocol/audio-packet.ts`,
le module deja utilise par les tests du device. Sa fonction `inspectAudioPacket` verifie l'en-tete
sans recopier le payload. Une seule implementation sert donc au device, au relais et plus tard a la
page : elles ne peuvent pas diverger.

## Bibliotheques et execution

`ws` en version exacte `8.21.1`, la meme que le device. Un test refuse toute divergence entre les
trois manifestes : sans cette egalite, les tests ne verifieraient pas la bibliotheque reellement
deployee.

Le relais est ecrit en TypeScript et execute directement par Node 24, qui efface les annotations de
type au chargement. Il n'y a donc pas d'etape de compilation, donc pas de version compilee qui
pourrait differer de la version testee. La compression `perMessageDeflate` est desactivee : l'audio
Opus est deja compresse.

## Configuration

Toute la configuration passe par des variables d'environnement, comme le prevoit Sliplane.

| Variable | Role | Defaut |
|---|---|---|
| `VASSI_PUBLISHER_TOKEN` | token attendu du publisher, marque comme secret | aucun, obligatoire |
| `PORT` | port ecoute, impose entre 8080 et 65535 par Sliplane | `8080` |
| `VASSI_MAX_LISTENERS` | nombre maximal d'auditeurs simultanes | `50` |

Un token absent ou plus court que 32 caracteres arrete le demarrage. Un relais sans token accepterait
n'importe quel publisher : il vaut mieux qu'il ne demarre pas du tout, avec une raison lisible dans
les journaux Sliplane. `npm run token:new` tire un token de 64 caracteres.

## Authentification

Le token recu et le token attendu passent tous les deux par SHA-256, puis les deux empreintes de
32 octets sont comparees par `crypto.timingSafeEqual`.

Une comparaison ordinaire s'arrete au premier caractere different : son temps de reponse revele
combien de caracteres sont deja corrects, ce qui permet de deviner un token caractere par caractere.
`timingSafeEqual` compare en temps constant mais refuse deux tampons de tailles differentes ; le
passage par une empreinte de taille fixe supprime aussi cette fuite de longueur.

Le token n'apparait dans aucun journal. Un test relit tous les fichiers du relais pour le verifier.

## Un seul publisher, le dernier authentifie

Le relais garde une seule connexion publisher en direct. Quand une nouvelle connexion presente un
token valide, elle prend la place de la precedente, qui recoit `server_error publisher_replaced`
puis une fermeture normale.

La roadmap demandait de n'accepter qu'un publisher a la fois. Refuser le nouveau venu aurait produit
un blocage reel : une connexion morte que le relais n'a pas encore detectee, par exemple apres une
coupure Wi-Fi, garde la place jusqu'a son propre delai de silence. Le device reconnecte serait alors
refuse pendant environ une minute, sans que Vassi puisse rien faire. Le remplacement supprime ce cas,
sans affaiblir la protection : il faut toujours le token pour prendre la place.

Le remplacement remet les auditeurs hors ligne, puis le nouveau `stream_start` ouvre une nouvelle
session. Un test bout en bout verifie ce parcours avec le vrai publisher du device.

Les connexions qui n'ont pas encore donne de token sont limitees a quatre, et chacune est fermee au
bout de cinq secondes de silence. Une connexion inconnue ne peut donc ni s'accumuler ni attendre.

## Ce qui est refuse

| Situation | Reponse | Connexion |
|---|---|---|
| token absent ou faux | `auth_error invalid_token` | fermee, code 1008 |
| pas de token en cinq secondes | `server_error auth_timeout` | fermee |
| audio ou `stream_start` avant le token | `server_error not_authenticated` | fermee |
| JSON illisible, version differente de 1 | `server_error` avec la raison | fermee, code 1002 |
| `stream_start` hors des valeurs v1 | `server_error invalid_bitrate`, etc. | fermee, code 1002 |
| frame avant `stream_start` | `server_error no_active_session` | gardee |
| paquet mal forme | `server_error invalid_packet` | gardee |
| paquet d'une autre session | `server_error session_mismatch` | gardee |
| `stream_stop` visant une autre session | `server_error unknown_session` | gardee |
| message JSON inconnu | `server_error unsupported_message` | gardee |
| auditeur qui envoie quelque chose | fermeture, code 1003 | fermee |

La difference compte : une faute qui met le flux dans un etat inconnu ferme la connexion, mais un
paquet abime ne coupe pas un live en cours. Un octet perdu sur le reseau ne doit pas arreter la
seance de travail de Vassi.

Les messages d'erreur sont limites a un par seconde et par connexion. Sans cette limite, un
publisher casse recevrait cinquante messages d'erreur par seconde, soit plus de trafic que l'audio
lui-meme. Le compteur de paquets refuses continue pourtant d'avancer et reste visible sur `/health`.

`auth_error` est reserve au token refuse. Le device traite ce message comme une panne definitive qui
demande une action de Vassi : une authentification simplement trop lente ou un message mal forme
donnent `server_error`, donc une coupure ordinaire suivie d'une reconnexion.

## Auditeurs

Un auditeur recoit son `stream_state` avant d'entrer dans la liste de diffusion. Cet ordre garantit
qu'aucun paquet audio n'arrive avant l'etat qui le decrit.

Deux limites protegent le relais d'un auditeur trop lent, lues sur `bufferedAmount`, le nombre
d'octets deja remis a `send()` mais pas encore partis :

- au-dela de 65536 octets, soit environ deux secondes en qualite Studio, les paquets sont abandonnes
  au lieu d'etre empiles ; l'auditeur reprend la diffusion des qu'il rattrape son retard ;
- au-dela de 524288 octets, soit environ seize secondes, la connexion est coupee : elle ne rattrapera
  plus rien et sa file grandirait sans fin.

Abandonner avant de couper evite de deconnecter un auditeur pour un simple a-coup reseau. Ces
abandons creent des trous de numero de sequence, que le player du bloc 8 traite comme une
discontinuite.

Le relais envoie un ping toutes les vingt secondes, aux auditeurs comme au publisher. Deux pings sans
reponse ferment la connexion : c'est la seule facon de detecter une liaison morte que le systeme
d'exploitation croit encore ouverte. Ces pings gardent aussi la connexion vivante a travers le proxy
de l'hebergeur, qui ferme souvent une connexion inactive.

La limite d'auditeurs est appliquee avant l'ouverture de la connexion : la demande recoit une reponse
HTTP 503 au lieu d'une connexion WebSocket aussitot fermee. La liste des auditeurs verifie la meme
limite une seconde fois au moment d'inscrire une connexion, et ferme l'auditeur de trop avec le code
1013. C'est elle qui porte la limite : elle doit tenir meme si le chemin d'entree change un jour.

## Route de sante

`GET /health` et `GET /` renvoient le meme JSON, sans aucun secret :

```json
{
  "status": "ok",
  "live": true,
  "sessionId": 123456789,
  "listeners": 2,
  "lastPacketAgeMs": 18,
  "uptimeSeconds": 3600,
  "framesRelayed": 180000,
  "bytesRelayed": 126000000,
  "packetsRefused": 0,
  "sessions": 1,
  "listenersRefused": 0,
  "listenersClosedSlow": 0,
  "listenersClosedSilent": 0,
  "listenerFramesDropped": 0
}
```

`packetsRefused` avance des qu'un paquet est refuse, pendant que le publisher est encore connecte.
Un compteur qui n'apparaitrait qu'apres la fermeture serait inutile : la sante est consultee au
moment ou le probleme se produit. Il ne redemarre pas a l'ouverture d'une nouvelle session.

`listenerFramesDropped` distingue deux pannes qui ressemblent a la meme chose pour l'auditeur. Un
son troue avec ce compteur a zero vient d'avant le relais, du cote d'Ableton ou du reseau du
publisher. Le meme son troue avec ce compteur qui avance vient de la connexion de l'auditeur.

La racine repond comme `/health` parce que Sliplane interroge `/` tant qu'aucun chemin n'est
configure, et considere en panne un service qui repond autre chose qu'un code 2XX.

`lastPacketAgeMs` est le point le plus utile en cas de doute : un direct annonce depuis longtemps
avec un dernier paquet vieux de plusieurs secondes signale un probleme entre Ableton et le relais.

## Journal

Une ligne JSON par evenement sur la sortie standard, ce que Sliplane collecte : demarrage, connexion
et authentification du publisher, ouverture et fermeture de session, arrivee et depart des auditeurs,
refus. Aucun octet audio et aucun token n'y figurent.

## Arret

`SIGTERM` et `SIGINT` annoncent d'abord la fin du direct aux auditeurs, ce qui leur fait afficher
« pas pret » au lieu d'une erreur de connexion, puis ferment les connexions et le port. Un arret
force intervient au bout de cinq secondes si un socket ne se ferme pas.

## Deploiement Sliplane

1. Creer un service public a partir du depot ; le `Dockerfile` a la racine est utilise
   automatiquement.
2. Ajouter la variable `VASSI_PUBLISHER_TOKEN`, marquee comme secret, avec la valeur produite par
   `npm run token:new`.
3. Laisser `PORT` a `8080` ou choisir une autre valeur entre 8080 et 65535.
4. Regler le chemin du controle de sante sur `/health`.
5. Attacher le domaine choisi, `www.vassi.click` ou un sous-domaine dedie ; le certificat TLS fourni
   par Sliplane rend les adresses `wss://` disponibles.
6. Ecrire la meme valeur de token dans le device :
   `npm run config:publisher -- --url wss://<domaine>/publisher`, token passe par la variable
   d'environnement `VASSI_PUBLISHER_TOKEN`.

Le token vit donc a deux endroits, tous deux hors du depot : les variables d'environnement chiffrees
de Sliplane et le fichier de configuration local du device.

## Limites connues

- Le relais accepte un auditeur venu de n'importe quelle origine. Le flux est public par definition :
  une restriction d'origine ne protegerait rien et empecherait un test depuis un autre domaine.
- Le nombre d'auditeurs est limite par un compteur simple, sans file d'attente. Le perimetre du
  projet prevoit peu d'auditeurs.
- Le relais ne mesure pas la bande passante par auditeur : la seule protection est la limite de file
  d'envoi decrite plus haut.
- L'arret propre depend de `SIGTERM`, envoye par Docker et donc par Sliplane. Sous Windows, un arret
  par la console coupe le processus sans passer par cette annonce.
