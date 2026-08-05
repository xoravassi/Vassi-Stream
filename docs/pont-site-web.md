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

## La manipulation, en entier

C'est la seule chose a retenir de ce document. Elle est ecrite pour etre suivie sans rien savoir
d'autre, et l'ordre compte : **le commit du moteur vient avant la copie**, pour la raison expliquee
plus bas.

**1. Modifier et tester le moteur, dans `vassi-stream`.**

```powershell
# le code du moteur est dans src/player/ et src/protocol/
npm.cmd run check
```

**2. Committer le moteur, toujours dans `vassi-stream`.**

```powershell
git add -A
git commit -m "ce que le moteur fait maintenant"
git push
```

**3. Copier vers le site, toujours depuis `vassi-stream`.**

```powershell
npm.cmd run player:sync
```

La commande dit ce qu'elle a copie et quel commit elle a enregistre. Si elle affiche
`Le moteur n'est pas commite`, c'est l'etape 2 qui a ete sautee : commiter, puis relancer cette
commande.

**4. Committer le site, dans `vassi.click`.**

```powershell
git add -A
git commit -m "moteur audio a jour"
git push
```

**Ne jamais editer les fichiers dans `frontend/src/lib/vassi-stream/`** : la copie suivante les
ecrase sans prevenir. Un `README.md` le rappelle sur place, dans le dossier lui-meme.

### Si tout est oublie

Il n'y a rien a retenir par coeur. `npm run check` echoue tant que la copie du site est en retard,
et son message donne la commande a lancer. Le pire cas — copier avant de commiter — ne casse rien
non plus : le manifeste porte alors `+modifie`, et `player:check` rappelle a chaque passage qu'il
suffit de relancer `player:sync`.

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
- **Le manifeste n'est reecrit que si le contenu ou le commit change.** Une copie qui ne change rien
  ne produit aucune difference dans git.

`tests/player-sync.test.ts` couvre chacun de ces points, plus le cas qui compte le plus : un seul
octet different entre les deux copies doit faire echouer la verification.

## Pourquoi commiter avant de copier

Le champ `commit` du manifeste dit de quel commit sort la copie. C'est ce qui permet, en ouvrant le
site, de savoir quelle version du moteur il embarque.

Copier avant de commiter est le geste naturel, et il donnait un manifeste qui pointait sur le commit
**parent** : `player:sync` lit `HEAD`, et `HEAD` est encore le commit precedent tant que le nouveau
n'existe pas. Rien ne le disait, et resynchroniser apres coup ne corrigeait rien puisque les
empreintes, elles, n'avaient pas bouge.

Deux changements ferment ce piege. Le manifeste porte `<commit>+modifie` quand le moteur a des
changements pas encore commites : l'etiquette avoue alors son retard au lieu d'affirmer un faux.
Et il est reecrit quand ce seul champ change, donc relancer `player:sync` apres le commit pose le bon
nom sans recopier un octet ni bouger la date de copie. `player:check` signale un manifeste marque,
sans echouer : les fichiers sont bons, seule l'etiquette est en retard, et echouer la-dessus rendrait
`npm run check` rouge a chaque commit du depot, y compris ceux qui ne touchent pas au moteur.

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
