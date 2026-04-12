FROM node:20-alpine

WORKDIR /app

COPY simulators/order-simulator/package*.json ./
RUN npm install

COPY simulators/order-simulator/ ./

EXPOSE 3002

CMD ["node", "index.js"]
