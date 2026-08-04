# Pont interne VSF1 entre `vassi.encoder~` et `node.script`

Ce document decrit le seul chemin utilise pour remettre les paquets Opus a Node. Il ne remplace pas
`docs/protocol-v1.md`, qui reste le contrat public entre le publisher, le relais et le navigateur.

## Pourquoi un socket loopback et pas un message Max

Node for Max fait transiter chaque message Max vers Node par un socket local qui transporte du JSON.
Le fichier `Node for Max/source/lib/communication/socket.js` le dit explicitement : les messages sont
des objets convertis avec `JSON.parse` et `JSON.stringify`, precedes d'une longueur `UInt32BE`.

Envoyer une frame Opus comme liste Max coute donc quatre conversions par frame :

1. environ 640 `t_atom` construits dans Max ;
2. un tableau JSON en texte ecrit dans le socket interne de Node for Max ;
3. un tableau de nombres JavaScript recree par `JSON.parse` ;
4. une copie finale vers un `Buffer` pour l'envoi WebSocket.

Cinquante fois par seconde, ce trafic declenche en plus un defaut confirme par Cycling '74 : la memoire
du processus Max grandit proportionnellement au volume envoye a `node.script`, sans limite connue.

Le socket loopback supprime les quatre conversions. L'objet natif ecrit ses octets, Node les recoit
directement sous forme de `Buffer` et pourra les passer tels quels a `ws` au bloc 6.

## Pourquoi TCP et pas UDP

- UDP perd des datagrammes en silence quand le tampon de reception est plein, sans aucun signal.
- UDP ne donne aucun etat de connexion, alors que le device doit afficher `ready`, `error` et `stopped`.
- Sous Windows, un envoi UDP vers un port ferme provoque un ICMP port unreachable qui fait echouer
  l'operation suivante avec `WSAECONNRESET`. Ce piege connu casserait le flux sans raison visible.

TCP sur `127.0.0.1` donne l'ordre, l'integrite, un etat de connexion explicite et aucune de ces surprises.

## Sens de la connexion

Node ecoute, l'objet natif se connecte.

1. `node.script` demarre et ouvre un serveur TCP sur `127.0.0.1` avec le port `0`.
2. Le systeme choisit un port libre. Node l'annonce a Max avec `Max.outlet("port", <numero>)`.
3. Le patch transmet ce numero a `vassi.encoder~` avec le message `port <numero>`.
4. Le worker de l'objet ouvre la connexion et la reouvre toutes les 250 ms tant qu'elle echoue.

L'ecoute est liee explicitement a `127.0.0.1` : le pont n'est jamais visible depuis le reseau et
Windows ne demande aucune autorisation de pare-feu. Le port n'est jamais ecrit en dur, donc deux
instances du device ne peuvent pas se gener.

Le message `port 0` ferme la connexion. Tant qu'aucun port n'est annonce, aucune frame ne quitte l'objet.

Le message `getport` envoye a `node.script` fait reannoncer le port courant. Il sert quand l'encodeur
est cree apres l'annonce initiale, ou quand un `port 0` a ferme la connexion volontairement.

Node ne garde qu'une connexion. Une connexion neuve remplace la precedente au lieu d'etre refusee :
l'objet natif ne rouvre le pont qu'apres avoir ferme le sien, donc une nouvelle arrivee signifie
toujours que l'ancienne est morte, meme si Node n'a pas encore recu l'evenement de fermeture.

## Format d'une frame

Les entiers sont en big-endian, comme le protocole public.

| Offset | Taille | Champ |
|---:|---:|---|
| 0 | 4 | magic ASCII `VSF1` |
| 4 | 4 | `sequence` `uint32` |
| 8 | 8 | timestamp relatif `uint64` en microsecondes |
| 16 | 1 | flags, bit 0 = discontinuite |
| 17 | 1 | reserve, toujours `0` |
| 18 | 2 | taille du payload, de `1` a `1276` |
| 20 | N | paquet Opus brut |

Le magic sert a se resynchroniser : si le lecteur recoit un octet parasite, il cherche le prochain
`VSF1` plausible au lieu d'abandonner la connexion.

Les champs `sessionId`, magic public, version, codec et nombre d'echantillons n'apparaissent pas ici.
Ils appartiennent a l'en-tete public que Node construit au bloc 6.

## Regles de perte

Le pont ne met jamais l'audio en attente pour rattraper Node. Trois situations produisent une perte
locale, et toutes les trois marquent la frame suivante avec le bit de discontinuite :

- la queue audio deborde, ce qui est traite par l'encodeur depuis le bloc 4 ;
- un envoi echoue ou depasse 50 ms, la connexion est alors fermee puis rouverte ;
- une connexion neuve s'ouvre, car Node n'a pas recu les frames precedentes.

Le compteur de frames perdues distingue deux situations. Un pont volontairement ferme, c'est-a-dire
sans port annonce, ne compte rien : aucune frame n'est attendue par Node. Un port annonce mais
injoignable compte chaque frame jetee, sinon un Node absent afficherait zero perte pendant que tout
l'audio disparait.

Le tampon d'envoi du noyau est limite a 8192 octets, soit environ dix frames. Cette limite remplace une
file d'attente supplementaire : au-dela, l'envoi echoue vite au lieu d'accumuler de l'audio ancien.
`TCP_NODELAY` empeche Windows de retarder ces petits envois.

Une frame partiellement ecrite desynchroniserait le flux. Ce cas ferme la connexion au lieu de tenter
une reprise au milieu d'une frame.

## Etats visibles

`vassi.encoder~` sort `status connected`, `status disconnected` ou `status error` des que la connexion
ou l'etat du worker change. Cette sortie passe par un `qelem`, seul mecanisme du SDK Max autorise pour
parler a Max depuis un thread cree par l'objet.

`status error` prime sur l'etat de connexion : il signale que le thread d'encodage s'est arrete et que
plus aucune frame ne sera produite, meme si le socket vers Node reste ouvert. Un message `start` remet
l'objet en marche apres correction de la cause.

`node.script` sort `status ready`, `status stopped` ou `status error` selon que l'encodeur est connecte,
absent ou que l'ecoute a echoue.

Le `bang` de l'objet ajoute une liste `bridge` avec le port demande, l'etat de connexion, le nombre de
frames envoyees et le nombre de frames perdues.

## Limites connues

`frame_sender.cpp` utilise Winsock. La cible actuelle est Windows x64, conformement au bloc 0. Un portage
macOS demandera la variante BSD des memes appels, sans changer le format ni la logique.

L'objet natif ne verifie pas l'identite du programme qui ecoute sur le port annonce. Si `node.script`
s'arrete et qu'un autre programme reprend exactement le meme port ephemere avant la prochaine annonce,
l'objet lui enverrait ses frames. Le risque reste theorique en loopback avec des ports ephemeres, et le
message `port 0` ferme la connexion des que Node s'arrete volontairement. Une poignee de main dans les
deux sens reglerait definitivement ce cas ; elle n'est pas ajoutee tant que le probleme n'est pas observe.

Le sens entrant a la meme limite, et elle est acceptee volontairement. Node ecoute sur `127.0.0.1` sans
demander d'identite : n'importe quel programme du meme compte peut se connecter au port annonce, et
comme une connexion neuve remplace la precedente, il prendrait la place de l'objet natif. Un programme
quelconque ne peut pas nuire par accident, parce que le lecteur rejette tout ce qui n'est pas du `VSF1`
bien forme ; il faudrait un programme ecrit pour cela. Or un tel programme tournerait deja sous le compte
de Vassi, sur sa machine, avec acces au fichier qui contient le token de publication : le pont ne serait
alors pas le maillon le plus faible, et l'authentifier ne protegerait rien de plus. Cette limite est donc
documentee plutot que corrigee.
