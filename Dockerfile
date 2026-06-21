FROM node:20-slim

RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip && \
    pip3 install --break-system-packages faster-whisper && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./
COPY transcribe.py ./

EXPOSE 3000

CMD ["node", "server.js"]
