# Validation courte - Bloc 1

Date : 2026-08-02.

## Resultat

Le protocole v1 est specifie, controle statiquement et teste localement.

## Fichiers du bloc

- `docs/protocol-v1.md` fixe les connexions, les messages JSON, les profils de latence, les sessions et le paquet audio binaire.
- `src/protocol/audio-packet.ts` encode et decode l'en-tete binaire v1.
- `tests/audio-packet.test.ts` verifie les octets canoniques, les cas valides, les bornes et les refus.
- `tsconfig.json` active le controle TypeScript strict avec une cible ES2020.
- `package.json` et `package-lock.json` verrouillent les commandes et les outils de developpement.

## Recherche technique verifiee

Sources officielles consultees :

- RFC 6716 pour la structure, la taille minimale d'un paquet Opus et la limite de 1275 octets par frame : https://www.rfc-editor.org/info/rfc6716/
- API libopus pour l'appel d'encodage d'une frame et la taille effectivement retournee : https://www.opus-codec.org/docs/opus_api-1.6/group__opus__encoder.html
- API libopus pour la remise a zero de l'encodeur et du decodeur avec `OPUS_RESET_STATE` : https://opus-codec.org/docs/opus_api-1.5/group__opus__encoderctls.html
- RFC 6455 pour la trame de controle WebSocket Ping : https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5.2
- MDN `DataView.setUint32` pour le big-endian par defaut : https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/DataView/setUint32
- Node.js TypeScript pour la difference entre effacement des types et controle statique : https://nodejs.org/api/typescript.html
- Node.js test runner pour les motifs de fichiers de test : https://nodejs.org/api/test.html
- Node.js `Buffer` pour la difference de comportement entre `Buffer.slice` et `TypedArray.slice` : https://nodejs.org/api/buffer.html#buffers-and-typedarrays
- Node.js 16.6 `crypto.randomBytes` pour produire les identifiants de session : https://nodejs.org/download/release/v16.6.0/docs/api/crypto.html#crypto_crypto_randombytes_size_callback
- npm `package.json` pour declarer le moteur utilise par les commandes de developpement avec `devEngines` : https://docs.npmjs.com/cli/configuring-npm/package-json/#devengines

## Verification executee

Commande complete :

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 32
pass 32
fail 0
```

Commande de couverture :

```powershell
node --test --experimental-test-coverage "tests/**/*.test.ts"
```

Resultat pour `src/protocol/audio-packet.ts` :

```text
lines 100.00%
branches 100.00%
functions 100.00%
```

Verification du moteur integre a Max :

- le module est compile temporairement en JavaScript ES2020 CommonJS ;
- ce JavaScript est charge par le Node for Max local `v16.6.0` ;
- un paquet minimal est encode puis decode avec le resultat `node16_smoke_ok`.

## Points valides

- Deux vecteurs canoniques independants fixent les offsets, le magic et le big-endian dans les deux directions.
- Un paquet encode est relu avec les memes champs et les memes octets.
- Les valeurs maximales autorisees sont acceptees.
- Les entrees `ArrayBuffer`, `Uint8Array` avec offset et `Buffer` Node sont couvertes.
- Le payload retourne est une copie independante de la memoire d'entree.
- Un en-tete tronque, un champ fixe invalide, une session nulle et une taille incoherente sont refuses sans crash.
- Un payload vide, trop grand ou d'un type incorrect est refuse.
- Les bornes de session, sequence, timestamp et flags sont testees.
- Le JavaScript ES2020 produit a partir du module fonctionne dans le Node 16.6.0 integre a Max.
- `devEngines` refuse clairement les commandes de developpement avec un Node anterieur a 24.12.0.
- Les profils `low`, `balanced` et `stable` correspondent respectivement a des buffers cibles de 200, 400 et 800 ms, distincts de la latence totale.
- Le contrat impose une nouvelle session apres reconnexion et place son etat avant ses paquets ; cette orchestration sera testee avec le WebSocket des blocs suivants.

## Controle du bloc 0

- Les informations d'environnement restent presentes dans `docs/environment.md`.
- Le fichier audio stereo de test reste present dans `assets/audio/`.
- La lecture du fichier dans Ableton n'est pas reexecutee pendant cette review.

## Limites reportees aux blocs concernes

- Les tests TypeScript utilisent le Node systeme 24.18.0. Node for Max 16.6.0 ne charge pas directement les fichiers `.ts`.
- `tsconfig.json` controle une cible ES2020 sans produire de fichier. Le bloc 6 devra definir la compilation reproductible du publisher complet en JavaScript ; seul le module de protocole compile est teste ici dans Node for Max.
- Aucun vrai WebSocket n'est teste ici ; ce controle appartient aux blocs publisher et relais.
- Le relais ne decode pas Opus. La validation reelle du payload encode appartient au bloc 4.

## Decision

Le Bloc 1 est valide. Son contrat est suffisamment precis pour commencer les composants qui le consomment.
