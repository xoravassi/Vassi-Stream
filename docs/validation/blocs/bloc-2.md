# Validation courte - Bloc 2

Date : 2026-08-02.

## Resultat

L'objet MSP natif `vassi.encoder~` est implemente comme capture passive minimale.

## Fichiers du bloc

- `externals/vassi.encoder~/source/vassi.encoder.cpp` cree l'objet natif.
- `externals/vassi.encoder~/README.md` documente le choix Max SDK, le build attendu et le test debutant dans Ableton Live 11.
- `patchers/vassi.encoder.passive-test.maxpat` verifie le routage passif dans Max for Live.
- `tests/msp-static.test.ts` controle statiquement les invariants du bloc.

## Recherche technique verifiee

Sources consultees :

- Max SDK, anatomie d'un objet MSP : https://sdk.cdn.cycling74.com/max-sdk-8.2.0/chapter_msp_anatomy.html
- Max SDK, migration `dsp64` 64 bits : https://sdk.cdn.cycling74.com/max-sdk-7.1.0/chapter_appendix_d.html
- Min-DevKit, objets audio : https://cycling74.github.io/min-devkit/guide/audio
- Cycling '74 Support, Max 8+ en 64 bits : https://support.cycling74.com/hc/en-us/articles/360050778693-Information-about-64-bit-vs-32-bit

Decision :

- Max SDK direct est choisi pour ce bloc.
- Min-DevKit reste utile pour des externals plus abstraits, mais il ajoute une couche inutile pour deux entrees signal et un callback `dsp64`.

## Points valides localement

- La source declare l'objet `vassi.encoder~`.
- La source cree deux entrees signal avec `dsp_setup`.
- La source enregistre `dsp64` avec `class_addmethod`.
- `dsp64` ajoute la routine audio avec `dsp_add64`.
- Le patch test relie `plugin~` directement a `plugout~`.
- Le patch test relie aussi les deux sorties de `plugin~` aux deux entrees de `vassi.encoder~`.
- La routine `perform64` ne contient pas d'allocation, de log Max, d'appel reseau ou de sortie message.
- Le bloc 1 continue de passer avec `npm run check`.

## Verification executee

Commande complete :

```powershell
npm.cmd run check
```

Resultat :

```text
TypeScript errors 0
tests 37
pass 37
fail 0
```

## Points a valider dans Max/Ableton

- Compiler `vassi.encoder~.mxe64` avec le Max SDK installe localement. Valide le 2026-08-02.
- Charger l'objet dans Max 8.5.8 sans erreur. Valide par Vassi le 2026-08-02.
- Charger le patch test dans Ableton Live 11 Suite.
- Verifier que `bang` affiche des compteurs gauche et droite superieurs a zero. Valide par Vassi le 2026-08-02 avec des compteurs gauche et droite en hausse.
- Verifier par ecoute que le chemin `plugin~` vers `plugout~` reste identique quand l'objet est present ou non connecte. Valide par Vassi le 2026-08-02.

## Limites reportees

- La compilation native n'est pas executee ici parce que le Max SDK n'est pas present dans le depot.
- Le bloc 3 ajoutera la queue audio preallouee ; le bloc 2 ne copie pas encore les samples.

## Decision

Le Bloc 2 est valide. L'objet natif se charge dans Max, recoit les deux canaux et ne modifie pas le son audible.
