# Use Node 20 slim image for modern JS features and AWS SDK compatibility
FROM node:20-slim

# Install system dependencies:
# - python3: Required by yt-dlp to run
# - ffmpeg: Required to merge video and audio formats
# - ca-certificates: Required for secure HTTPS requests
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    ffmpeg \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy dependency definition files
COPY package*.json ./

# Install production dependencies only to save build time and disk space
RUN npm install --omit=dev

# Copy remaining source code files
COPY . .

# Ensure downloads and logs directories exist with write access
RUN mkdir -p downloads logs && chmod 777 downloads logs

# Set production environment values
ENV NODE_ENV=production
ENV PORT=3000

# Expose server port
EXPOSE 3000

# Launch server.js
CMD ["npm", "start"]
