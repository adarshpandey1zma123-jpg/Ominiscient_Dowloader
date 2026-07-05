# Production Deployment Guide

This guide details how to build, run locally with Docker, configure Cloud Storage, and deploy the backend service to **Render** as a production-ready application.

---

## 🏗️ Part 1: Setting Up Cloud Storage (S3 / Cloudflare R2)

To deploy on Render's Free tier, you **must** use Cloud Storage to hold files during downloads, as Render container disks are ephemeral and limited to 512MB of RAM/disk storage.

### Option A: Cloudflare R2 (Recommended - Free Tier Available)
Cloudflare R2 is fully S3-compatible, offers a generous free tier (10 GB/month), and has zero egress bandwidth charges.
1. Sign in to your **Cloudflare Dashboard** and click on **R2** in the sidebar.
2. Click **Create bucket**. Name it (e.g., `omniscient-downloader`).
3. Click **Manage R2 API Tokens** on the right.
4. Click **Create API Token**.
   - Permissions: **Edit** (Read & Write).
   - TTL: **Forever** (or preferred duration).
5. Copy your **Access Key ID**, **Secret Access Key**, and **Endpoint**.
   - Your Endpoint will look like: `https://<account_id>.r2.cloudflarestorage.com`

### Option B: Amazon Web Services S3
1. Log in to the **AWS Console** and search for **S3**.
2. Click **Create Bucket**.
   - Uncheck "Block all public access" (if you want direct downloads) or leave checked (since our server streams it securely, keeping public access blocked is safer!).
3. Go to **IAM (Identity and Access Management)**.
4. Create a new user with programmatic access, and attach the `AmazonS3FullAccess` policy (or create a custom policy restricted to your bucket).
5. Generate and copy the **Access Key ID** and **Secret Access Key**.

---

## 🐳 Part 2: Local Development with Docker

You can run the entire production configuration locally using Docker to verify it builds and runs correctly.

1. Install **Docker** and **Docker Compose** on your system.
2. Create a `.env` file in the root folder:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and fill in your Cloud Storage credentials. If you leave them blank, the application will fallback to storing files on your local hard disk (`/downloads`).
4. Run the containers:
   ```bash
   docker-compose up --build
   ```
5. Open **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## 🚀 Part 3: Deploying on Render (Host Backend)

Render supports deploying containerized applications directly using the `Dockerfile` we created.

### Method 1: Blueprint Deployment (One-Click Render Config)
Render automatically detects the [render.yaml](file:///c:/Users/hp/OneDrive/Attachments/Documents/projects/Dowload%20High%20Qualtty%20Powered%20By%20Omniscient%20Intelligence/render.yaml) blueprint file when you connect your Git repository.
1. Push your code repository to **GitHub** or **GitLab**.
2. Log in to the **Render Dashboard**.
3. Click **New** -> **Blueprint**.
4. Select your connected GitHub/GitLab repository.
5. Render will automatically detect the service configuration from `render.yaml`.
6. Provide the values for the S3 credentials in the prompt when requested.
7. Click **Approve**. Render will build and deploy the container automatically!

### Method 2: Manual Service Creation
If you prefer configuring it step-by-step in the Render UI:
1. Log in to **Render Dashboard** and click **New** -> **Web Service**.
2. Select your code repository.
3. In the setup settings:
   - **Language/Runtime**: Select **Docker**.
   - **Branch**: `main` or your active branch.
   - **Plan**: Select **Free**.
4. Scroll down and click **Advanced** to add **Environment Variables**:
   - `PORT`: `3000`
   - `NODE_ENV`: `production`
   - `S3_ACCESS_KEY_ID`: *(Your key)*
   - `S3_SECRET_ACCESS_KEY`: *(Your secret)*
   - `S3_BUCKET_NAME`: *(Your bucket name)*
   - `S3_REGION`: *(e.g. us-east-1)*
   - `S3_ENDPOINT`: *(Required if using Cloudflare R2/custom)*
   - `DELETE_FROM_CLOUD_AFTER_DOWNLOAD`: `true`
5. Click **Create Web Service**. 

Render will allocate an HTTPS URL for you (e.g. `https://omniscient-downloader-backend.onrender.com`).

---

## 📱 Part 4: Connecting the Android Frontend

Now that the backend is live, you must configure your Android application to talk to it.

1. Open your Android project in Android Studio.
2. Locate [MainActivity.java](file:///c:/Users/hp/OneDrive/Attachments/Documents/projects/Dowload%20High%20Qualtty%20Powered%20By%20Omniscient%20Intelligence/MainActivity.java#L32).
3. Replace the placeholder URL on line 32 with your new live Render backend URL:
   ```java
   myWebView.loadUrl("https://omniscient-downloader-backend.onrender.com");
   ```
4. Build and run your Android app. It will load the responsive live downloader UI and process downloads directly via the Render backend!

---

## 🔒 Part 5: Production Best Practices

- **Automatic Cleanup**: Ensure `DELETE_FROM_CLOUD_AFTER_DOWNLOAD` is set to `true`. This guarantees that immediately after a file is streamed to the user's browser, it is deleted from your cloud storage bucket. This keeps your bucket empty, ensuring you stay in free-tier limits.
- **Secure Endpoints**: Render automatically provisions and manages an SSL certificate, providing an `https://` endpoint out of the box. Ensure your Android app always uses `https://` for secure communications.
- **Abuse Prevention**: If you experience high traffic, adjust `DOWNLOAD_LIMIT_MAX` and `RATE_LIMIT_MAX` in your environment variables to lock down abuse and control cloud costs.
