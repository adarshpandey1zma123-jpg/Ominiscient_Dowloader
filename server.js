try {
    require('dotenv').config();
} catch (e) {
    console.warn('[Server] dotenv module not found. Proceeding with raw process.env.');
}

const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const storage = require('./storage');

let rateLimit = null;
try {
    rateLimit = require('express-rate-limit');
} catch (e) {
    console.warn('[Server] express-rate-limit module not found. Rate limiting is disabled.');
}

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy is required if deploying behind a load balancer (like Render, Heroku, Cloudflare)
app.set('trust proxy', 1);

// --- Middleware Configuration ---
app.use(cors());
app.use(express.static('public'));

// Apply Rate Limiting if package is installed
if (rateLimit) {
    const apiLimiter = rateLimit({
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 mins default
        max: parseInt(process.env.RATE_LIMIT_MAX) || 150, // 150 requests per IP
        message: { error: 'Too many requests from this IP. Please try again after 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn(`Rate limit exceeded for IP: ${req.ip} on route ${req.originalUrl}`);
            res.status(options.statusCode).json(options.message);
        }
    });

    const downloadLimiter = rateLimit({
        windowMs: parseInt(process.env.DOWNLOAD_LIMIT_WINDOW_MS) || 60 * 60 * 1000, // 1 hour default
        max: parseInt(process.env.DOWNLOAD_LIMIT_MAX) || 20, // 20 downloads/info lookups per hour
        message: { error: 'Download limit reached for this hour. Please try again later.' },
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res, next, options) => {
            logger.warn(`Download/Info limit reached for IP: ${req.ip} on URL: ${req.query.url}`);
            res.status(options.statusCode).json(options.message);
        }
    });

    app.use('/api/', apiLimiter);
    app.use('/api/info', downloadLimiter);
    app.use('/api/download', downloadLimiter);
}

// Store SSE clients: jobId -> res
const progressClients = new Map();

// Map to track active jobs meta: tempId -> { s3Key, filename, localPath }
const activeJobs = new Map();

// Normalize any YouTube URL variant to a standard watch URL
function normalizeYouTubeUrl(url) {
    try {
        const parsed = new URL(url);
        let videoId = null;

        if (parsed.hostname === 'youtu.be') {
            videoId = parsed.pathname.replace('/', '');
        } else if (parsed.hostname.includes('youtube.com')) {
            if (parsed.pathname.startsWith('/shorts/')) {
                videoId = parsed.pathname.replace('/shorts/', '');
            } else {
                videoId = parsed.searchParams.get('v');
            }
        }

        if (videoId) {
            videoId = videoId.split('?')[0].split('&')[0].split('/')[0];
            return `https://www.youtube.com/watch?v=${videoId}`;
        }
        return url;
    } catch {
        return url;
    }
}

// SSE endpoint - client connects here to receive progress updates
app.get('/api/progress', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Job ID required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    progressClients.set(id, res);
    logger.info(`SSE client connected. Job ID: ${id}`);

    // Send immediate confirmation that SSE is connected
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    req.on('close', () => {
        progressClients.delete(id);
        logger.info(`SSE client disconnected. Job ID: ${id}`);
    });
});

function sendProgress(jobId, data) {
    const client = progressClients.get(jobId);
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// Fetch Video Information
app.get('/api/info', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    url = normalizeYouTubeUrl(url);
    logger.info(`Info request received for URL: ${url} from IP: ${req.ip}`);

    try {
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true,
            noPlaylist: true,
            noCheckFormats: true,
            skipDownload: true
        });

        const specificResolutions = [4320, 2160, 1440, 1080, 720, 480, 360];
        let formats = [];

        // Build a map of resolution -> estimated filesize
        const filesizeMap = {};
        info.formats.forEach(format => {
            if (format.vcodec !== 'none' && format.height) {
                if (!formats.includes(format.height)) {
                    formats.push(format.height);
                }
                const size = format.filesize || format.filesize_approx;
                if (size && (!filesizeMap[format.height] || size > filesizeMap[format.height])) {
                    filesizeMap[format.height] = size;
                }
            }
        });

        formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
        formats = [...new Set(formats)];

        const formatsWithSize = formats.map(h => ({
            height: h,
            filesize: filesizeMap[h] || null
        }));

        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            formats: formatsWithSize
        });

    } catch (error) {
        const errMsg = error.stderr || error.message || 'Unknown error';
        logger.error(`Error in /api/info: ${errMsg}`);
        res.status(500).json({ error: 'Failed to fetch video info: ' + errMsg });
    }
});

// Download Video (MP4) or Audio (MP3)
app.get('/api/download', async (req, res) => {
    let { url, quality, jobId, format } = req.query;
    if (!url || !jobId) return res.status(400).json({ error: 'URL and jobId are required' });
    
    format = format === 'mp3' ? 'mp3' : 'mp4';
    url = normalizeYouTubeUrl(url);
    
    logger.info(`Download request received. Format: ${format}, Quality: ${quality || 'audio'}, URL: ${url}`);

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    // Determine output file template
    let outputPathTemplate;
    if (format === 'mp3') {
        outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s.%(ext)s`);
    } else {
        outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);
    }

    // Acknowledge the request immediately to prevent client browser timeout
    res.json({ success: true, message: 'Download initiated successfully' });

    // Process download asynchronously in the background
    try {
        let args = [];
        if (format === 'mp3') {
            args = [
                url,
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '0', // Best quality VBR
                '--output', outputPathTemplate,
                '--ffmpeg-location', ffmpegStatic,
                '--no-check-certificates',
                '--no-warnings',
                '--concurrent-fragments', '16',
                '--buffer-size', '1024K',
                '--http-chunk-size', '10M',
                '--newline',
                '--add-header', 'referer:youtube.com',
                '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ];
        } else {
            // Do not force [ext=mp4] on video input stream (as YouTube stores 4K/8K in WebM/VP9/AV1 format).
            // ffmpeg will automatically merge and remux it to MP4 output container.
            let formatString = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
            args = [
                url,
                '--format', formatString,
                '--merge-output-format', 'mp4',
                '--output', outputPathTemplate,
                '--ffmpeg-location', ffmpegStatic,
                '--no-check-certificates',
                '--no-warnings',
                '--concurrent-fragments', '16',
                '--buffer-size', '1024K',
                '--http-chunk-size', '10M',
                '--retries', '3',
                '--fragment-retries', '3',
                '--newline',
                '--add-header', 'referer:youtube.com',
                '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ];
        }

        const ytdlpPath = youtubedl.constants.YOUTUBE_DL_PATH;
        const { spawn } = require('child_process');

        logger.info(`Spawning download process for job: ${jobId}`);

        const progressRegex = /\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)(?:\s+ETA\s+([\d:]+))?/;

        await new Promise((resolve, reject) => {
            const child = spawn(ytdlpPath, args);

            let buffer = '';
            child.stdout.on('data', data => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop(); // keep incomplete line

                for (const line of lines) {
                    const match = line.match(progressRegex);
                    if (match) {
                        const progressData = {
                            percent: parseFloat(match[1]),
                            totalSize: match[2].trim(),
                            speed: match[3].trim(),
                            eta: match[4] ? match[4].trim() : null
                        };
                        sendProgress(jobId, { type: 'progress', ...progressData });
                    }
                }
            });

            child.stderr.on('data', data => {
                logger.error(`yt-dlp stderr [Job ${jobId}]: ${data}`);
            });

            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`yt-dlp exited with code ${code}`));
            });
            child.on('error', reject);
        });

        logger.info(`Download finished successfully for job: ${jobId}`);
        sendProgress(jobId, { type: 'merging' });

        // Locate the created file in the downloads folder
        const files = fs.readdirSync(downloadsDir);
        const targetFile = files.find(f => f.startsWith(tempId));

        if (!targetFile) {
            throw new Error("File not found on disk after download completion.");
        }

        const downloadName = targetFile.replace(`${tempId}---`, '');
        const finalLocalPath = path.join(downloadsDir, targetFile);

        // Upload to Cloud Storage if S3 is configured and enabled
        if (storage.isCloudEnabled()) {
            logger.info(`Uploading file to S3 Cloud Storage: ${downloadName}`);
            const s3Key = `downloads/${tempId}/${downloadName}`;
            
            await storage.uploadFile(finalLocalPath, s3Key);
            logger.info(`Upload completed. Deleting local temporary file.`);
            
            fs.unlinkSync(finalLocalPath);
            
            activeJobs.set(tempId, {
                s3Key,
                filename: downloadName,
                localPath: null
            });
        } else {
            activeJobs.set(tempId, {
                s3Key: null,
                filename: downloadName,
                localPath: finalLocalPath
            });
        }

        // Notify client that file is ready
        sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });

    } catch (error) {
        logger.error(`Background download error for job ${jobId}: ${error.message}`);
        sendProgress(jobId, { type: 'error', message: 'Failed to download/process video.' });
    }
});

// Serve the file directly to the client (streaming it secure and privately)
app.get('/api/serve', async (req, res) => {
    const { tempId, filename } = req.query;
    if (!tempId || !filename) return res.status(400).send('Missing file parameters');

    const job = activeJobs.get(tempId);

    // Support serving local files if not uploaded to cloud (local fallback)
    if (!job || !job.s3Key) {
        const localPath = job ? job.localPath : path.join(__dirname, 'downloads', `${tempId}---${filename}`);
        if (!fs.existsSync(localPath)) {
            logger.error(`Serve File Not Found locally: ${localPath}`);
            return res.status(404).send('File not found or expired');
        }

        logger.info(`Serving file from local disk: ${filename}`);
        return res.download(localPath, filename, (err) => {
            if (err) {
                logger.error(`Error serving local file ${filename}: ${err.message}`);
            }
            fs.unlink(localPath, (unlinkErr) => {
                if (unlinkErr) logger.error(`Failed to delete local temp file: ${unlinkErr.message}`);
                else logger.info(`Deleted local temp file: ${localPath}`);
            });
            activeJobs.delete(tempId);
        });
    }

    // Serve from Cloud Storage
    try {
        logger.info(`Streaming file from Cloud Storage to browser: ${job.filename}`);
        
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
        res.setHeader('Content-Type', job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');

        const cloudStream = await storage.downloadStream(job.s3Key);
        
        cloudStream.pipe(res);

        cloudStream.on('end', async () => {
            logger.info(`Finished streaming file from cloud: ${job.s3Key}`);
            
            // Delete file from S3 to keep storage usage low/zero (configurable)
            if (process.env.DELETE_FROM_CLOUD_AFTER_DOWNLOAD !== 'false') {
                try {
                    await storage.deleteFile(job.s3Key);
                    logger.info(`Deleted file from S3: ${job.s3Key}`);
                } catch (delErr) {
                    logger.error(`Error deleting file from S3: ${delErr.message}`);
                }
            }
            activeJobs.delete(tempId);
        });

        cloudStream.on('error', (err) => {
            logger.error(`Error during cloud streaming: ${err.message}`);
            if (!res.headersSent) {
                res.status(500).send('Error streaming file from cloud');
            }
            activeJobs.delete(tempId);
        });

    } catch (error) {
        logger.error(`Failed to fetch and serve from S3: ${error.message}`);
        res.status(500).send('Error serving file from cloud storage');
    }
});

// Global Error Handler
app.use((err, req, res, next) => {
    logger.error(`Unhandled Exception: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT} (accessible via local network)`);
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    logger.info('SIGTERM signal received. Synchronizing logs and shutting down...');
    await logger.syncLogs();
    process.exit(0);
});