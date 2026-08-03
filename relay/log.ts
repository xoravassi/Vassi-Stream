// Ce module ecrit une ligne JSON par evenement sur la sortie standard, ce que Sliplane collecte.
// Il ne recoit jamais de token ni d'octet audio : les appelants ne lui passent que des compteurs
// et des codes courts.

// Ce type limite les valeurs qu'un evenement peut porter a des donnees non sensibles.
export type LogFields = Record<string, string | number | boolean | null>;

// Cette fonction ecrit un evenement date. Elle absorbe toute erreur d'ecriture : un tube de sortie
// ferme par l'hebergeur ne doit pas arreter la diffusion audio.
export function log(event: string, fields: LogFields = {}): void {
  try {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
  } catch {
    // Le relais continue de fonctionner sans journal.
  }
}
