# Validation courte - Bloc 6

Date : 2026-08-03.

## Resultat

Le cote Node du device ouvre la connexion WSS vers le relais, authentifie le publisher, ouvre une
session, envoie les paquets binaires v1 et remonte un etat lisible a Max. La conception complete est
dans `docs/publisher-node.md`.

## Fichiers du bloc

- `device/node/publisher-config.js` : configuration persistante hors depot.
- `device/node/publisher-protocol.js` : messages JSON v1 et en-tete binaire v1.
- `device/node/publisher-backoff.js` : paliers de reconnexion avec jitter.
- `device/node/publisher.js` : machine a etats et connexion WebSocket.
- `device/node/index.js` : cablage du pont loopback, du publisher et des messages Max.
- `scripts/set-publisher-config.js` : ecriture de l'URL et du token sans les afficher.
- `tests/fake-relay.ts` : faux relais minimal utilise par les tests.

## Recherche Internet

- `ws`, bibliotheque WebSocket Node : https://www.npmjs.com/package/ws
- `bufferedAmount`, octets en attente d'envoi : https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount
- Module `max-api` de Node for Max : https://docs.cycling74.com/nodeformax/api/module-max-api.html

Decisions :

- `ws@8.21.1` epingle exactement. Son champ `engines` demande Node 10 ou plus, ce qui couvre le
  Node 16 embarque dans Max 8. La meme version exacte est declaree a la racine pour les tests, et un
  test refuse toute divergence entre les deux manifestes.
- `max-api` n'est pas installe : Node for Max le fournit par `NODE_PATH` au demarrage du script.
- `perMessageDeflate` desactive : compresser de l'Opus deja compresse couterait du temps sans gain.

## Verification executee

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 105
pass 105
fail 0
OK: tous les tests natifs de la queue audio passent
OK: tous les tests natifs Opus passent
OK: tous les tests natifs du pont loopback passent
```

La suite complete a ete lancee trois fois de suite sans echec, pour verifier que les tests reseau ne
dependent pas du rythme de la machine.

## Verifications courtes de la roadmap

1. **Un faux serveur accepte le token puis recoit `stream_start` et une frame valide.**
   Test `authentifie le publisher puis envoie stream_start et une frame valide`. Le faux relais voit
   exactement `publisher_auth`, puis `stream_start`, puis un paquet binaire. Le paquet est relu par
   `src/protocol/audio-packet.ts` : `sessionId`, sequence, timestamp et flags sont conformes, et le
   payload est identique octet pour octet a celui de l'encodeur.

2. **Un mauvais token donne une erreur lisible sans exposer le token.**
   Test `refuse un mauvais token sans exposer le token`. L'etat devient `ERROR` avec le detail
   `token refuse par le relais (invalid_token)`. Aucun etat publie ne contient le token refuse ni le
   token attendu. L'encodeur n'a jamais demarre et aucune seconde connexion n'est tentee.

3. **Une coupure du faux serveur declenche une reconnexion et un nouveau `sessionId`.**
   Test `reconnecte apres une coupure et cree une nouvelle session`. Apres la coupure, l'ordre
   observe est `encoder start`, `encoder stop`, `encoder start` : l'encodeur s'arrete avant la
   reconnexion. Le second `stream_start` porte un `sessionId` different et la premiere frame de la
   nouvelle session repart de la sequence zero.

## Autres tests ajoutes

- Egalite octet pour octet entre l'encodeur d'en-tete du device et le module TypeScript de reference.
- Conservation des trous de sequence et de l'avance des timestamps a travers le rebasage de session.
- Nouvelle session ouverte quand l'objet natif repart de zero au milieu d'un live, sans relancer
  l'encodeur. Ce point vient d'une relecture du code : la premiere version relancait l'encodeur, ce
  qui remettait sa numerotation a zero et demandait aussitot une session de plus, sans fin.
- `stream_stop` recu par le relais avant la fermeture, avec la bonne raison et le bon `sessionId`.
- Frames recues hors session jetees au lieu d'etre envoyees.
- Frame abandonnee quand `bufferedAmount` depasse la limite, et bit de discontinuite pose sur la
  frame suivante.
- Configuration : aller-retour, refus d'une adresse en clair distante, refus d'un contenu incomplet,
  description sans token.
- Paliers de reconnexion exacts et jitter borne.
- Aucun fichier du device n'ecrit dans la console, et le token n'est lu que par le message
  d'authentification.
- Reponse d'authentification repetee ignoree pendant un live.
- Connexion gardee vivante par le seul ping du publisher, face a un relais qui n'en envoie aucun.
- Paliers qui montent quand le relais coupe juste apres l'authentification, et qui repartent de zero
  apres une connexion stable.
- Un seul `encoder stop` et un seul `STOPPED` par arret.
- Frame impossible a encoder jetee sans couper le live, avec discontinuite sur la suivante.

## Revue de robustesse

Une relecture ciblee du bloc a trouve six defauts. Tous sont corriges, et chaque correctif est
verrouille par un test qui echoue si le correctif est retire.

1. **Le script ne s'arretait plus.** `index.js` ajoutait un gestionnaire `SIGTERM` et `SIGINT` qui
   se contentait d'appeler `publisher.stop()`. Ajouter un gestionnaire remplace l'arret par defaut
   de Node : le port loopback gardait la boucle d'evenements vivante, et Max aurait du tuer le
   script a chaque fermeture. L'arret ferme maintenant la session, puis le pont, puis le processus.

2. **Un `auth_ok` repete relancait tout.** Une reponse d'authentification recue pendant un live
   ouvrait une session de plus et redemarrait l'objet natif. Ces reponses ne sont plus acceptees
   que dans la fenetre qui suit `publisher_auth`.

3. **Reconnexion en boucle a la seconde.** Le compteur de paliers repartait de zero a chaque
   session ouverte. Un relais qui accepte le token puis coupe aussitot etait donc rappele toutes
   les secondes sans fin. Il ne repart de zero qu'apres 30 secondes de direct.

4. **Detection de liaison morte dependante du relais.** Seul le ping du relais repoussait le compte
   a rebours du silence. Un relais joignable mais muet aurait laisse le device afficher `LIVE` sans
   qu'un octet arrive aux listeners. Le publisher envoie son propre ping toutes les 15 secondes.

5. **Double annonce d'arret.** Apres `stop()`, la fermeture de la connexion arrivait plus tard et
   publiait un second `encoder stop` et un second `STOPPED`. La connexion est detachee a l'arret.

6. **Une frame invalide pouvait arreter Node.** L'encodage de l'en-tete public pouvait lever une
   exception depuis un evenement de socket. Une telle frame est refusee avant d'entrer dans la
   session, comptee comme perdue, et la suivante porte le bit de discontinuite. Refuser avant
   l'entree compte : une frame refusee apres coup aurait deja ancre la chronologie de la session,
   et le premier paquet transmis ne serait pas parti de zero.

Un durcissement s'y ajoute, sans defaut observe : le fichier de configuration est ecrit en `0600`
dans un dossier `0700` sur macOS et Linux, parce qu'il contient le token de publication.

## Bloc precedent

Le device du bloc 5 continue de fonctionner sans modification : `index.js` garde les sorties `status`,
`port` et `stats` lues par `patchers/vassi.encoder.bridge-test.maxpat`. L'etat du relais sort sur le
mot `publisher`, distinct de `status`. Un test verrouille cette compatibilite.

## Limites reportees

- Le relais n'existe pas encore : la verification passe par un faux relais. Le vrai echange est
  verifie au bloc 7.
- Le cablage des messages `live`, `quality` et `latency` dans l'interface du device appartient au
  bloc 10. Aucune interface ne les envoie aujourd'hui.
- Le `stream_stop` envoye a l'arret depend d'une connexion encore ouverte. Un arret pendant une
  coupure reseau ne peut pas l'envoyer ; le relais traitera la disparition de la connexion, comme le
  prevoit `docs/protocol-v1.md`.

## Decision

Le Bloc 6 est valide sur ses trois verifications courtes.
