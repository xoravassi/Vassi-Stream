# Partager le device a quelqu'un d'autre

Ce document est un plan de travail, pas une marche a suivre. Il dit ce qu'il faut construire pour
qu'une autre personne — le professeur — puisse installer le device sur son Ableton et diffuser sur
`live.vassi.click`, et dans quel ordre.

L'installation elle-meme, une fois ce travail fait, restera decrite dans
[`INSTALLATION.md`](../INSTALLATION.md).

---

## Ce qui bloque aujourd'hui

Le device fonctionne, mais il a ete construit pour une seule personne sur une seule machine. Quatre
choses s'y opposent, et elles ne se valent pas.

| # | Blocage | Ou | Gravite |
|---|---|---|---|
| 1 | L'encodeur n'existe qu'en Windows 64 bits | `device/vassi.encoder~.mxe64`, sans `.mxo` | **redhibitoire sur Mac** |
| 2 | Le relais n'accepte qu'un seul token | [relay/config.ts:21](../relay/config.ts#L21) | forte |
| 3 | Un seul publisher a la fois | [relay/publisher-connection.ts:99](../relay/publisher-connection.ts#L99) | moyenne |
| 4 | L'installation exige le depot complet et Node | [install-device.ps1:104](../install-device.ps1#L104) | moyenne |

### 1. L'encodeur est un binaire Windows

`vassi.encoder~` est un external Max compile pour Windows. Il n'existe pas en version macOS, et
[`scripts/build-vassi-encoder.cmd`](../scripts/build-vassi-encoder.cmd) est un script Windows.

**C'est la premiere question a poser, avant toute autre chose : le professeur est-il sur Windows ou
sur Mac ?** Sur Mac, rien du reste de ce plan ne sert : il faudrait compiler un `.mxo`, sur un Mac,
avec le SDK Max — c'est un chantier entier, pas une adaptation.

### 2. Le relais n'accepte qu'un seul token

`readRelayConfig` lit une seule valeur dans `VASSI_PUBLISHER_TOKEN` et la compare a ce que le
publisher presente. Donner ce token au professeur a trois consequences, toutes mauvaises :

- il obtient exactement les memes droits que vous, sans distinction possible ;
- on ne peut pas le lui retirer sans changer le token de tout le monde, donc sans casser votre propre
  installation le meme jour ;
- les journaux ne diront jamais lequel des deux a diffuse.

C'est le vrai sujet de ce plan. Le reste est de l'emballage.

### 3. Un seul publisher a la fois

Un nouveau publisher authentifie remplace le precedent — c'est un choix delibere de la roadmap, qui
evite qu'une connexion fantome bloque un direct. Mais a deux, cela veut dire qu'un direct lance
pendant celui de l'autre coupe l'autre, sans que personne ne comprenne pourquoi.

Ce n'est pas grave si vous vous parlez. Ca le devient si le professeur lance un essai pendant votre
direct.

### 4. L'installation exige le depot et Node

`install-device.ps1` appelle `node scripts/install-device.js`. Le professeur devrait donc cloner le
depot complet, installer Node, et autoriser l'execution de scripts PowerShell — trois occasions
d'abandonner avant d'avoir vu le device.

---

## Le plan, en quatre etapes

Les etapes sont dans l'ordre des dependances. Chacune est utile seule.

### Etape 0 — Verifier la machine du professeur *(10 minutes, lui)*

Avant d'ecrire une ligne de code, obtenir trois reponses :

- **Windows ou macOS ?** Sur macOS, arreter ici et decider si le port vaut le chantier.
- **Quelle version de Live**, et Live embarque-t-il Max for Live ? (Suite ou Standard + M4L.)
- **Quel debit montant** a l'endroit ou il jouera. C'est ce qui decidera de la qualite et du profil
  de latence — le nouveau profil « Longue 1500 ms » existe pour les liens qui bloquent longtemps.

### Etape 1 — Des tokens nommes et revocables *(une demi-journee)*

C'est l'etape qui rend le partage sain. Elle est petite et bien delimitee.

**Changer** `VASSI_PUBLISHER_TOKEN` pour qu'il accepte une liste de couples `nom:token`, separes par
des virgules :

```
VASSI_PUBLISHER_TOKEN=vassi:a1b2...,prof:c3d4...
```

Les fichiers a toucher :

- [`relay/config.ts`](../relay/config.ts) — lire la liste, garder la longueur minimale de 32
  caracteres par token, et accepter la forme sans nom pour ne rien casser d'existant ;
- [`relay/token.ts`](../relay/token.ts) — comparer contre chaque token de la liste, toujours en temps
  constant, et rendre le nom trouve plutot qu'un booleen ;
- [`relay/publisher-connection.ts`](../relay/publisher-connection.ts) — garder le nom du publisher
  authentifie et le poser dans les evenements de journal ;
- [`relay/server.ts`](../relay/server.ts) — ajouter ce nom a la route `/health`, a cote de `live`.

Ce qu'on y gagne, concretement : le professeur a son propre token, vous pouvez le supprimer d'un
redeploiement sans toucher au votre, et `/health` repond enfin a « qui est en direct la ».

**Ne pas** faire de cette etape une gestion de comptes. Une variable d'environnement et une liste
suffisent : trois personnes au maximum, et le tableau de bord Sliplane fait deja office d'interface.

### Etape 2 — Un paquet d'installation autonome *(une journee)*

Produire un `.zip` qui ne demande ni depot, ni Node, ni compte GitHub.

Il contient :

```
Vassi Stream/
  Vassi Stream.amxd
  node/            (avec son node_modules deja installe)
  externals/vassi.encoder~.mxe64
  Installer.ps1
  LISEZ-MOI.txt
```

Deux travaux :

- **Un script de fabrication** — `scripts/make-release.js` — qui assemble ce zip depuis un depot a
  jour : il grave la version, copie les trois morceaux et verifie qu'aucun `publisher.json` ne s'y
  est glisse. Cette derniere verification n'est pas une precaution de style : le zip va partir par
  message, et un token dedans serait le meme accident que la semaine derniere.
- **Un installateur en PowerShell pur** — la logique de
  [`scripts/install-paths.js`](../scripts/install-paths.js) reecrite sans Node. Elle ne fait que
  chercher `Documents`, detecter la version de Max livree avec Live, et copier. C'est court, et cela
  supprime la dependance a Node du poste du professeur.

Garder `-Where` : c'est ce qui repondra a distance quand quelque chose n'ira pas.

### Etape 3 — Une feuille d'une page pour lui *(une heure)*

Pas `INSTALLATION.md` : ce document parle de developpement, de `npm`, et de deux machines. Une page
qui ne dit que six choses :

1. dezipper, lancer `Installer.ps1`, autoriser une fois si PowerShell refuse ;
2. fermer et rouvrir Live ;
3. deposer le device sur la piste Master ;
4. onglet **Reglages** : coller l'adresse et le token recus, **Enregistrer**, puis **Tester le
   relais** ;
5. onglet **Direct** : choisir la qualite et la latence, cliquer **LANCER**. Le mot passe au rouge
   quand le son part vraiment ;
6. si quelque chose cloche : onglet **Journal**, bouton **Copier**, et coller le resultat dans un
   message.

Le point 6 est le plus important des six. Le journal est deja concu pour cela — il ne contient aucun
secret, il est en ASCII, et il tient dans un message.

**Le token part par un autre canal que le zip.** Un gestionnaire de mots de passe avec partage, ou
un message ephemere. Jamais dans le meme envoi que le fichier.

### Etape 4 — Une repetition avant la vraie *(une heure, a deux)*

Dans l'ordre, en s'appelant :

1. il installe, configure, et clique **Tester le relais** — sans diffuser ;
2. vous ouvrez `/health` et verifiez que son nom apparait quand il se connecte ;
3. il lance un direct de cinq minutes pendant que vous ecoutez sur le site ;
4. il vous envoie son journal, meme si tout s'est bien passe. C'est la que vous verrez si les lignes
   de charge machine disent quelque chose d'utile sur sa machine a lui.

Convenir aussi de la regle simple qui evite le blocage nº 3 : **un seul des deux diffuse a la fois**,
et on previent avant de lancer.

---

## Ce qui n'est pas dans ce plan, et pourquoi

- **Une page d'administration.** Trois personnes ne justifient pas une interface. Sliplane en fait
  deja office.
- **Plusieurs directs simultanes.** Cela demanderait plusieurs sessions cote relais, plusieurs flux
  cote site, et un choix d'ecoute sur la page. C'est un autre projet.
- **Un installateur signe.** Windows affichera un avertissement sur un script telecharge. La signature
  de code coute et se renouvelle ; une phrase dans la feuille d'instructions suffit.
- **Le port macOS.** A decider apres l'etape 0, et a traiter comme un chantier a part.
