import { AUDIO_STALL_MS } from "./player-diagnostics.ts";

// Ce module repond a une seule question : le decodeur doit-il ecrire dans la file PCM ?
//
// Trois signaux y repondent ensemble, et ils arrivent de trois endroits differents. La machine
// d'etats dit si le son est souhaite. Le contexte audio dit s'il tourne. Le niveau annonce par le
// processeur dit si le thread audio rend encore la main, ce que le contexte, lui, ne dit pas
// toujours : il reste `running` pendant une mise en veille de la machine, un onglet gele ou un
// peripherique de sortie qui bafouille.
//
// Les trois tiennent ensemble parce que leur consequence est la meme : remplir une file que personne
// ne vide. En memoire partagee, elle bute sur ses trois secondes et compte des blocs abandonnes ; en
// mode messages, la file d'attente du port grossit sans aucune limite, a 384 ko par seconde.
//
// La reponse ne depend d'aucune piece du navigateur, donc elle se verifie sous Node.
export class FillGate {
  private soundWanted = false;
  private contextRunning = true;
  private audioAlive = true;

  // Cette date est celle du dernier niveau annonce. Elle vaut `null` tant qu'aucun n'est arrive :
  // rien ne permet alors de juger le thread audio, et le portail lui fait credit.
  private lastLevelAt: number | null = null;

  // Cette methode rend la reponse courante.
  get open(): boolean {
    return this.soundWanted && this.contextRunning && this.audioAlive;
  }

  // Cette methode rend la demande de la machine d'etats seule. Elle sert a decider s'il faut tenter
  // de reprendre un contexte suspendu : ce n'est la peine que si le son est souhaite.
  get wanted(): boolean {
    return this.soundWanted;
  }

  // Cette methode enregistre ce que la machine d'etats demande.
  setWanted(wanted: boolean): void {
    this.soundWanted = wanted;
  }

  // Cette methode enregistre ce que le contexte audio annonce.
  setContextRunning(running: boolean): void {
    this.contextRunning = running;
  }

  // Cette methode note un niveau annonce par le processeur audio. C'est la seule preuve que le thread
  // audio tourne, et elle rouvre le portail apres un arret constate.
  noteLevel(at: number): void {
    this.lastLevelAt = at;
    this.audioAlive = true;
  }

  // Cette methode constate un thread audio qui ne rend plus la main.
  //
  // Le processeur annonce son niveau toutes les quarante millisecondes environ tant qu'il tourne :
  // une demi-seconde de silence veut dire qu'il s'est arrete.
  checkStall(at: number): void {
    if (this.lastLevelAt !== null && at - this.lastLevelAt > AUDIO_STALL_MS) {
      this.audioAlive = false;
    }
  }

  // Cette methode remet le portail dans l'etat d'un moteur qui n'a encore rien construit.
  reset(): void {
    this.soundWanted = false;
    this.contextRunning = true;
    this.audioAlive = true;
    this.lastLevelAt = null;
  }
}
