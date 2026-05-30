FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npm run prisma:generate

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "start:docker"]
