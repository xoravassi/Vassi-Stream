# Deployer le relais sur Sliplane

Ce document est la marche a suivre complete pour mettre le relais en ligne. Il ne suppose aucune
connaissance de Docker ni de la ligne de commande : chaque etape dit ce qu'il faut faire, et pourquoi.

Duree : environ trente minutes, dont dix d'attente de DNS.

---

## Avant de commencer : de quoi on parle

Le projet a trois morceaux. Deux tournent chez vous, un tourne sur Internet.

```text
Ableton (votre ordinateur)          Sliplane (Internet)         Navigateur du professeur
  device Max for Live      ----->      le relais       ----->      page /suivi-live
```

**Le relais** est le seul morceau a deployer. C'est un petit programme qui recoit le son d'Ableton et
le renvoie a tous ceux qui ecoutent. Il ne stocke rien, ne decode rien, et n'a pas de base de
donnees.

Trois mots reviennent tout le temps :

| Mot | Ce que c'est |
|---|---|
| **Service** | un programme qui tourne en permanence chez Sliplane. Le site `www.vassi.click` en est deja un ; le relais en sera un second. |
| **Dockerfile** | la recette qui explique a Sliplane comment fabriquer le relais. Elle existe deja, a la racine du projet. Vous n'avez pas a l'ecrire ni a la comprendre. |
| **Variable d'environnement** | un reglage que vous donnez au service depuis le tableau de bord, sans toucher au code. C'est la qu'ira le token. |

---

## Question posee : un depot GitHub, ou deux ?

**Un seul depot, celui du projet complet.** Ne creez pas de depot separe pour le relais.

La raison est concrete : le relais et le device partagent le fichier `src/protocol/audio-packet.ts`,
qui definit le format exact d'un paquet audio. Avec deux depots, ce fichier existerait en deux
exemplaires, et le jour ou l'un change sans l'autre, le son s'arrete sans que rien n'explique
pourquoi. Le projet est construit pour que cette definition n'existe qu'une fois.

Sliplane ne prend de toute facon que ce dont il a besoin : la recette ne copie que `relay/` et
`src/protocol/`. Le device Max for Live, les sources natives, les tests, la documentation et le
fichier audio de test ne montent jamais sur le serveur. Vous versionnez tout, Sliplane deploie une
petite partie.

---

## Etape 0 - Mettre le projet sur GitHub

Sliplane va chercher le code sur GitHub. Le projet n'est pas encore suivi par Git : c'est la premiere
chose a faire.

Ouvrez PowerShell dans le dossier du projet et collez ces lignes, une par une :

```powershell
cd c:\Users\LENOVO\Documents\VASSI\vassi-stream
git init
git add .
git commit -m "Vassi Stream : device, relais et moteur audio"
```

**Verification importante avant de pousser.** Le token ne doit jamais entrer dans GitHub. Collez
ceci :

```powershell
git ls-files | Select-String "publisher.json"
```

Cette commande ne doit **rien** afficher. Si elle affiche quelque chose, arretez-vous et dites-le moi.

Creez ensuite un depot **prive** sur GitHub, puis poussez la branche principale avec les deux lignes
que GitHub affiche apres la creation du depot.

Un depot prive convient : au premier deploiement, Sliplane vous demandera l'autorisation d'acceder a
vos depots.

---

## Etape 1 - Fabriquer le token

Le token est un mot de passe qui sert a une seule chose : prouver au relais que le son vient bien de
votre Ableton, et pas de quelqu'un d'autre. Sans lui, n'importe qui pourrait diffuser sur votre page.

```powershell
npm run token:new
```

La commande affiche une suite de 64 caracteres. **Collez-la tout de suite dans votre gestionnaire de
mots de passe**, sous un nom comme « Vassi Stream — token de publication ».

Vous allez le coller a deux endroits, et nulle part ailleurs :

```text
                    gestionnaire de mots de passe
                        (la seule copie durable)
                          /                  \
                         /                    \
        variable Sliplane                 chaque ordinateur
        VASSI_PUBLISHER_TOKEN             qui lance un live
             (etape 4)                       (etape 8)
```

Il n'entre jamais dans GitHub, dans un message, dans une capture d'ecran, ni dans un projet Ableton.

Un token de moins de 32 caracteres fait refuser le demarrage du relais. C'est voulu : un relais sans
vrai token serait ouvert a tout le monde.

---

## Etape 2 - Le nom de domaine

Le site `www.vassi.click` est deja un service Sliplane, et un service porte son propre nom de
domaine. Le relais ne peut donc pas se glisser sous `www.vassi.click` : il lui faut son propre nom.

**Nom retenu : `live.vassi.click`.**

Ce qui donne trois adresses, chacune avec un role precis :

| Adresse | Qui l'utilise | Vous la tapez ? |
|---|---|---|
| `https://live.vassi.click/health` | vous, pour verifier que tout va bien | oui, dans un navigateur |
| `wss://live.vassi.click/publisher` | le device dans Ableton | non, elle est collee une fois dans le device |
| `wss://live.vassi.click/listener` | la page publique | non, elle est dans la configuration du site |

Les deux adresses en `wss://` sont les deux prises du relais : une ou Ableton branche le son, une ou
les auditeurs le prennent. Ce ne sont pas des pages web, personne ne les ouvre a la main.

**L'adresse que vous donnerez au professeur reste `https://www.vassi.click/suivi-live`.** C'est la
seule que quelqu'un tape.

---

## Etape 3 - Creer le service

Dans le tableau de bord Sliplane :

1. Ouvrez votre projet, puis **Deploy Service**.
2. **Choisissez le serveur.** Le relais peut vivre sur celui qui porte deja le site : il ne calcule
   presque rien, il fait surtout passer des octets. Sliplane facture le serveur, pas le service.
3. **Source : GitHub**, puis le depot pousse a l'etape 0. Autorisez l'acces si Sliplane le demande.
4. **Deploy Branch** : votre branche principale. Chaque nouveau commit redeploiera automatiquement.
5. **Dockerfile path** : `/Dockerfile`. Sliplane le trouve seul et remplit le champ ; verifiez
   simplement qu'il pointe bien la racine et pas un sous-dossier.
6. **Docker context** : `/`. Ne changez pas cette valeur. Elle dit a Sliplane de partir de la racine
   du depot ; la recette a besoin d'y prendre `src/protocol`, qui est en dehors de `relay/`.
7. **Expose Service** : active. Sans cela, le relais tournerait sans etre joignable.
8. **Protocol** : `TCP/HTTP`. C'est ce mode qui place le service derriere le certificat de Sliplane,
   et donc ce qui rend les adresses `wss://` possibles.
9. **Health check path** : `/health`.

**Ne montez aucun volume.** Un volume sert a garder des donnees entre deux redemarrages ; le relais
n'en garde aucune, et un volume empecherait les mises a jour sans coupure.

---

## Etape 4 - Poser les reglages

Toujours dans l'ecran de creation, section des variables d'environnement. Ajoutez ces deux lignes :

| Cle | Valeur | Cocher « secret » |
|---|---|---|
| `VASSI_PUBLISHER_TOKEN` | le token de l'etape 1 | **oui** |
| `VASSI_MAX_LISTENERS` | `50` | non |

**Ne creez pas de variable `PORT`.** Sliplane la fournit lui-meme et se la reserve ; le relais la lit
et ecoute dessus. Les autres noms reserves, a ne pas utiliser non plus, sont `SLIPLANE_COMMIT_HASH`,
`SLIPLANE_DOMAIN`, `SLIPLANE_SKIP_CACHE`, `SLIPLANE_GRACE_PERIOD`, `SLIPLANE_USER_ID` et
`SLIPLANE_GROUP_ID`.

Cocher « secret » masque la valeur apres l'enregistrement : vous ne pourrez plus la relire dans
l'interface. C'est exactement pour cela qu'elle doit deja etre dans votre gestionnaire de mots de
passe.

`VASSI_MAX_LISTENERS` limite le nombre d'auditeurs simultanes. Cinquante est large pour l'usage
prevu ; c'est une protection contre l'imprevu, pas un reglage a ajuster.

---

## Etape 5 - Deployer et lire ce qui se passe

Lancez le deploiement. Sliplane fabrique le programme puis le demarre. Comptez une a deux minutes.

Ouvrez ensuite l'onglet **Logs**. Le relais ecrit une ligne par evenement. Un demarrage reussi
ressemble a ceci :

```json
{"time":"2026-08-03T12:00:00.000Z","event":"relais_demarre","port":8080,"maxListeners":50}
```

Si vous voyez plutot une ligne `relais_config_invalide`, le mot qui suit dit quoi corriger :

| Ce qui est ecrit | Ce que ca veut dire | Quoi faire |
|---|---|---|
| `config_token_absent` | la variable n'a pas ete enregistree | refaire l'etape 4 |
| `config_token_trop_court` | moins de 32 caracteres, souvent un copier-coller incomplet | recoller le token en entier |

Le token n'apparait dans aucune ligne du journal, meme quand c'est lui le probleme.

**Verifiez ensuite le service**, en utilisant l'adresse temporaire que Sliplane vous a attribuee (du
genre `mon-service.sliplane.app`) :

```powershell
npm run relay:check -- https://mon-service.sliplane.app
```

Trois lignes doivent afficher `OK` :

```text
OK   route de sante : live=false, auditeurs=0, uptime=12s
OK   connexion listener : live=false
OK   chemin publisher protege : ferme avec le code 1008
```

La deuxieme ligne est la plus importante : elle prouve qu'une vraie connexion audio passe le
certificat et le proxy de Sliplane. La troisieme verifie qu'un inconnu sans token se fait bien
refuser.

---

## Etape 6 - Attacher `live.vassi.click`

Le bouton n'apparait que si le service est en bonne sante. L'etape 5 doit donc etre verte.

1. Onglet **Settings** du service, section **Domain**, bouton **Connect Domain**.
2. Tapez `live.vassi.click`, puis **Connect**.
3. Sliplane propose trois facons de pointer le domaine. **Prenez la premiere, `CNAME`** : c'est la
   plus simple, et elle convient toujours pour un sous-domaine.

   Chez le fournisseur DNS de `vassi.click`, ajoutez :

   | Type | Nom / Host | Valeur / Target |
   |---|---|---|
   | `CNAME` | `live` | `mon-service.sliplane.app` |

   Les deux autres options, `ANAME`/`ALIAS` et `A` + `AAAA`, existent pour les domaines racines comme
   `vassi.click` tout court, dont certains fournisseurs refusent le `CNAME`. Elles ne servent pas
   ici.

4. Attendez la propagation : souvent quelques minutes, parfois une heure.
5. Le certificat HTTPS est demande automatiquement, sans rien a configurer. C'est lui qui rend
   `wss://` possible.

Pour savoir ou en est la propagation :

```powershell
Resolve-DnsName live.vassi.click -Type CNAME
```

Tant qu'elle repond une erreur, c'est que le DNS n'a pas encore suivi. Attendez, ne changez rien.

---

## Etape 7 - Verifier le relais definitif

```powershell
npm run relay:check -- https://live.vassi.click
```

Les trois lignes doivent afficher `OK`, et la commande affiche ensuite l'adresse exacte a donner au
device.

C'est la verification qui restait ouverte dans la roadmap. A partir d'ici, le relais est en service.

---

## Etape 8 - Donner l'adresse et le token au device

**A faire une fois par ordinateur.** Le token est enregistre sur la machine, pas dans le projet
Ableton : passer du ThinkPad au fixe demande de refaire cette etape sur le fixe.

Le fichier va dans `%APPDATA%\Vassi Stream\publisher.json`. Il ne part jamais avec un projet Ableton
ni avec le depot GitHub, ce qui est precisement le but.

Pour l'instant, cela se fait avec une commande. Collez ces trois lignes dans PowerShell, en
remplacant les points par votre token :

```powershell
$env:VASSI_PUBLISHER_TOKEN = "..."
npm run config:publisher -- --url wss://live.vassi.click/publisher
Remove-Item Env:\VASSI_PUBLISHER_TOKEN
```

La troisieme ligne efface le token de la fenetre PowerShell ouverte. Sans elle, il resterait lisible
jusqu'a la fermeture de la fenetre.

Les espaces avant ou apres le token sont enleves automatiquement : un copier-coller depuis un
gestionnaire de mots de passe en emporte souvent un, et ce n'est pas une raison pour que
l'authentification echoue.

> **Ce point sera plus simple.** Le bloc 10 ajoute deux champs texte et un bouton Enregistrer
> directement dans le device : installer un nouvel ordinateur reviendra a poser le device, coller
> l'adresse et le token, et cliquer. Aucune fenetre PowerShell. La commande ci-dessus est la solution
> d'attente, pas la solution finale.

---

## Etape 9 - Premier direct de bout en bout

1. Ouvrez Ableton, posez le device sur la piste Master, lancez le live.
2. Ouvrez `https://live.vassi.click/health` dans un navigateur. Vous devez voir `"live": true`, un
   `sessionId` rempli, et `lastPacketAgeMs` en dessous de cent.
3. Arretez le live : `"live"` revient a `false`.

Si `"live"` est `true` mais que `lastPacketAgeMs` grandit de seconde en seconde, le son n'arrive plus
au relais : le probleme est entre Ableton et Internet, pas sur le serveur.

---

## La page `/health` : ce qu'on y voit, et pourquoi elle est ouverte

Elle repond sans mot de passe, et c'est une obligation : Sliplane l'interroge chaque minute pour
savoir si le service tourne. Une page protegee ferait croire a une panne permanente.

Voici tout ce qu'elle montre :

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

Il n'y a la ni token, ni son, ni adresse IP, ni nom de personne. Le seul fait un peu personnel,
« un direct est en cours », est de toute facon deja public : il suffit d'ouvrir la page
`/suivi-live` pour le savoir. En echange, vous pouvez diagnostiquer une panne depuis n'importe quel
telephone.

Les quatre chiffres utiles quand quelque chose cloche :

| Champ | Ce qu'il vous dit |
|---|---|
| `lastPacketAgeMs` | s'il grandit pendant un direct, le son n'arrive plus d'Ableton |
| `listenerFramesDropped` | s'il monte, c'est la connexion d'un auditeur qui ne suit pas, pas votre son |
| `packetsRefused` | s'il monte, le device et le relais ne s'entendent pas sur le format |
| `listeners` | combien de personnes ecoutent en ce moment |

---

## Si quelque chose ne marche pas

| Ce que vous constatez | Cause la plus frequente | Quoi faire |
|---|---|---|
| Le deploiement echoue avant de demarrer | `Docker context` n'est pas `/` | corriger dans les reglages du service, redeployer |
| `relais_config_invalide` dans les logs | token absent ou tronque | refaire l'etape 4 |
| `npm run relay:check` echoue sur la sante | le service n'a pas fini de demarrer | attendre une minute, reessayer |
| `npm run relay:check` echoue sur le listener | le domaine n'est pas encore propage | attendre, verifier avec `Resolve-DnsName` |
| Le device reste sur « Erreur » | le token du device ne correspond pas a celui de Sliplane | refaire l'etape 8 avec le token du gestionnaire |
| `"live"` reste `false` pendant un live | le device n'atteint pas le relais | verifier l'adresse collee a l'etape 8 |

Sliplane vous envoie un courriel si `/health` echoue trois fois de suite. Tant qu'un nouveau
deploiement ne passe pas son controle de sante, le trafic reste sur la version qui fonctionnait : un
deploiement rate ne coupe pas un direct.

---

## Changer le token plus tard

Si le token doit changer, par exemple parce qu'il a ete vu par quelqu'un :

1. `npm run token:new` pour en fabriquer un nouveau, et l'enregistrer dans le gestionnaire ;
2. remplacer la valeur de `VASSI_PUBLISHER_TOKEN` dans Sliplane, puis redeployer ;
3. refaire l'etape 8 sur chaque ordinateur qui lance des lives.

Entre l'etape 2 et l'etape 3, le device sera refuse et affichera une erreur. Il repartira seul des
que la nouvelle valeur sera en place sur la machine.

---

## Ce qui reste a faire au bloc 9

La page `/suivi-live` est un ajout au site Svelte existant, pas un troisieme service Sliplane. Deux
points la concernent au moment de la deployer :

- l'adresse `wss://live.vassi.click/listener` doit etre un reglage du site, pas une adresse ecrite en
  dur dans un composant ;
- si la page utilise `SharedArrayBuffer`, le site doit renvoyer les en-tetes
  `Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp`. Ces
  en-tetes bloquent toute ressource externe de la page, ce qui peut casser autre chose sur le site.
  Le moteur audio fonctionne aussi sans eux, avec un transport par messages : c'est un choix a faire
  en regardant ce que la page charge par ailleurs.
