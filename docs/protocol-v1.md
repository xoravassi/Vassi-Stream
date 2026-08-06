# Protocole Vassi Stream v1

## But

Ce document fixe le format commun entre le device Max for Live, le relais Node.js et la page `/live`.

Le protocole separe deux types de messages :
- messages JSON pour l'etat, l'authentification et le controle du live ;
- messages binaires pour les paquets audio Opus.

Le relais ne decode pas l'audio. Il valide seulement le paquet binaire, puis il diffuse les memes octets aux listeners.

## Connexions

### Publisher

Le device Max for Live ouvre une connexion WebSocket vers :

```text
wss://<domaine-relai>/publisher
```

Apres ouverture, le publisher envoie un message JSON `publisher_auth`. Le relais ferme une connexion publisher qui n'a pas presente de token valide dans les cinq secondes.

Un seul publisher est en direct a la fois. Une connexion qui presente un token valide prend la place de la precedente : celle-ci recoit `server_error` avec la raison `publisher_replaced`, puis une fermeture normale, et sa session est fermee. Cette regle evite qu'une connexion morte, pas encore detectee par le relais, empeche un nouveau live.

Quand l'authentification est acceptee, le publisher envoie :
1. `stream_start` ;
2. les paquets audio binaires ;
3. `stream_stop` quand le live s'arrete.

Le relais accepte les paquets audio seulement apres un `stream_start` valide. Il diffuse le `stream_state` de la nouvelle session aux listeners avant de diffuser son premier paquet audio.

### Listener

La page `/live` ouvre une connexion WebSocket vers :

```text
wss://<domaine-relai>/listener
```

Le serveur envoie immediatement un message `stream_state` apres la connexion du listener, avant tout paquet audio destine a ce listener.

Chaque nouvelle session produit un nouveau `stream_state`, meme si le serveur passe directement d'une session `live: true` a une autre session `live: true`.

Un listener n'envoie jamais rien. Le relais ferme une connexion listener qui envoie un message, avec le code de fermeture `1003`.

Le relais abandonne des paquets destines a un listener qui n'arrive pas a les recevoir assez vite, et ferme la connexion d'un listener bloque. Un listener peut donc voir un trou dans les numeros de sequence sans qu'aucun bit de discontinuite soit pose : le relais ne modifie pas les octets d'un paquet. Le player traite un numero de sequence manquant comme une discontinuite.

### Ping serveur

Le serveur envoie une trame de controle WebSocket Ping toutes les 20 secondes. Ce ping utilise l'opcode WebSocket `0x9` et n'est pas un message JSON du protocole Vassi Stream.

## Regles JSON communes

Tous les messages JSON contiennent :

```json
{
  "type": "nom_du_message",
  "protocolVersion": 1
}
```

Un message qui ne contient pas `protocolVersion: 1` est refuse.

Les champs numeriques decrits comme des entiers JSON ne contiennent aucune partie decimale. Le relais refuse un type JSON incorrect, une valeur hors plage ou un champ obligatoire absent.

## Messages JSON

### publisher_auth

Le publisher envoie ce message juste apres l'ouverture WebSocket.

```json
{
  "type": "publisher_auth",
  "protocolVersion": 1,
  "token": "valeur_secrete"
}
```

Le token ne doit jamais etre envoye a un listener, affiche dans le navigateur ou ecrit dans les logs.

### auth_ok

Le serveur repond avec ce message quand le token est accepte.

```json
{
  "type": "auth_ok",
  "protocolVersion": 1
}
```

### auth_error

Le serveur repond avec ce message quand le token est absent ou refuse.

```json
{
  "type": "auth_error",
  "protocolVersion": 1,
  "reason": "invalid_token"
}
```

La connexion publisher est fermee apres `auth_error`.

### stream_start

Le publisher envoie ce message avant le premier paquet audio binaire d'une session.

```json
{
  "type": "stream_start",
  "protocolVersion": 1,
  "sessionId": 123456789,
  "codec": "opus",
  "bitrate": 256000,
  "sampleRate": 48000,
  "channels": 2,
  "frameDurationMs": 20,
  "latencyProfile": "balanced"
}
```

Valeurs autorisees :
- `codec` : `opus` ;
- `bitrate` : `128000`, `192000` ou `256000` ;
- `sampleRate` : `48000` ;
- `channels` : `2` ;
- `frameDurationMs` : `20` ;
- `latencyProfile` : `low`, `balanced` ou `stable`.

Le profil de latence fixe le niveau de PCM que le player attend avant de lancer ou relancer la lecture :

| `latencyProfile` | Buffer cible |
|---|---:|
| `low` | 200 ms |
| `balanced` | 400 ms |
| `stable` | 800 ms |

Le nom du profil transporte donc une valeur normative. Le player ne choisit pas un autre seuil pour un meme nom. Ce buffer cible n'est pas une garantie de latence totale : le temps d'encodage, le reseau et la sortie audio du navigateur s'y ajoutent.

### stream_stop

Le publisher envoie ce message quand le live s'arrete proprement.

```json
{
  "type": "stream_stop",
  "protocolVersion": 1,
  "sessionId": 123456789,
  "reason": "user_stop"
}
```

Raisons autorisees :
- `user_stop` ;
- `error`.

`stream_stop` vient uniquement du publisher. Si sa connexion disparait sans ce message, le relais ferme la session et envoie directement `stream_state` avec `live: false` aux listeners encore connectes.

Apres un `stream_stop` valide, le relais verifie que son `sessionId` correspond a la session active, ferme cette session, supprime sa configuration et diffuse `stream_state` avec `live: false`. Un `stream_stop` qui vise une autre session est refuse.

### stream_state

Le serveur envoie ce message aux listeners quand l'etat change et juste apres leur connexion.

Etat hors ligne :

```json
{
  "type": "stream_state",
  "protocolVersion": 1,
  "live": false
}
```

Etat en direct :

```json
{
  "type": "stream_state",
  "protocolVersion": 1,
  "live": true,
  "sessionId": 123456789,
  "codec": "opus",
  "bitrate": 256000,
  "sampleRate": 48000,
  "channels": 2,
  "frameDurationMs": 20,
  "latencyProfile": "balanced"
}
```

### server_error

Le serveur envoie ce message quand il refuse une action ou detecte une erreur recuperable.

```json
{
  "type": "server_error",
  "protocolVersion": 1,
  "reason": "invalid_packet"
}
```

Raisons utilisees par le relais, et effet sur la connexion :

| `reason` | Sens | Connexion |
|---|---|---|
| `auth_timeout` | aucun token dans les cinq secondes | fermee |
| `not_authenticated` | audio ou `stream_start` avant le token | fermee |
| `invalid_json`, `missing_type`, `unsupported_protocol_version` | message hors protocole | fermee |
| `invalid_session_id`, `invalid_codec`, `invalid_bitrate`, `invalid_sample_rate`, `invalid_channels`, `invalid_frame_duration`, `invalid_latency_profile` | `stream_start` hors des valeurs v1 | fermee |
| `invalid_stop_reason` | `stream_stop` hors des raisons autorisees | fermee |
| `publisher_replaced` | un autre publisher authentifie a pris la place | fermee |
| `no_active_session` | paquet audio recu avant `stream_start` | gardee |
| `invalid_packet` | paquet audio mal forme | gardee |
| `session_mismatch` | paquet audio d'une autre session | gardee |
| `unknown_session` | `stream_stop` visant une autre session | gardee |
| `already_authenticated`, `unsupported_message` | message sans effet a ce moment | gardee |

Un paquet abime ne ferme pas la connexion : il ne doit pas interrompre un live en cours. Une faute qui laisse le flux dans un etat inconnu la ferme.

Le relais envoie au plus un `server_error` par seconde et par connexion. Un publisher qui envoie cinquante paquets invalides par seconde ne recoit donc pas cinquante reponses par seconde.

`auth_error` est reserve au token refuse. Une authentification trop lente ou un message mal forme donnent `server_error` : le publisher traite un token refuse comme une panne definitive, alors que les autres cas doivent rester des coupures ordinaires suivies d'une reconnexion.

## Nouvelle session apres reconnexion

`sessionId` est un entier non signe de 32 bits compris entre `1` et `4294967295`. La valeur `0` reste invalide afin qu'une valeur non initialisee ne puisse pas identifier une session.

Le publisher genere le `sessionId` avec quatre octets aleatoires fournis par une API cryptographique. Il recommence si le resultat vaut `0` ou s'il est identique a la session precedente.

Chaque nouveau live cree un nouveau `sessionId`.

Une reconnexion publisher cree aussi un nouveau `sessionId`, meme si elle arrive juste apres une coupure reseau. Cette regle permet aux listeners de jeter les anciens paquets sans deviner si le flux precedent continue.

Le meme `sessionId` apparait dans `stream_start`, dans tous les paquets binaires, dans le `stream_state` en direct et dans `stream_stop`. Le relais refuse un paquet binaire dont le `sessionId` ne correspond pas a la session active. Le listener ignore egalement un paquet qui ne correspond pas a son dernier `stream_state` en direct.

Le `sequenceNumber` est un entier non signe de 32 bits. Il recommence a `0` et augmente de `1` pour chaque paquet construit dans la session. Un paquet abandonne apres avoir recu son numero cree donc un trou visible par le listener. Le publisher cree une nouvelle session avant de depasser `4294967295` ; le compteur ne revient jamais silencieusement a `0` dans la meme session.

Le timestamp est un entier non signe de 64 bits exprime en microsecondes. Il indique la position du premier echantillon du paquet sur la timeline audio 48 kHz de la session. Le premier paquet porte `0` et deux paquets consecutifs sans perte sont separes de `20000` microsecondes. Le timestamp ne diminue jamais. Une perte locale conserve le temps audio ecoule : le paquet suivant porte donc un timestamp plus grand que l'increment normal.

Le bit de discontinuite est pose uniquement sur le premier paquet transmis apres une perte ou un abandon local d'audio, par exemple apres un overflow de queue. Avant d'encoder ce paquet, le worker remet l'encodeur Opus a son etat initial avec `OPUS_RESET_STATE`. Une nouvelle session n'utilise pas ce bit pour annoncer son debut, car son nouveau `stream_state` impose deja la remise a zero. Les bits 1 a 7 restent a zero dans la version 1.

Quand le player recoit ce bit, il remet le decodeur Opus a son etat initial avec `OPUS_RESET_STATE`, comme l'encodeur l'a fait de son cote, puis decode le paquet marque.

Il ne vide pas le PCM en attente. La regle v1 le demandait, et la mesure du 2026-08-06 a montre qu'elle etait nuisible : vider n'avance pas la lecture, puisque le consommateur trouve alors la file vide et ecrit du silence jusqu'a la fin de la rebufferisation, pour retrouver exactement le meme retard qu'avant. Le vidage ne coute que du son deja decode, et sur un lien qui perd regulierement il efface la file plus vite qu'elle ne se remplit.

**Le player ecrit a la place la duree manquante**, mesuree par l'ecart de timestamp et non par l'ecart de numeros de sequence : une perte survenue avant la construction du paquet n'utilise aucun numero, alors qu'elle avance toujours le timestamp. Cette ecriture n'est pas un confort d'ecoute, c'est ce qui garde la chronologie juste : sans elle le trou disparaitrait de la timeline, le niveau de la file baisserait definitivement d'autant, et rien ne le ferait remonter puisque la production et la consommation tournent toutes deux a 48 kHz.

Au-dela de 500 millisecondes manquantes, le comblement s'arrete d'avoir un sens : le silence s'entendrait plus longtemps que la rebufferisation qu'il evite. Le player reprend alors l'ancien traitement — file videe, decodeur remis a zero, bufferisation jusqu'au seuil du profil actif.

La duree manquante est comblee par du silence. Une frame de dissimulation produite par le decodeur s'entendrait mieux, et rien dans ce protocole ne l'interdit : le choix appartient au player.

Un trou dans les numeros de sequence, sans bit de discontinuite, recoit le meme traitement a une exception pres : **le decodeur n'est pas remis a zero.** L'encodeur, lui, n'a rien remis a zero dans ce cas — il ignore que le relais a jete ces paquets — et effacer un etat encore aligne sur le sien allongerait l'artefact au lieu de l'ecourter.

La combinaison des deux signaux dit ou le son a disparu, ce qu'aucun des deux ne dit seul :

| Bit de discontinuite | Trou de sequence | Origine de la perte |
|---|---|---|
| pose | oui | le publisher a jete faute de lien montant : il consomme un numero sans envoyer |
| pose | non | l'encodeur ou le pont a perdu avant de construire le paquet |
| absent | oui | le relais a jete pour cet auditeur en retard |

## Paquet audio binaire

Les entiers multi-octets sont stockes en big-endian.

| Offset | Taille | Champ |
|---:|---:|---|
| 0 | 4 | magic ASCII `VSA1` |
| 4 | 1 | version `1` |
| 5 | 1 | codec Opus `1` |
| 6 | 1 | flags `uint8`, bit 0 = discontinuite, bits 1 a 7 = `0` |
| 7 | 1 | canaux `2` |
| 8 | 4 | `sessionId` `uint32`, de `1` a `4294967295` |
| 12 | 4 | `sequenceNumber` `uint32`, de `0` a `4294967295` |
| 16 | 8 | timestamp relatif `uint64` en microsecondes |
| 24 | 2 | nombre d'echantillons par canal : `960` |
| 26 | 2 | taille du payload : de `1` a `1276` octets |
| 28 | N | paquet Opus brut |

Le payload est la sortie directe de `opus_encode()` ou `opus_encode_float()` appele avec `frame_size = 960`. La v1 n'ajoute aucun padding et n'utilise aucun repacketizer. L'encodeur recoit un buffer de sortie de 1276 octets et toute erreur d'encodage empeche la creation du paquet Vassi Stream.

Taille totale minimale : 29 octets. Taille totale maximale : 1304 octets.

Le champ `payloadSize` doit etre exactement egal au nombre d'octets apres l'en-tete.

## Validation serveur minimale

Le serveur refuse un paquet binaire si :
- la taille disponible pour l'en-tete est inferieure a 28 octets ;
- le magic n'est pas `VSA1` ;
- la version n'est pas `1` ;
- le codec n'est pas Opus `1` ;
- un bit de flags reserve est different de `0` ;
- le nombre de canaux n'est pas `2` ;
- le `sessionId` vaut `0` ou ne correspond pas a la session active ;
- le nombre d'echantillons n'est pas `960` ;
- `payloadSize` est inferieur a `1` ou superieur a `1276` ;
- `payloadSize` ne correspond pas a la taille reelle du payload.

Un paquet refuse ne doit pas faire planter le serveur.

Cette validation est structurelle. Le relais ne decode toujours pas le payload pour verifier son contenu Opus.

## References techniques

- MDN `DataView.setUint32` : les valeurs multi-octets sont big-endian quand `littleEndian` est absent ou `false`.
- MDN `WebSocket.binaryType` : `arraybuffer` permet de recevoir des donnees binaires dans le navigateur et dans un Worker.
- Node.js `Buffer.from(arrayBuffer)` : Node peut exposer un `ArrayBuffer` sous forme de `Buffer` sans copie quand ce sera utile cote serveur.
- RFC 6716, section 3.4 : un paquet Opus contient au moins un octet et une frame implicite ne depasse pas 1275 octets.
- API libopus `opus_encode` : l'encodeur recoit exactement une frame et renvoie la taille du paquet produit.
- API libopus `OPUS_RESET_STATE` : l'encodeur et le decodeur retrouvent un etat equivalent a une nouvelle initialisation apres une discontinuite.
- RFC 6455, section 5.5.2 : une trame de controle Ping utilise l'opcode `0x9` et appelle une reponse Pong.
- Node.js 16 `crypto.randomBytes` : le publisher peut produire les quatre octets aleatoires du `sessionId` avec le moteur integre a Max.
