# Use Node 20 slim base image
FROM node:20-slim

# Install system dependencies + GPG + Cloudflare WARP client
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    ca-certificates \
    curl \
    gnupg \
    procps \
    && curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ bookworm main" | tee /etc/apt/sources.list.d/cloudflare-client.list \
    && apt-get update && apt-get install -y --no-install-recommends cloudflare-warp \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package definitions and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy remaining project files
COPY . .

# Set execution permissions for start.sh script
RUN chmod +x start.sh && mkdir -p downloads logs && chmod 777 downloads logs

# Environment configuration
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Entrypoint via start.sh
CMD ["./start.sh"]
