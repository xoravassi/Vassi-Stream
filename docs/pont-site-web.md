# Le pont entre ce projet et le site web

Ce document explique comment le moteur audio du navigateur, ecrit ici, arrive dans le site
`vassi.click`. Il s'adresse a quiconque ouvre l'un des deux depots sans connaitre l'autre.

## En une phrase

Le moteur vit **ici**, dans `src/player/` et `src/protocol/`. Une commande le recopie dans le
depot du site, et une autre verifie que les deux copies sont identiques.

```
vassi-stream/  (ce depot — la source)          vassi.click/  (le site — une copie)
  src/player/*.ts .js .d.ts                      frontend/src/lib/vassi-stream/
  src/protocol/audio-packet.ts    ─── copie ──►    player/
                                                   protocol/
  npm run player:sync    copie                     README.md      (ecrit par la copie)
  npm run player:check   compare                   manifest.json  (ecrit par la copie)
```

## Les deux commandes

| Commande | Ce qu'elle fait |
|---|---|
| `npm run player:sync` | recopie le moteur vers le site, octet pour octet |
| `npm run player:check` | compare les deux copies, echoue en disant quel fichier differe |

`player:check` fait partie de `npm run check`. C'est le point important : la verification lancee a
chaque etape du projet echoue si la copie du site a pris du retard. Une divergence ne peut donc pas
passer inapercue jusqu'a la production.

Sur une machine ou le depot du site n'est pas installe, `player:check` le dit et reussit :
`npm run check` reste utilisable partout.

## Comment modifier le moteur

1. Modifier le code **ici**, dans `src/player/` ou `src/protocol/`.
2. `npm run check` — les tests du moteur vivent ici.
3. `npm run player:sync`.
4. Committer **les deux depots**. La copie fait partie du site.

Ne jamais editer les fichiers dans `frontend/src/lib/vassi-stream/` : la copie suivante les ecrase.
Un `README.md` le rappelle sur place.

## Ou les deux depots doivent se trouver

Cote a cote dans le meme dossier parent :

```
un-dossier/
  vassi-stream/
  vassi.click/
```

`player:sync` s'arrete avec un message clair si le site n'est pas la, plutot que de creer un dossier
au mauvais endroit.

## Pourquoi une copie, et pas une dependance npm ou un sous-module git

Le site se construit **depuis son seul dossier `frontend/`**. C'est visible dans `deploy.sh`
(`cd /var/www/vassi.click/frontend && npm run build`) et dans `frontend/Dockerfile`
(`COPY . .` depuis ce dossier). Rien d'exterieur a `frontend/` n'existe au moment du build, donc le
moteur doit s'y trouver physiquement. Restaient trois facons de l'y mettre.

**Un sous-module git** aurait donne une source unique reelle, sans copie, avec le commit du site
epinglant le commit du moteur. Il a ete ecarte pour une raison de deploiement : Sliplane clone le
depot pour construire le site, et `git clone` n'initialise pas les sous-modules par defaut. Si le
constructeur ne lance pas `git submodule update --init`, le dossier est vide et le build echoue sur
un message qui ne dit pas pourquoi. Cela aurait ajoute un point de panne dans la seule partie de la
chaine qui fonctionne deja.

**Un paquet npm** est la bonne reponse le jour ou un deuxieme projet consomme ce moteur. Aujourd'hui
il n'y en a qu'un. Publier demanderait d'ajouter une etape de build a un code concu pour etre efface
directement, de decider comment le worker et le worklet voyagent dans `node_modules`, puis de
publier une version **a chaque correction du moteur** — c'est-a-dire pendant les blocs 10 et 11, les
deux moments ou il bouge encore.

**La copie verifiee** ne touche pas la chaine de deploiement, garde le site autonome et lisible, et
n'a besoin d'aucun reseau au moment du build. Son seul defaut, la duplication, est aussi le seul des
trois qu'une commande automatique peut surveiller.

## Ce que la copie garantit

Le script est ecrit pour que les erreurs previsibles soient impossibles plutot que rares.

- **La liste des fichiers est lue sur le disque**, jamais ecrite en dur. Ajouter un module au moteur
  suffit a le faire voyager : il n'y a pas de seconde liste a tenir a jour, donc pas d'oubli.
- **Les dossiers sont effaces avant d'etre remplis.** Un module supprime du moteur disparait du site
  au lieu d'y rester et d'y etre compile.
- **Les empreintes portent sur les octets bruts.** Une fin de ligne changee par un editeur est une
  difference reelle, et elle se voit.
- **Les deux dossiers gardent leurs noms.** Le decodeur importe `../protocol/audio-packet.ts` : les
  laisser cote a cote garde cet import valide sans toucher une ligne du moteur.
- **Le manifeste n'est reecrit que si le contenu change.** Une copie qui ne change rien ne produit
  aucune difference dans git.

`tests/player-sync.test.ts` couvre chacun de ces points, plus le cas qui compte le plus : un seul
octet different entre les deux copies doit faire echouer la verification.

## Ce que le site a du ajouter de son cote

Deux lignes, et rien d'autre dans les fichiers existants.

| Fichier | Ligne ajoutee | Pourquoi |
|---|---|---|
| `frontend/tsconfig.json` | `"allowImportingTsExtensions": true` | le moteur importe ses modules avec l'extension `.ts` |
| `frontend/package.json` | `"opus-decoder": "0.7.11"` | le decodeur Opus/WASM, en version exacte |

Le reste est constitue de fichiers nouveaux : la copie du moteur et la page `src/routes/session/`.

## La page qui utilise le moteur

`frontend/src/routes/session/`, servie a l'adresse `/session`. Sa cheat sheet est dans le depot du
site, dans ce meme dossier. La conception du moteur lui-meme reste dans `docs/player-web.md`.
