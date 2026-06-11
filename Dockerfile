# Use the official Node.js image
FROM node:22-bookworm-slim

WORKDIR /app

# Copy dependency definitions and install production deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# The orchestrator REST API port
EXPOSE 3008

# Note: this container must be run with the host Docker socket mounted
#   -v /var/run/docker.sock:/var/run/docker.sock
# so it can create/start/stop sibling browser containers.
CMD ["node", "server.js"]
