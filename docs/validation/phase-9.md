# Validation courte - Bloc 9

Date : 2026-08-05.

## Resultat

La page publique existe. Elle vit dans le depot du site, a la route `/session`, et n'affiche que ce
que le bloc demandait : un texte d'etat et un bouton. Aucun style n'est pose — le design est laisse
a Vassi.

Le moteur audio n'a pas ete duplique. Il reste dans ce depot et le site en garde une copie
automatique, produite par `npm.cmd run player:sync` et surveillee par `npm.cmd run player:check`.

## Fichiers du bloc

Dans ce depot :

- `scripts/sync-player.js` : copie le moteur vers le site, et compare les deux copies.
- `tests/player-sync.test.ts` : neuf tests sur cette copie.
- `docs/pont-site-web.md` : le pont entre les deux depots, explique en entier.

Dans le depot du site, `frontend/` :

- `src/lib/vassi-stream/` : la copie du moteur, quatorze fichiers, plus son `README.md` et son
  `manifest.json` d'empreintes.
- `src/routes/session/+page.ts` : `ssr = false`, `prerender = false`.
- `src/routes/session/+page.svelte` : l'assemblage.
- `src/routes/session/components/EtatDirect.svelte` : le texte d'etat.
- `src/routes/session/components/BoutonEcoute.svelte` : le bouton.
- `src/routes/session/utils/directState.svelte.ts` : le seul fichier qui parle au moteur.
- `src/routes/session/utils/etatsDirect.ts` : etat technique vers libelle francais.
- `src/routes/session/utils/relais.ts` : l'adresse du relais.
- `src/routes/session/README.md` : la cheat sheet de la page.

Deux fichiers existants du site ont change, et rien d'autre :

- `tsconfig.json` : `allowImportingTsExtensions` pour les imports en `.ts` du moteur, et `target`
  passe de `es2018` a `es2020` pour les litteraux `BigInt` du module de protocole.
- `package.json` : la dependance `opus-decoder` en `0.7.11` exact.

## Ce qui a ete mesure

- **Le relais deploye repond.** `npm.cmd run relay:check -- https://live.vassi.click` passe ses trois
  controles : route de sante, connexion listener reelle, et refus d'un publisher sans token valide,
  ferme avec le code 1008. Le relais ne verifie pas l'`Origin`, donc une page servie par
  `vassi.click` peut s'y connecter.
- **Le site compile.** `npx svelte-check` donne 0 erreur. Les deux avertissements restants sont ceux
  deja connus dans `AudioPlayer.svelte`, sans rapport avec ce bloc. `npm run build` passe.
- **Le worker de decodage est reellement construit.** Dans le build, il pese 96 503 octets, ne
  contient plus aucun import de nom de paquet, et porte les marqueurs de ses trois sources :
  `OpusDecoder`, `WebAssembly`, la file PCM et le magic `VSA1` du protocole.
- **Le processeur audio est livre tel quel.** Le fichier emis est identique octet pour octet a la
  source, et contient bien son `registerProcessor`.
- **La page reference les deux.** Le morceau de code de `/session` pointe sur le worker et sur le
  processeur audio emis.
- **Aucun secret dans le navigateur.** La seule adresse presente dans tout le build client est
  `wss://live.vassi.click/listener`. Le mot `publisher` n'apparait dans aucun fichier livre.
- **La route existe.** Le serveur construit rend 200 sur `/session` et 404 sur une adresse inconnue.
  Les pages existantes du site repondent toujours.
- **La copie du moteur est surveillee.** Un octet change d'un cote fait echouer
  `npm.cmd run player:check` avec le code de sortie 1, en nommant le fichier fautif.
- **Le projet entier tient.** `npm.cmd run check` donne 321 tests, 0 echec.

## Une correction trouvee en verifiant

La premiere version passait au moteur l'adresse du worker de decodage, obtenue par `?worker&url`.
Le build de production etait correct, et la verification aurait pu s'arreter la.

Servi en developpement, ce meme fichier revient brut : 11 254 octets, exactement la taille de la
source, avec son `import { OpusDecoder } from "opus-decoder"` intact. Un navigateur ne sait pas
resoudre ce nom, donc le worker serait mort a sa premiere ligne, et le son ne serait jamais sorti —
sans qu'aucun test ni aucune compilation ne le signale.

La forme `?worker` ne souffre pas de ce defaut : elle rend une classe, et le fichier vise est
transforme dans les deux modes. Le moteur recoit donc maintenant une fabrique, `createWorker: () =>
Worker`, au lieu d'une adresse. Le type `PlayerUrls` devient `PlayerSetup`, qui decrit mieux ce
qu'il porte.

Le raisonnement complet est dans `docs/player-web.md`, section « Pourquoi le worker arrive par une
fabrique et non par une adresse ».

## Decisions du bloc

- **La copie plutot qu'un sous-module ou un paquet npm.** Le site se construit depuis son seul
  dossier `frontend/`, donc le moteur doit s'y trouver. Un sous-module aurait casse le build sur
  Sliplane, qui clone sans initialiser les sous-modules. Un paquet npm aurait demande une
  publication a chaque correction du moteur, pendant les blocs ou il bouge encore. Detail dans
  `docs/pont-site-web.md`.
- **Pas d'en-tetes COOP/COEP.** Ils casseraient les scripts umami et les images de `api.vassi.click`
  sur tout le site. Le mode sans `SharedArrayBuffer` est deja valide sous charge reelle au bloc 8b.
- **La route s'appelle `/session`.** L'adresse `live.vassi.click/session` demande une regle de
  routage encore a poser : ce domaine pointe aujourd'hui sur le relais, pas sur le site. Cette regle
  ne change aucune ligne de la page.

## Ce qui reste

Trois des quatre verifications courtes du bloc demandent un navigateur et le device en marche :

- sans publisher, la page affiche Hors ligne ;
- avec publisher, elle affiche Pret puis Lecture apres un clic ;
- le bouton Pause coupe reellement le son.

La quatrieme, l'absence de token dans le bundle, est faite.

La page n'est listee dans aucun menu, par choix : on y accede par son adresse.

Le lecteur de musique du site reste monte sur cette page, comme sur toutes les autres. Rien
n'empeche aujourd'hui un visiteur de lancer une musique pendant le direct : les deux sons se
superposeraient. Hors perimetre de ce bloc, a decider avec Vassi.
