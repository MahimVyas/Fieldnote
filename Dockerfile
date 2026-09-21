FROM node:25-alpine
WORKDIR /app
COPY package.json server.js agents.js index.html script.js style.css favicon.svg LICENSE README.md ./
RUN addgroup -S fieldnote && adduser -S fieldnote -G fieldnote && mkdir -p /var/lib/fieldnote/documents && chown -R fieldnote:fieldnote /app /var/lib/fieldnote
USER fieldnote
ENV NODE_ENV=production PORT=3000 FIELDNOTE_DATA_PATH=/var/lib/fieldnote/research.json FIELDNOTE_DOCUMENTS_PATH=/var/lib/fieldnote/documents
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]