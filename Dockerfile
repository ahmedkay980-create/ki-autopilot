FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY assets ./assets
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4747 DATA_DIR=/app/data TZ=Europe/Berlin
EXPOSE 4747
CMD ["node", "server.js"]
