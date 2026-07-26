FROM node:22-bookworm

# llama-server is NOT installed — this tests the "nothing installed" flow
# To test with llama-server, uncomment the next line:
# RUN apt-get update && apt-get install -y llama-cpp-server && apt-get clean

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Default: run as brand new user
ENV HOME=/tmp/test-home
ENV MINIMAL_DIR=/tmp/test-minimal
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN mkdir -p /tmp/test-home /tmp/test-minimal

ENTRYPOINT ["node", "bin/minimal-ai.mjs"]