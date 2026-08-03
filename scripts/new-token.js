// Ce script tire un token de publication aleatoire. Le meme token est ensuite pose des deux cotes :
// dans la variable d'environnement `VASSI_PUBLISHER_TOKEN` du relais Sliplane, et dans la
// configuration du device par `npm run config:publisher`.
//
// Le token fait 32 octets aleatoires, ecrits en hexadecimal : 64 caracteres, bien au-dela du
// minimum exige par le relais. Il vient d'un generateur cryptographique, donc il n'est pas
// devinable a partir de l'heure ou d'un compteur.
import { randomBytes } from "node:crypto";

console.log(randomBytes(32).toString("hex"));
