FROM node:20-slim

RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip wget unzip && \
    pip3 install --break-system-packages vosk && \
    wget -q https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip -O /tmp/vosk-model.zip && \
    unzip -q /tmp/vosk-model.zip -d /app/ && \
    mv /app/vosk-model-small-en-us-0.15 /app/vosk-model && \
    rm /tmp/vosk-model.zip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js ./
COPY transcribe.py ./

EXPOSE 3000

CMD ["node", "server.js"]
