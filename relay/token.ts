import { createHash, timingSafeEqual } from "node:crypto";

// Ce module compare le token recu et le token attendu sans laisser fuiter d'information.
//
// Une comparaison `===` s'arrete au premier caractere different : le temps de reponse revele alors
// combien de caracteres sont deja corrects, ce qui permet de deviner un token caractere par
// caractere. `timingSafeEqual` compare en temps constant, mais il refuse deux tampons de tailles
// differentes. Les deux valeurs passent donc d'abord par SHA-256 : les empreintes font toujours
// 32 octets, donc la longueur du token n'apparait plus dans le temps de comparaison.

// Cette fonction dit si les deux tokens sont identiques, en temps constant.
export function tokensMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") {
    return false;
  }

  return timingSafeEqual(digestOf(expected), digestOf(received));
}

// Cette fonction reduit un token a une empreinte de taille fixe.
function digestOf(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}
