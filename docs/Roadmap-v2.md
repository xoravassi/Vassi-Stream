# Roadmap v2 — Publier Vassi Stream en open source

## But

Transformer un outil qui marche sur l'ordinateur de Vassi en un projet qu'un inconnu peut
télécharger, installer, héberger et modifier — sans demander la permission, sans abonnement, et sans
poser une seule question à Vassi.

Le système actuel fait déjà techniquement ce que font des logiciels payants : un plugin sur la piste
Master, un lien à ouvrir dans un navigateur, du son stéréo en direct. Ce qui manque n'est presque
jamais de l'audio. C'est tout ce qui entoure l'audio : une licence, un nom qui n'est pas celui d'une
personne, une adresse qui n'est pas `vassi.click`, un `.amxd` téléchargeable, une version macOS, et
une page d'écoute qui ne vit pas dans un site personnel.

Cette roadmap ne rouvre rien de ce que la [Roadmap.md](../Roadmap.md) a fermé. Le protocole v1, le
device, le relais et le moteur audio restent tels quels.

## Où en est le projet aujourd'hui

| Élément | État |
|---|---|
| Protocole, device, relais, moteur audio | écrits, testés, `npm.cmd run check` passe (333 tests) |
| Chaîne complète Ableton → relais → navigateur | fonctionne de bout en bout |
| Code applicatif | environ 5 600 lignes de JavaScript et TypeScript, 1 700 lignes de C++ |
| Documentation | environ 19 000 mots, en français |
| Licence | **aucune** |
| Intégration continue | **aucune** |
| Plateformes | **Windows x64 uniquement** |
| Page d'écoute | vit dans le dépôt privé du site `vassi.click`, pas ici |
| Sessions simultanées | une seule, un seul token, un seul publisher |

Les cinq lignes en gras sont l'essentiel du travail décrit plus bas.

## Ce que le projet remplacerait

Il existe deux familles d'outils pour faire écouter à distance la sortie d'un DAW.

**Les services payants sur abonnement.** Audiomovers LISTENTO est le plus proche : un plugin
VST/AU/AAX sur la piste Master, un lien que l'auditeur ouvre dans son navigateur, rien à installer
de son côté. Source-Connect, SessionLinkPRO et SessionWire visent le même besoin avec des angles
différents (post-production, sessions à distance). Tous demandent un compte et un abonnement, et
tous passent par les serveurs de l'éditeur : la session part chez un tiers.

**Les outils libres existants.** SonoBus et Jamulus sont libres et de bonne qualité, mais ils
demandent à l'auditeur d'installer une application et de savoir la configurer. Ils visent le jeu à
plusieurs, pas l'écoute d'un mix par une personne qui ne veut rien installer.

La place vide est précisément celle-ci : **libre, auto-hébergeable, et rien à installer pour
l'auditeur.** C'est ce que fait déjà Vassi Stream, et c'est ce qui justifie de le publier plutôt que
de le garder pour soi.

> Les tarifs et les fonctionnalités exactes de ces produits changent. Avant d'écrire une comparaison
> publique, les revérifier le jour où elle est écrite, et ne comparer que ce qui est vérifiable.

## Périmètre fixé pour la v2

- Le protocole v1 ne change pas. Un device v2 et un relais v1 doivent continuer de se parler.
- Le codec reste Opus stéréo. Pas de PCM sans perte, pas de WebRTC.
- Le relais reste un seul processus Node sans base de données.
- La cible reste Max for Live. Pas de portage VST3 ni AU.
- L'auditeur n'installe rien : une page web dans un navigateur, sur ordinateur comme sur téléphone.
- Le projet reste auto-hébergeable en entier. Aucun service géré par Vassi n'est nécessaire pour
  qu'un utilisateur s'en serve.

Hors périmètre de la v2 : enregistrement du direct, chat, talkback, vidéo, comptes utilisateurs,
service hébergé payant ou gratuit, application mobile, et portage VST3/AU.

## Principes à respecter

- **Rien de personnel ne reste dans le code.** Aucun domaine, aucun chemin, aucun nom en dur. Ce qui
  varie d'un utilisateur à l'autre se configure ; ce qui ne varie pas se code.
- **Un utilisateur doit pouvoir tout héberger lui-même.** Si une étape demande un service que Vassi
  contrôle, elle est mal conçue.
- **Une régression sur le chemin actuel est un défaut bloquant.** Le système marche aujourd'hui ;
  l'ouvrir ne doit rien lui coûter.
- **Ce qui n'est pas testé n'est pas livré.** La règle de la v1 tient : `npm run check` reste la
  porte d'entrée, et l'intégration continue la ferme à clé.
- **La documentation d'un projet public s'écrit pour quelqu'un qui n'a jamais parlé à l'auteur.**
  Toute phrase qui suppose une conversation préalable est à réécrire.

## Règle de validation

Identique à celle de la v1 : un bloc est terminé lorsque son résultat est utilisable, que sa
vérification courte fonctionne, et que le bloc précédent continue de fonctionner.

Deux vérifications s'ajoutent à partir du bloc 3, et valent pour tous les blocs suivants :

- `npm run check` passe encore ;
- un direct réel de cinq minutes, Ableton vers navigateur, fonctionne encore.

---

# Blocs d'implémentation

## Phase 1 — Rendre le dépôt publiable

Ces quatre blocs ne changent aucune fonctionnalité. Ils enlèvent ce qui empêche de rendre le dépôt
public, et rien d'autre. Ils sont courts et se font dans l'ordre.

## Bloc 1 — Choisir la licence, le nom et les avertissements

**Dépendances :** aucune.

**But :** répondre aux trois questions qui bloquent toute publication, avant d'écrire une ligne.

Sans licence, un dépôt public est du code que personne n'a le droit d'utiliser : le défaut légal est
« tous droits réservés ». C'est le seul point de cette roadmap qui bloque littéralement tout le
reste.

**Trois décisions demandent une réponse de Vassi.** Elles ne se déduisent pas du code.

### Décision 1 — La licence

Les dépendances ne contraignent rien : libopus et SpeexDSP sont en BSD-3-Clause, `ws` et
`opus-decoder` en MIT, et le SDK Max n'est pas redistribué (il est téléchargé dans `.local/`). Tout
est donc possible. Le choix dépend uniquement de ce que Vassi accepte que d'autres fassent.

| Licence | Ce qu'elle autorise | Ce qu'elle empêche |
|---|---|---|
| **MIT** | tout, y compris revendre une version fermée | rien |
| **Apache-2.0** | comme MIT, plus une protection contre les brevets | rien, mais oblige à citer les modifications |
| **GPL-3.0** | usage et modification libres | de distribuer une version fermée du device |
| **AGPL-3.0** | usage et modification libres | de faire tourner un service fermé basé sur le relais |

La question est simple à poser : **un service payant a-t-il le droit de prendre ce code et d'en
faire son produit fermé ?** Si la réponse est non, la licence est AGPL-3.0 pour le relais, parce que
le relais est un service réseau et que seule l'AGPL couvre ce cas. Si la réponse est « ça m'est
égal, je veux surtout que ce soit utile », c'est MIT ou Apache-2.0.

**Recommandation : Apache-2.0.** Le but énoncé est d'offrir une alternative, pas d'empêcher quelque
chose. Apache-2.0 laisse le maximum de monde s'en servir, ce qui est la condition pour qu'un projet
libre trouve des contributeurs, et sa clause de brevets protège mieux que MIT un projet qui touche à
un codec. Si Vassi tient à ce qu'une reprise commerciale reste ouverte, AGPL-3.0 est le bon choix et
il faut l'assumer : elle réduit le nombre de gens qui l'adopteront.

### Décision 2 — Le nom

`Vassi Stream` est un nom de personne. Il apparaît dans 17 fichiers de code, dans le dossier de
configuration (`%APPDATA%\Vassi Stream`), dans le dossier de la bibliothèque Max, dans le nom du
device visible dans Ableton, et dans l'objet natif `vassi.encoder~`.

Garder ce nom est un choix valable : beaucoup de projets libres portent le nom de leur auteur. Mais
il faut le décider maintenant, parce qu'un renommage après la première version publique casse les
configurations déjà installées.

Si le nom change, le préfixe de l'objet natif change aussi (`vassi.encoder~` est le nom que Max
charge), et l'ancien nom doit rester lisible pendant une version au moins.

### Décision 3 — Le domaine de démonstration

`live.vassi.click` est le relais personnel de Vassi. Il ne peut pas devenir le relais par défaut du
projet : chaque utilisateur qui l'utiliserait enverrait son mix chez Vassi, et le coût comme la
responsabilité seraient pour lui.

Deux options : soit le projet n'a aucun relais public et chacun héberge le sien (simple, honnête,
mais la première utilisation demande un déploiement), soit un relais de démonstration existe,
clairement étiqueté comme tel, limité en durée et en nombre d'auditeurs.

**Recommandation : aucun relais public au départ.** Un relais de démonstration se transforme en
service gratuit que les gens attendent, puis en charge que personne ne finance.

### À faire

- [ ] Trancher les trois décisions ci-dessus et écrire chacune dans ce document, avec sa date.
- [ ] Ajouter le fichier `LICENSE` à la racine.
- [ ] Ajouter `NOTICE.md` : la liste des dépendances, leur licence et leur version — libopus 1.5.2,
      SpeexDSP 1.2.1, `ws` 8.21.1, `opus-decoder` 0.7.11, SDK Max.
- [ ] Ajouter l'avertissement de marque au README : Ableton, Ableton Live et Max for Live sont des
      marques d'Ableton AG et de Cycling '74, et ce projet n'est affilié à aucune des deux.
- [ ] Vérifier que la police Ableton Sans est seulement nommée par le device, jamais redistribuée.

### Vérification courte

- [ ] Le fichier `LICENSE` existe et sa licence est nommée dans le README.
- [ ] Aucun fichier du dépôt ne contient de code tiers sans mention dans `NOTICE.md`.

### Terminé

- [ ] **Bloc 1 validé.**

## Bloc 2 — Retirer ce qui est personnel du code

**Dépendances :** bloc 1.

**But :** faire que le système fonctionne pour quelqu'un qui n'est pas Vassi, sans modifier une
seule ligne de code.

Aujourd'hui, un utilisateur qui clone le dépôt trouve `vassi.click` écrit à plusieurs endroits, un
chemin de configuration qui porte un nom de personne, et une page d'écoute qui n'existe que dans un
autre dépôt, privé.

Ce bloc ne change aucun comportement pour Vassi : ses valeurs actuelles deviennent simplement des
valeurs par défaut ou des exemples, au lieu d'être écrites en dur.

### À faire

- [ ] Relever les 17 fichiers qui contiennent `vassi.click` ou `Vassi` et classer chaque occurrence
      en trois familles : nom du produit (reste), exemple de documentation (devient `example.com`),
      valeur de configuration (sort du code).
- [ ] Faire du dossier de configuration une valeur dérivée du nom du produit, définie à un seul
      endroit, et non répétée dans `publisher-config.js`, `install-device.js` et `wiring.js`.
- [ ] Ajouter `.env.example` à la racine du relais : les trois variables (`VASSI_PUBLISHER_TOKEN`,
      `PORT`, `VASSI_MAX_LISTENERS`) avec un commentaire chacune et aucune valeur réelle.
- [ ] Vérifier qu'aucun token, aucune adresse IP et aucun identifiant ne se trouve dans
      l'historique Git. Un secret déjà commité n'est pas effacé par une suppression : il faut le
      révoquer, pas le cacher.
- [ ] Déplacer `Agents.md` et `Concept.md` : ce sont des documents de travail personnels, adressés
      à un agent et à Vassi. Soit ils partent dans `docs/` réécrits pour un lecteur inconnu, soit
      ils sortent du dépôt public.

### Vérification courte

- [ ] `git grep -i vassi.click` ne rend que des exemples de documentation.
- [ ] Un direct réel fonctionne toujours avec la configuration déjà en place sur la machine de
      Vassi, sans qu'il ait eu à la recoller.

### Terminé

- [ ] **Bloc 2 validé.**

## Bloc 3 — Écrire pour un lecteur qui ne parle pas français

**Dépendances :** bloc 2.

**But :** rendre le projet lisible par les gens qui l'utiliseront.

C'est le bloc le plus long de la phase 1 et le plus facile à sous-estimer. Il y a environ 19 000
mots de documentation et plusieurs milliers de lignes de commentaires, tous en français. Le public
d'un outil de production musicale libre est international.

**Il n'y a pas de bonne réponse universelle, il y a un choix à tenir.** Trois options :

| Option | Coût | Ce qu'elle donne |
|---|---|---|
| Tout traduire en anglais | très élevé | un projet lisible partout, une documentation à maintenir une seule fois |
| README et `docs/` en anglais, commentaires en français | moyen | utilisable par tous, contribuable par peu de monde |
| README en anglais, le reste en français | faible | découvrable, mais aucun contributeur extérieur |

**Recommandation : la deuxième, puis la première par morceaux.** Un utilisateur a besoin du README,
du guide d'installation et du guide de déploiement. Un contributeur a besoin des commentaires — mais
il n'y aura pas de contributeur avant qu'il y ait des utilisateurs. Traduire les commentaires
d'abord serait traduire pour personne.

Les commentaires de ce projet sont inhabituellement denses et expliquent des décisions, pas des
mécanismes. C'est une qualité rare et ce serait une perte de les raccourcir en les traduisant : la
traduction doit être complète ou ne pas être faite.

### À faire

- [ ] Écrire `README.md` en anglais : à quoi sert le projet, ce dont il a besoin, comment
      l'installer, comment héberger le relais, la licence. Une page, pas dix.
- [ ] Garder la version française en `README.fr.md`, liée depuis la première ligne de chaque
      version.
- [ ] Traduire les trois documents dont un utilisateur a besoin :
      [device-max.md](device-max.md), [deploiement-sliplane.md](deploiement-sliplane.md) devenu un
      guide d'auto-hébergement générique, et [protocol-v1.md](protocol-v1.md) — ce dernier parce
      qu'il est le contrat, et qu'une réimplémentation dans un autre langage part de là.
- [ ] Ajouter une capture d'écran du device et une de la page d'écoute au README. Un outil visuel
      qui ne montre rien n'est pas essayé.
- [ ] Écrire un paragraphe honnête sur les limites : Windows seulement pour l'instant, un seul
      direct à la fois, l'auditeur entend la suite et jamais ce qui précède.

### Vérification courte

- [ ] Quelqu'un qui ne connaît pas le projet lit le README et sait dire, en une minute, si l'outil
      lui sert ou non.
- [ ] Les liens entre versions française et anglaise fonctionnent dans les deux sens.

### Terminé

- [ ] **Bloc 3 validé.**

## Bloc 4 — Poser les garde-fous d'un dépôt public

**Dépendances :** bloc 1.

**But :** faire que le dépôt se défende tout seul, au lieu de dépendre de la vigilance de Vassi.

Un dépôt public reçoit des contributions, des rapports de bug et, tôt ou tard, un rapport de
sécurité. Les 333 tests existants ne servent à rien si personne ne les lance avant de fusionner une
modification.

### À faire

- [ ] Ajouter un workflow GitHub Actions qui lance `npm run typecheck` et `npm test` à chaque
      poussée et à chaque demande de fusion.
- [ ] Lancer aussi les tests natifs et la construction du device : ils demandent Windows et le SDK
      Max, donc un second travail sur `windows-latest`, séparé et autorisé à échouer tant que le
      SDK n'est pas installable automatiquement.
- [ ] Ajouter `SECURITY.md` : comment signaler une faille en privé, et sous quel délai attendre une
      réponse. Le relais est un service exposé à Internet ; c'est le morceau qui recevra ces
      rapports.
- [ ] Ajouter `CONTRIBUTING.md` : les règles de `Agents.md` réécrites pour un humain extérieur —
      fichiers courts, une responsabilité par fonction, commentaires au présent, tests
      systématiques.
- [ ] Ajouter `CODE_OF_CONDUCT.md`.
- [ ] Ajouter des gabarits d'issue : rapport de bug (avec version d'Ableton, de Max, de Live, et
      système), et demande de fonctionnalité.
- [ ] Activer les alertes de dépendances et la mise à jour automatique.

### Vérification courte

- [ ] Une demande de fusion qui casse un test est refusée automatiquement.
- [ ] Le badge d'état du workflow est visible dans le README.

### Terminé

- [ ] **Bloc 4 validé.**

---

## Phase 2 — Rendre le projet utilisable par un inconnu

À la fin de la phase 1, le dépôt est publiable. Il n'est pas encore utilisable : la page d'écoute
n'est pas dedans, le relais suppose Sliplane, et le device demande une chaîne de compilation.

## Bloc 5 — Faire vivre la page d'écoute dans ce dépôt

**Dépendances :** bloc 2.

**But :** qu'un utilisateur obtienne une page d'écoute sans posséder le site `vassi.click`.

C'est le trou le plus visible du projet actuel. Le moteur audio est ici, dans `src/player/`, mais
l'interface — le bouton Play/Pause, les états, la mise en page — vit dans le dépôt privé du site,
dans `frontend/src/routes/session/`. Quelqu'un qui clone ce dépôt obtient un moteur sans page.

Le pont décrit dans [pont-site-web.md](pont-site-web.md) copie le moteur d'ici vers le site. Cette
direction est la bonne pour Vassi et la mauvaise pour tout le monde : elle suppose un site Svelte
existant.

**La solution n'est pas de déplacer la page du site vers ici.** C'est d'ajouter ici une page
autonome, indépendante de tout site, et de laisser le site de Vassi continuer à faire sa version. Le
relais sait déjà servir du HTTP : il peut servir cette page lui-même, sur `/`.

Un utilisateur déploierait alors un seul conteneur et obtiendrait à la fois le relais et la page
d'écoute. C'est ce qui rend le projet installable en une étape.

### À faire

- [ ] Écrire une page d'écoute autonome dans `web/` : un fichier HTML, le moteur de `src/player/`,
      aucune dépendance de construction, aucun framework.
- [ ] La faire servir par le relais sur `/`, à la place de la réponse JSON actuelle. La route de
      santé reste sur `/health` : c'est déjà elle que l'hébergeur interroge.
- [ ] Lire l'adresse du listener depuis la page elle-même plutôt que d'une configuration : la page
      est servie par le relais, donc le relais est à l'adresse courante.
- [ ] Reprendre les états de la page du site — Hors ligne, Prêt, Chargement, Lecture, En pause,
      Reconnexion, Erreur — et le bouton Play/Pause accessible.
- [ ] Vérifier que le bundle servi ne contient toujours aucun token.
- [ ] Écrire dans [pont-site-web.md](pont-site-web.md) que le site de Vassi garde sa propre page et
      que les deux ne divergent pas : le moteur reste la seule source commune.

### Vérification courte

- [ ] Un `docker run` du relais seul donne une page qui joue un direct, sans autre logiciel.
- [ ] La page du site `vassi.click` fonctionne toujours à l'identique.

### Terminé

- [ ] **Bloc 5 validé.**

## Bloc 6 — Héberger le relais n'importe où, en une commande

**Dépendances :** bloc 5.

**But :** que l'hébergement ne demande ni compte Sliplane ni connaissance de Docker.

Le `Dockerfile` actuel est correct et générique. Ce qui ne l'est pas, c'est la documentation :
[deploiement-sliplane.md](deploiement-sliplane.md) fait 17 000 caractères et parle d'un seul
hébergeur.

### À faire

- [ ] Ajouter `docker-compose.yml` : le relais, ses variables, un port, et rien d'autre.
- [ ] Écrire un guide d'auto-hébergement générique qui traite trois cas — un VPS avec Caddy ou
      Traefik pour le certificat, une plateforme de conteneurs, et une machine locale pour essayer.
- [ ] Garder le guide Sliplane comme exemple, pas comme méthode.
- [ ] Documenter la seule contrainte réelle : le relais doit être derrière du TLS, parce que le
      device refuse `ws://` hors de la machine locale. Dire comment l'obtenir, pas seulement qu'il
      le faut.
- [ ] Ajouter une commande qui fabrique un token et affiche la variable d'environnement à coller :
      `npm run token:new` existe déjà, la rendre lisible dans le guide.
- [ ] Publier l'image sur un registre public à chaque version, pour que l'auto-hébergement ne
      demande pas de compiler.

### Vérification courte

- [ ] Un `docker compose up` sur une machine neuve donne un relais joignable en moins de cinq
      minutes, guide en main et sans autre aide.
- [ ] `npm run relay:check` valide ce relais.

### Terminé

- [ ] **Bloc 6 validé.**

## Bloc 7 — Livrer un device que l'on télécharge

**Dépendances :** bloc 1, bloc 11 de la Roadmap v1 (gel du device).

**But :** qu'installer le device soit « télécharger un fichier et le déposer sur une piste ».

Aujourd'hui l'installation demande de cloner le dépôt, d'avoir Node, de lancer `device:install`, et
de savoir que Max n'indexe pas la bibliothèque d'Ableton. C'est acceptable pour l'auteur, pas pour
un utilisateur.

Le gel du device, déjà prévu au bloc 11 de la roadmap v1, embarque l'objet natif et le script Node
dans le `.amxd`. Ce bloc-ci le transforme en release.

### À faire

- [ ] Terminer le gel du device et vérifier qu'il fonctionne sur une machine **qui n'a jamais eu le
      dépôt** — c'est la seule vérification qui prouve quelque chose.
- [ ] Automatiser la construction d'une release : sur un tag `v*`, produire le `.amxd` gelé et le
      joindre à la release GitHub.
- [ ] Ajouter un `CHANGELOG.md` et un numéro de version visible dans le device.
- [ ] Écrire la page d'installation : télécharger, déposer, coller l'adresse du relais et le token,
      cliquer. Cinq lignes, avec des captures.
- [ ] Garder `device:install` documenté pour ceux qui développent le device, séparé de la voie
      normale.

### Vérification courte

- [ ] Sur une machine sans Node et sans le dépôt, le device téléchargé lance un direct.
- [ ] Ableton fermé puis rouvert, le device retrouve sa configuration.

### Terminé

- [ ] **Bloc 7 validé.**

---

## Phase 3 — Rattraper ce que font les services payants

À la fin de la phase 2, le projet est publiable, installable et hébergeable. Trois manques
l'empêchent encore d'être une vraie alternative.

## Bloc 8 — Faire fonctionner le device sur macOS

**Dépendances :** bloc 7.

**But :** exister pour la moitié du public qui produit sur Mac.

C'est le plus gros travail technique de cette roadmap, et le plus rentable : un outil pour Ableton
qui ne tourne que sur Windows se prive de la majorité de ses utilisateurs potentiels.

**Ce qui bloque est bien délimité.** Un seul fichier est lié à Windows : `frame_sender.cpp`, qui
utilise Winsock (`winsock2.h`, `WSAStartup`, `SOCKET`, `closesocket`). Le reste de l'objet natif —
la queue audio, le rééchantillonnage, l'encodage Opus — est du C++ portable. Le côté Node et le
relais sont déjà multiplateformes, et `publisher-config.js` connaît déjà le chemin macOS.

**Ce qui coûte cher n'est pas le code.** C'est la signature. Un external natif téléchargé depuis
Internet est mis en quarantaine par Gatekeeper : il faut un identifiant Apple Developer payant
(environ 99 € par an), une signature Developer ID et une notarisation dans la chaîne de release.
Sans cela, chaque utilisateur macOS devra lever la quarantaine à la main, ce qui fait fuir la
plupart des gens et ressemble à un logiciel douteux.

**Cette dépense est une décision de Vassi**, pas une conséquence technique. Une alternative existe :
publier les sources et une recette de compilation, sans binaire macOS. C'est honnête, cela ne coûte
rien, et cela réduit le public aux gens qui savent compiler.

### À faire

- [ ] Extraire l'interface de socket de `frame_sender.cpp` derrière quatre fonctions — ouvrir,
      fermer, envoyer, régler — et écrire l'implémentation BSD à côté de l'implémentation Winsock.
      `SOCKET` devient `int`, `INVALID_SOCKET` devient `-1`, `closesocket` devient `close`, et
      `WSAStartup` disparaît.
- [ ] Poser `SO_NOSIGPIPE` sur macOS : sans lui, une écriture sur un socket fermé tue le processus
      de Max au lieu de rendre une erreur.
- [ ] Adapter le `CMakeLists.txt` : `CMAKE_OSX_ARCHITECTURES` à `arm64;x86_64` pour un binaire
      universel, et vérifier que libopus et SpeexDSP se compilent bien pour les deux.
- [ ] Faire tourner les tests natifs existants sur macOS.
- [ ] Trancher la question de la signature et, si la réponse est oui, ajouter signature et
      notarisation au workflow de release.
- [ ] Vérifier le device dans Live sur macOS : les couleurs sourcées dans le thème Sombre d'Ableton
      et la police Ableton Sans se comportent-elles pareil ?

### Vérification courte

- [ ] Un direct de dix minutes depuis un Mac vers la page d'écoute, sans coupure.
- [ ] Le même device fonctionne sur un Mac Intel et sur un Mac Apple Silicon.
- [ ] Les tests natifs passent sur les deux systèmes.

### Terminé

- [ ] **Bloc 8 validé.**

## Bloc 9 — Tenir sur un téléphone dont l'écran est éteint

**Dépendances :** bloc 5.

**But :** que quelqu'un puisse écouter le direct depuis son téléphone, dans sa poche.

Ce défaut est déjà noté au bloc 11 de la roadmap v1 : **Android coupe après quelques minutes, iOS
coupe instantanément.** Ce n'est pas un détail de confort. Un professeur qui écoute un mix pendant
qu'il fait autre chose, un auditeur qui range son téléphone : c'est le cas d'usage le plus banal, et
il ne marche pas.

**La recherche faite le 2026-08-05 a corrigé l'hypothèse de départ de cette roadmap.** Il faut
commencer par une distinction.

**Un iPhone verrouillé continue de jouer un élément `<audio>`, et refuse de faire tourner un
AudioWorklet.** Le lecteur de musique du site `vassi.click` le montre : il pose une adresse de
fichier sur un élément `<audio>`, donc iOS le traite comme un média et le laisse jouer écran éteint.
Ce moteur-ci n'a pas de média : il pousse des échantillons dans un AudioWorklet, et c'est le contexte
audio qu'iOS met dans l'état `interrupted` — dont la définition est que la page n'a pas la main.
Android Chrome suspend de même un contexte dont l'onglet est caché, et ce qu'il laisse tourner
ensuite dépend du réglage de batterie du navigateur, pas de la page.

Faire jouer le direct par un vrai élément `<audio>` **est possible** — c'est `ManagedMediaSource`,
disponible sur iPhone depuis Safari 17.1 — mais c'est une autre architecture, décrite plus bas.

Les deux contournements que cette roadmap proposait ont été écartés après vérification. Sortir par un
`MediaStreamAudioDestinationNode` branché sur un `<audio>` donne un résultat différent dans chaque
navigateur — Chromium déclenche les événements de lecture mais `currentTime` n'avance pas — et la
spécification ne dit pas ce qui devrait se passer ; le bâtir dans le chemin audio coûterait la
lecture qui fonctionne sur ordinateur pour un gain incertain. Le fichier muet joué en boucle ne
fonctionne plus depuis plusieurs versions de Safari mobile.

**Ce qui a été fait à la place, le 2026-08-05, dans `src/player/background-audio.ts` :** déclaration
de l'intention audio (`navigator.audioSession.type = "playback"`, ce qui règle au passage le son
coupé par le bouton silencieux d'iOS), commandes de l'écran verrouillé (`navigator.mediaSession`,
état suivant la machine d'états et non le dernier clic), et reprise du son au retour au premier plan.
Douze tests couvrent ce module, dont un qui va du relais réel jusqu'au contexte audio.

Le son ne survit toujours pas à un écran verrouillé sur iPhone. L'auditeur qui rallume son téléphone
retrouve en revanche le direct tout de suite, sans recharger la page.

### La décision qui reste : acheter la veille en latence

Pour qu'un iPhone verrouillé continue de jouer, il faut que le son soit une **ressource média que le
navigateur possède**, pas des échantillons que la page lui pousse. `ManagedMediaSource` le permet
depuis Safari 17.1 : un élément `<audio>` alimenté par la page mais géré par le système, qui prévient
par `startstreaming` et `endstreaming` quand remplir ou lever le pied — y compris parce que l'écran
vient de se verrouiller.

| Ce que ça demande | Ce que ça coûte |
|---|---|
| Empaqueter l'Opus dans un conteneur WebM dans le navigateur | un muxeur à écrire, réel mais pas énorme |
| Vérifier Opus dans WebM sur un vrai iPhone | le parseur WebM MSE de Safari était encore marqué expérimental il y a peu |
| Alimenter un `SourceBuffer` au lieu d'une file d'AudioWorklet | **les profils 200 / 400 / 800 ms ne tiennent plus** |
| Garder l'AudioWorklet pour l'ordinateur | deux chemins de lecture à maintenir |

**La question à trancher est donc : pour qui est faite la page ?** Pour un professeur qui écoute un
mix pendant un appel vidéo, la latence basse est tout le projet et la veille de l'écran ne sert à
rien. Pour quelqu'un qui écoute un direct dans sa poche, c'est l'inverse. Les deux ne se font pas
avec le même chemin audio, et vouloir les deux, c'est accepter d'en maintenir deux.

Rien ne presse : ce choix se prend après les mesures ci-dessous, pas avant.

### À faire

- [x] Chercher l'état actuel de la question avant de coder.
- [x] Déclarer l'intention audio, poser les commandes de l'écran verrouillé, reprendre au retour au
      premier plan.
- [x] ~~Router la sortie par un élément `<audio>`~~ — écarté, voir ci-dessus.
- [ ] **Mesurer sur de vrais téléphones** : combien de temps tient chaque navigateur, écran éteint,
      sur iOS et sur Android, et à quoi ressemble le retour. C'est la seule vérification qui compte,
      et elle demande deux téléphones.
- [ ] Vérifier que le bouton silencieux d'un iPhone ne coupe plus le son.
- [ ] Vérifier que la reconnexion automatique survit à une bascule Wi-Fi vers données mobiles.
- [ ] Si la mesure montre qu'Android tient mieux avec la page installée en application web,
      documenter ce geste — c'est gratuit et cela ne demande aucun code.
- [ ] Suivre l'avancement de l'API Audio Session : c'est le seul chemin standard par lequel une page
      pourrait un jour obtenir une vraie lecture en arrière-plan.

### Vérification courte

- [ ] Les contrôles de lecture apparaissent sur l'écran verrouillé, sur les deux systèmes.
- [ ] Le son revient seul, au direct, dès le déverrouillage du téléphone.
- [ ] Le comportement réel de chaque système est écrit dans `docs/player-web.md`, mesuré et daté.

### Terminé

- [ ] **Bloc 9 validé.** Le code est écrit et testé ; reste la mesure sur téléphones réels.

## Bloc 10 — Plusieurs directs et un lien qui n'est pas public

**Dépendances :** bloc 5, bloc 6.

**But :** qu'un relais serve plusieurs personnes, et qu'un direct ne soit pas forcément public.

Deux limites de la v1 deviennent gênantes dès qu'un inconnu s'en sert.

**Un seul direct par relais.** Le relais tient une session, un token, un publisher. Deux personnes
qui veulent partager un hébergement ne le peuvent pas. La roadmap v1 avait déjà prévu la forme de la
solution : ajouter un segment aux chemins, `wss://relais/listener/<nom>` et
`wss://relais/publisher/<nom>`, sans rien renommer de ce qui existe. Le chemin sans nom continue de
désigner le direct par défaut, donc un device v1 continue de fonctionner.

**Un direct est public dès que son adresse est connue.** C'est un choix assumé de la v1 et c'est le
bon défaut pour une page qu'on donne à un professeur. Ce n'est pas acceptable pour quelqu'un qui
diffuse un morceau non publié. La forme la plus simple d'une réponse est un jeton d'écoute
facultatif dans l'adresse : sans jeton configuré, tout le monde entre, exactement comme aujourd'hui ;
avec un jeton, l'adresse elle-même est le secret.

### À faire

- [ ] Étendre le relais à plusieurs sessions nommées, chacune avec son publisher et ses auditeurs.
      La limite d'auditeurs devient globale au relais, pas par session.
- [ ] Garder le chemin sans nom comme session par défaut : un device v1 doit continuer de publier.
- [ ] Ajouter le nom de session au device, dans le panneau de réglages, à côté de l'adresse.
- [ ] Ajouter un jeton d'écoute facultatif par session, et le refus qui va avec.
- [ ] Étendre la route de santé : l'état par session, sans jamais exposer un jeton.
- [ ] Écrire dans le protocole ce que ces chemins changent — c'est un protocole v1.1, pas un v2 :
      rien de ce qui existe ne change de sens.

### Vérification courte

- [ ] Deux directs simultanés sur un même relais, sans que l'un entende l'autre.
- [ ] Un device configuré comme aujourd'hui, sans nom de session, fonctionne sans modification.
- [ ] Une session protégée refuse un auditeur sans jeton et l'accepte avec.

### Terminé

- [ ] **Bloc 10 validé.**

## Bloc 11 — Connaître et écrire les limites réelles

**Dépendances :** bloc 6, bloc 10.

**But :** pouvoir répondre « combien d'auditeurs ? » avec un chiffre mesuré.

Le relais accepte 50 auditeurs par défaut. Ce nombre est une précaution, pas une mesure. À chaque
frame de 20 ms, le relais fait un envoi par auditeur : c'est 50 envois toutes les 20 ms, soit
2 500 par seconde. Personne n'a vérifié où ce chiffre casse, ni combien de mémoire et de bande
passante il demande.

Un projet public a besoin de cette réponse, parce que c'est la première question qu'on lui posera,
et parce qu'une limite annoncée à tort est pire que pas de limite du tout.

### À faire

- [ ] Écrire un banc de charge : N auditeurs simulés sur un relais réel, montée progressive.
- [ ] Mesurer processeur, mémoire, bande passante sortante et retard de diffusion selon N.
- [ ] Trouver le point où les compteurs `listenerFramesDropped` et `listenersClosedSlow` décollent.
- [ ] En déduire une limite par défaut honnête et la justifier dans la documentation.
- [ ] Écrire ce que coûte un auditeur en bande passante à chaque profil de qualité : c'est le
      chiffre dont quelqu'un a besoin pour choisir son hébergement.
- [ ] Documenter ce qui se passe au-delà : le refus HTTP 503 existe déjà, dire ce que l'auditeur voit.

### Vérification courte

- [ ] La limite documentée est tenue pendant trente minutes sans dégradation.
- [ ] Le comportement au-delà de la limite est celui qui est écrit.

### Terminé

- [ ] **Bloc 11 validé.**

---

## Phase 4 — Faire vivre le projet

## Bloc 12 — Publier la version 1.0 et la faire connaître

**Dépendances :** blocs 1 à 9. Les blocs 10 et 11 sont souhaitables, pas bloquants.

**But :** que le projet existe pour d'autres que son auteur.

Un dépôt public que personne ne trouve n'est pas un projet libre, c'est une sauvegarde.

### À faire

- [ ] Passer le dépôt en public et publier la version `v1.0.0` avec le device Windows, le device
      macOS si le bloc 8 est fait, et l'image du relais.
- [ ] Écrire l'annonce : le problème, ce que fait l'outil, ce qu'il ne fait pas, comment l'essayer.
      Les limites en premier — c'est ce qui distingue une annonce crédible d'une publicité.
- [ ] La poster là où sont les gens concernés : les forums Ableton et Cycling '74, les communautés
      de production musicale, les agrégateurs de projets libres.
- [ ] Enregistrer une démonstration d'une minute : le device sur la piste Master, un clic, le son
      dans un navigateur. C'est plus convaincant que tout le reste de cette roadmap.
- [ ] Décider du temps que Vassi accepte d'y consacrer chaque semaine, et l'écrire dans le README.
      Un projet libre qui ne répond pas perd sa réputation plus vite qu'il ne l'a gagnée.
- [ ] Décider quoi faire des demandes hors périmètre. La liste des refus assumés est aussi utile
      que la liste des fonctionnalités.

### Vérification courte

- [ ] Une personne qui n'a jamais parlé à Vassi installe le système et lance un direct, sans aide.
- [ ] Le premier rapport de bug extérieur reçoit une réponse.

### Terminé

- [ ] **Projet publié.**

---

## Ordre conseillé et ce qu'il faut faire d'abord

Les blocs 1 à 4 se font dans l'ordre et vont vite. Ils ne changent aucun comportement, et à leur
issue le dépôt peut devenir public sans risque légal ni fuite de secret.

Le bloc 5 est le point de bascule. Sans page d'écoute dans le dépôt, un projet public reste une
démonstration de code : personne ne peut s'en servir. Il vaut mieux le faire avant de rendre le
dépôt public que de publier quelque chose d'inutilisable.

Les blocs 8 et 9 — macOS et le mobile — décident du nombre de gens que le projet peut atteindre.
Aucun des deux n'est bloquant pour publier, les deux sont bloquants pour être adopté.

Les blocs 10 et 11 peuvent attendre les premiers retours. Deviner ce que les utilisateurs voudront
coûte plus cher que le leur demander.

## Ce que cette roadmap ne traite pas

Ces points reviendront, et la réponse est non pour la v2 :

- **Un service hébergé.** Faire tourner un relais pour les autres, c'est prendre une responsabilité
  d'exploitation, un coût, et une exposition juridique sur ce que les gens diffusent.
- **Un portage VST3 ou AU.** Ce serait un autre projet : il faudrait refaire toute l'interface hors
  de Max et gérer trois formats de plugin.
- **L'audio sans perte.** Opus 256 kbit/s est transparent pour l'usage visé. Le PCM multiplierait la
  bande passante par six pour un gain que personne n'entendrait dans une conversation vidéo.
- **L'enregistrement du direct.** Le relais ne stocke rien, et c'est ce qui le rend simple, sûr et
  léger. Enregistrer changerait sa nature.

## Rappel pour l'agent qui implémente

Avant un bloc, relire [Roadmap.md](../Roadmap.md) et ce document. Les décisions de la v1 restent
valables : elles ont été prises avec leurs raisons, et une raison ne cesse pas d'être vraie parce
que le projet devient public.

Les trois décisions du bloc 1 — licence, nom, domaine — appartiennent à Vassi seul. Ne pas les
deviner, ne pas les prendre par défaut, ne pas avancer sur les autres blocs avant qu'elles soient
écrites ici avec leur date.
