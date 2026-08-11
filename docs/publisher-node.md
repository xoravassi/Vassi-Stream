# Publisher Node du device

Ce document decrit le cote Node du device : la partie qui ouvre la connexion vers le relais, envoie
le protocole v1 et remonte un etat lisible a Max. Le contrat public reste `docs/protocol-v1.md`, et
le pont interne entre l'objet natif et Node reste `docs/bridge-vsf1.md`.

## Chaine complete

```text
vassi.encoder~  --VSF1-->  frame-bridge.js  -->  publisher.js  --WSS-->  relais
                                                     |
                                                     +--> etat vers Max
```

Le publisher ne cree jamais d'audio. Il recoit une frame deja encodee, ecrit l'en-tete public de
28 octets devant le payload Opus et envoie le tout sans le modifier.

## Fichiers

| Fichier | Responsabilite |
|---|---|
| `device/node/publisher-config.js` | trouver, lire, ecrire et decrire la configuration |
| `device/node/publisher-protocol.js` | messages JSON v1, en-tete binaire v1, identifiant de session |
| `device/node/publisher-backoff.js` | delai avant chaque tentative de reconnexion |
| `device/node/publisher.js` | machine a etats, connexion, session, envoi des frames |
| `device/node/vassi-stream-device.js` | cablage du pont, du publisher et des messages Max |

## Bibliotheques

`ws` en version exacte `8.21.1`, declaree dans `device/node/package.json`. La meme version exacte est
declaree a la racine pour les tests, et un test verifie que les deux ne divergent jamais : sans cette
egalite, les tests ne verifieraient pas la bibliotheque reellement embarquee dans le device.

`max-api` n'est pas installe. Node for Max le fournit au demarrage du script par la variable
`NODE_PATH`, et il n'existe pas sur npm sous une forme utilisable hors de Max. C'est aussi la raison
pour laquelle tout le code du device reste en CommonJS.

La compression `perMessageDeflate` est desactivee : l'audio Opus est deja compresse, la compresser une
seconde fois couterait du temps de calcul et de la latence sans rien gagner.

## Configuration

Le fichier est cherche dans cet ordre :

1. le chemin de la variable d'environnement `VASSI_PUBLISHER_CONFIG`, utilisee par les tests ;
2. `%APPDATA%\Vassi Stream\publisher.json` sous Windows ;
3. `~/Library/Application Support/Vassi Stream/publisher.json` sous macOS ;
4. `~/.config/vassi-stream/publisher.json` ailleurs.

Contenu :

```json
{
	"relayUrl": "wss://live.vassi.click/publisher",
	"publisherToken": "valeur_secrete"
}
```

Ce fichier vit hors du projet pour trois raisons : il ne peut pas etre commite par accident, il
survit au gel du device prevu au bloc 11, et il survit a un deplacement du dossier de travail.

Il contient le token de publication : sur macOS et Linux, le dossier est cree en `0700` et le fichier
est ramene a `0600` apres chaque ecriture. Poser les droits apres coup est necessaire, parce que le
mode d'ouverture ne s'applique qu'a une creation et laisserait un fichier deja existant lisible par
les autres comptes de la machine. Windows ignore ces droits POSIX : la protection y vient de
`%APPDATA%`, propre a chaque compte.

Ecriture depuis la ligne de commande :

```powershell
$env:VASSI_PUBLISHER_TOKEN = "valeur_secrete"
npm.cmd run config:publisher -- --url wss://live.vassi.click/publisher
```

Passer le token par la variable d'environnement evite de le laisser dans l'historique du terminal.
L'option `--token` existe aussi, mais elle est moins sure. Le script ne reaffiche jamais le token ; il
confirme seulement qu'il est enregistre. Le device ecrit aujourd'hui ce meme fichier depuis son
panneau de reglages : cette commande ne sert plus qu'a un poste ou Max n'est pas installe.

Une adresse `wss://` est acceptee partout. Une adresse `ws://` n'est acceptee que vers `127.0.0.1` ou
`localhost`, ce qui sert aux tests : le token de publication ne doit jamais traverser un reseau en
clair.

## Etats

| Etat | Sens |
|---|---|
| `STOPPED` | aucun live demande |
| `CONNECTING` | connexion ouverte, authentification en cours |
| `LIVE` | token accepte, session ouverte, audio en cours d'envoi |
| `RECONNECTING` | connexion perdue, prochaine tentative programmee |
| `ERROR` | arret definitif jusqu'a une action de Vassi |

`ERROR` est reserve aux causes qu'une nouvelle tentative ne reglerait pas : configuration absente ou
invalide, et token refuse par le relais. Une coupure reseau donne toujours `RECONNECTING`.

## Ordre de demarrage et d'arret

Demarrage : connexion, `publisher_auth`, `auth_ok`, nouvelle session, `stream_start`, puis encodeur.
L'encodeur ne demarre jamais avant l'acceptation du token, et jamais avant `stream_start`, parce que
le relais refuse toute frame audio recue avant l'ouverture de session.

Arret : encodeur, `stream_stop`, fermeture douce de la connexion. La fermeture douce laisse partir le
`stream_stop` deja mis en file ; une fermeture brutale le perdrait et le relais devrait attendre la
disparition de la connexion pour repasser les listeners hors ligne.

La connexion est detachee au moment de l'arret : son evenement de fermeture arrive apres coup et ne
decide plus rien. Sans ce detachement, le device recevrait un second `encoder stop` et un second etat
`STOPPED` pour le meme arret.

`SIGTERM` et `SIGINT` ferment la session, puis le pont loopback, puis terminent le processus. Ce
dernier point n'est pas une precaution : ajouter un gestionnaire de signal remplace l'arret par
defaut de Node, et le port loopback garderait la boucle d'evenements vivante. Le script ne s'arreterait
plus tout seul et Max devrait le tuer.

## Reconnexion

Une connexion fermee arrete d'abord l'encodeur, puis programme une tentative selon les paliers
`1, 2, 4, 8, 16, 30 s`. Le dernier palier se repete indefiniment. Chaque delai recoit un jitter de
plus ou moins 20 %, pour qu'un relais qui redemarre ne recoive pas toutes les reconnexions au meme
instant.

Le compteur de paliers ne repart de zero que si la connexion precedente est restee en direct au moins
30 secondes. Sans cette condition, un relais qui accepte le token puis coupe aussitot serait rappele
toutes les secondes sans fin : chaque session ouverte effacerait l'historique des paliers juste avant
la coupure suivante.

Chaque reconnexion reussie cree un nouveau `sessionId`. Cette regle vient du protocole : elle permet
au player de jeter l'ancien flux sans deviner si le precedent continue.

Trois minuteurs protegent la connexion. L'authentification doit repondre en 5 secondes. Le publisher
envoie son propre ping toutes les 15 secondes. Une absence totale de trafic pendant 45 secondes ferme
la connexion.

Le ping du publisher compte autant que celui du relais. Le protocole demande au relais un ping toutes
les 20 secondes, mais s'appuyer sur lui seul rendrait la detection de liaison morte dependante du bon
fonctionnement de l'autre bout : un relais joignable mais muet laisserait le device afficher `LIVE`
alors que plus aucun octet n'arrive aux listeners. Le pong qui repond au ping du publisher teste la
liaison de bout en bout et relance le compte a rebours du silence.

Une reponse `auth_ok` ou `auth_error` n'est acceptee que dans la fenetre qui suit `publisher_auth`.
Repetee pendant un live, elle ouvrirait une session de plus et relancerait l'objet natif.

## Numeros de sequence et timestamps

Le pont interne numerote ses frames depuis le demarrage de l'objet natif, sans rapport avec les
sessions. Le publisher ramene donc chaque frame sur la chronologie de la session courante :

```text
sequence publique  = sequence du pont     - sequence de la premiere frame de la session
timestamp publique = timestamp du pont    - timestamp de la premiere frame de la session
```

Cette soustraction conserve exactement les trous de sequence et l'avance de timestamp qui suit une
perte audio locale, sans demander a l'objet natif de repartir de zero a chaque session.

Deux situations obligent a ouvrir une nouvelle session au milieu d'un live : un numero du pont plus
petit que celui de la premiere frame, ce qui signifie que l'encodeur a redemarre, et un numero
publique proche de la fin du compteur de 32 bits. Les deux cas envoient `stream_stop` puis un nouveau
`stream_start`, parce qu'un listener ne doit jamais voir un numero de sequence reculer.

Ce renouvellement ne relance pas l'encodeur. Le relancer remettrait sa numerotation a zero, ce qui
demanderait aussitot une session de plus : le publisher tournerait en boucle. La premiere frame de la
session renouvelee porte le bit de discontinuite, parce qu'un encodeur qui redemarre a bien perdu de
l'audio. Une session creee par une reconnexion ne pose pas ce bit : son `stream_state` impose deja la
remise a zero du player.

## Quand le lien ne suit plus, c'est l'audio le plus ancien qui part

Le publisher ne remet plus ses frames a la socket des qu'il les recoit. Elles passent par une file a
lui, bornee a 500 ms d'audio, et une **fenetre d'envoi** limite a quatre le nombre de frames confiees
au systeme sans accuse de reception.

Cette indirection existe pour une seule raison : pouvoir choisir *quoi* jeter. La version precedente
lisait `bufferedAmount` et abandonnait, au-dela de 8192 octets, **la frame qui venait d'etre
encodee** — en gardant les anciennes. C'est le bon reflexe pour un fichier et le mauvais pour un
direct : le son garde etait deja perime au moment ou il partait. Le journal du 6 aout 2026 en montre
le prix, un trou de 2920 ms d'un seul tenant, le pire evenement du direct sain de la soiree. La file
fait desormais l'inverse : la frame qui arrive est toujours acceptee, et c'est le vieux fond de file
qui part.

La fenetre d'envoi est ce qui donne son sens a la file. Node n'expose aucun reglage de la taille du
tampon d'envoi du noyau : sans elle, une seconde d'audio s'empilerait la, invisible et hors de
portee, et la file applicative resterait vide pendant que le retard grandit. En n'en confiant que
quelques-unes a la fois, le retard s'accumule la ou on peut le voir et decider.

Quatre trames font 160 ms. Sur un lien sain le rappel d'ecriture revient en moins d'une milliseconde
et cette fenetre n'est jamais atteinte : elle ne coute rien tant que rien ne va mal.

Une demi-seconde de file, enfin, parce que le player la rattrape maintenant sans coupure — son seuil
monte jusqu'a deux secondes quand le lien le demande — alors qu'un abandon, lui, est definitif.

Le regulateur de debit y gagne au passage. Il lit l'age de la plus vieille frame qui attend quelque
part, et cette duree commence maintenant a croitre des que la fenetre d'envoi se ferme, la ou
l'ancienne mesure ne voyait rien tant que le tampon du noyau n'etait pas plein — et sautait alors
d'un coup a plusieurs centaines de millisecondes.

Une frame que l'en-tete public ne peut pas porter est traitee de la meme facon : elle est comptee
comme perdue et la suivante porte le bit de discontinuite. Ce refus arrive avant l'entree dans la
session : une frame refusee apres coup aurait deja ancre la chronologie, et le premier paquet
reellement transmis ne partirait ni de la sequence zero ni du timestamp zero. Un filet plus large
entoure quand meme la construction du paquet, parce que le pont remet ses frames depuis un evenement
de socket : une exception y deviendrait une erreur non capturee et arreterait tout le processus Node.

## Le token ne sort jamais

- Le token n'apparait que dans le message `publisher_auth`, jamais dans l'URL.
- Aucun fichier du device n'ecrit dans la console ni dans la Max Console ; un test le verifie sur
  tous les fichiers du dossier `device/node`.
- Les erreurs de configuration sont des codes courts : `config_absente`, `config_token_absent`,
  `config_url_non_chiffree`.
- Les raisons venues du relais sont nettoyees avant affichage et limitees a 64 caracteres.
- `describeConfig()` sert a l'affichage et ne renvoie que l'URL et un etat.

## Messages Max

Entrees acceptees par `node.script` :

| Message | Effet |
|---|---|
| `live 1` / `live 0` | lance ou arrete le live |
| `quality 0..2` | Stable 128, Haute 192, Studio 256 pour le prochain live |
| `latency 0..3` | Faible, Equilibree, Stable, Longue pour le prochain live |
| `config` | renvoie l'etat de la configuration, sans le token |
| `stats` | renvoie les compteurs du pont et du publisher |
| `reset` | remet les compteurs a zero |
| `getport` | reannonce le port loopback |

Sorties :

| Sortie | Sens |
|---|---|
| `port <numero>` | port loopback annonce a l'objet natif |
| `status <etat> <detail>` | etat du pont loopback, deja lu par le device du bloc 5 |
| `publisher <etat> <detail>` | etat de la connexion au relais |
| `encoder start` / `encoder stop` | commande de l'objet natif, decidee par le publisher |
| `stats` et `publisher-stats` | compteurs de diagnostic |
| `selection <bitrate> <profil>` | valeurs retenues pour le prochain live |

L'etat du relais sort sur le mot `publisher` et non sur `status` : le device du bloc 5 lit deja
`status` pour le pont loopback, et les deux etats doivent rester lisibles separement.

Le cablage de ces messages dans l'interface du device appartient au bloc 10.

## Limites connues

Le publisher ne verifie pas le certificat au-dela du comportement par defaut de Node. Un relais avec
un certificat auto-signe demanderait une option explicite, qui n'est pas ajoutee tant qu'elle n'est
pas necessaire.

Le changement de qualite ou de latence ne prend effet qu'au live suivant, conformement au perimetre
fige de la version 1.
