# Cette image contient le relais WebSocket deploye sur Sliplane. Elle ne contient ni le device
# Max for Live, ni les sources natives : le relais n'a besoin que de Node, de `ws` et du module
# de protocole partage.
#
# Node 24 execute directement les fichiers TypeScript en effacant leurs annotations de type.
# Le projet garde donc une seule version du code, sans etape de compilation qui pourrait diverger.
FROM node:24-alpine

# Le mode production desactive les verifications de developpement de Node et des bibliotheques.
ENV NODE_ENV=production
# Sliplane impose un port entre 8080 et 65535 et le transmet par la variable `PORT`.
ENV PORT=8080

WORKDIR /app

# Les dependances sont installees avant le code : une modification du code ne relance pas
# l'installation, ce qui garde les deploiements courts.
COPY relay/package.json relay/package-lock.json ./relay/
RUN cd relay && npm ci --omit=dev

# Le module de protocole est partage avec le device et la page `/session` : il reste a sa place.
COPY src/protocol ./src/protocol
COPY relay ./relay

# Le processus tourne sous un compte sans privilege, deja present dans l'image officielle.
USER node

EXPOSE 8080

# Node recoit le signal d'arret directement, sans shell intermediaire : le relais peut donc
# annoncer la fin du direct aux auditeurs avant de fermer.
CMD ["node", "relay/main.ts"]
