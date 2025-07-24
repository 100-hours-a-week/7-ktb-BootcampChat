FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

COPY .env .env

EXPOSE 5000

CMD ["node", "server.js"]
