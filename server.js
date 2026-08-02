try {
    require('dotenv').config();
} catch (e) {}

const express = require('express');
const cors = require('cors');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');
const storage = require('./storage');

let youtubedl = null;
try {
    youtubedl = require('youtube-dl-exec');
} catch (e) {
    console.warn('[Server] youtube-dl-exec notice:', e.message);
}

// Ensure binary execution permissions
try {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        fs.chmodSync(ffmpegStatic, 0o755);
    }
    const ytdlpPath = (youtubedl && youtubedl.constants) ? youtubedl.constants.YOUTUBE_DL_PATH : null;
    if (ytdlpPath && fs.existsSync(ytdlpPath)) {
        fs.chmodSync(ytdlpPath, 0o755);
    }
} catch (chmodErr) {}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Progress clients map: jobId -> res
const progressClients = new Map();
// Active downloads map: tempId -> file metadata
const activeJobs = new Map();

// Helper to normalize YouTube URLs
function normalizeYouTubeUrl(inputUrl) {
    try {
        const parsed = new URL(inputUrl);
        let videoId = null;
        if (parsed.hostname.includes('youtu.be')) {
            videoId = parsed.pathname.replace('/', '').split('?')[0];
        } else if (parsed.hostname.includes('youtube.com')) {
            if (parsed.pathname.startsWith('/shorts/')) {
                videoId = parsed.pathname.replace('/shorts/', '').split('?')[0];
            } else {
                videoId = parsed.searchParams.get('v');
            }
        }
        if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    } catch (e) {}
    return inputUrl;
}

function extractVideoId(url) {
    try {
        const parsed = new URL(url);
        if (parsed.hostname.includes('youtu.be')) return parsed.pathname.replace('/', '').split('?')[0];
        if (parsed.hostname.includes('youtube.com')) {
            if (parsed.pathname.startsWith('/shorts/')) return parsed.pathname.replace('/shorts/', '').split('?')[0];
            return parsed.searchParams.get('v');
        }
    } catch (e) {}
    return null;
}

// Stream Downloader (using Node https module)
function downloadStreamToFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const protocol = url.startsWith('https') ? require('https') : require('http');
        
        const req = protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Referer': 'https://www.youtube.com/'
            },
            timeout: 120000
        }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                downloadStreamToFile(response.headers.location, destPath, maxRedirects - 1).then(resolve).catch(reject);
                return;
            }
            if (response.statusCode !== 200) {
                return reject(new Error(`HTTP ${response.statusCode} downloading stream`));
            }
            
            const file = fs.createWriteStream(destPath);
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    const stat = fs.statSync(destPath);
                    if (stat.size < 1000) {
                        reject(new Error('Downloaded file too small'));
                    } else {
                        resolve();
                    }
                });
            });
            file.on('error', (err) => {
                try { fs.unlinkSync(destPath); } catch (e) {}
                reject(err);
            });
        });
        
        req.on('error', (err) => {
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(err);
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Stream download timeout (120s)'));
        });
    });
}

// Fast Cobalt API Engine
async function fetchFromCobaltApi(url, quality, format) {
    const videoId = extractVideoId(url);
    const fullUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;

    const cobaltEndpoints = [
        'https://api.cobalt.tools/',
        'https://cobalt-api.hyper.lol/',
        'https://cobalt.q137.net/api/json',
        'https://cobalt.api.sc7.io/',
        'https://cobalt.imput.net/'
    ];

    const qualityMap = { '360': '360', '480': '480', '720': '720', '1080': '1080', '1440': '1440', '2160': '2160', '4320': '4320' };
    const vQuality = qualityMap[String(quality)] || '720';

    const payload = { url: fullUrl };
    if (format === 'mp3') {
        payload.downloadMode = 'audio';
        payload.audioFormat = 'mp3';
    } else {
        payload.videoQuality = String(vQuality);
    }

    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    };

    const requests = cobaltEndpoints.map(async (baseUrl) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5500);

        try {
            const res = await fetch(baseUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (data.status === 'tunnel' && data.url) {
                return { type: 'tunnel', url: data.url, filename: data.filename || `video.${format}` };
            }
            if ((data.status === 'redirect' || data.status === 'stream') && data.url) {
                return { type: 'redirect', url: data.url, filename: data.filename || `video.${format}` };
            }
            if (data.status === 'picker' && data.picker && data.picker.length > 0) {
                return { type: 'redirect', url: data.picker[0].url, filename: data.filename || `video.${format}` };
            }
            if (data.url) {
                return { type: 'redirect', url: data.url, filename: data.filename || `video.${format}` };
            }
            throw new Error('No URL returned');
        } catch (e) {
            clearTimeout(timeout);
            throw e;
        }
    });

    try {
        return await Promise.any(requests);
    } catch (e) {
        return null;
    }
}

// VKR Downloader API Engine
async function fetchFromVKRApi(url, quality, format) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

        const res = await fetch(`https://api.vkrdown.com/v1/yt?url=${encodeURIComponent(url)}`, {
            headers,
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (res.ok) {
            const data = await res.json();
            if (data && data.data && data.data.downloads && Array.isArray(data.data.downloads)) {
                const downloads = data.data.downloads;
                if (format === 'mp3') {
                    const audio = downloads.find(d => d.format === 'mp3' || (d.quality && d.quality.includes('audio'))) || downloads[0];
                    if (audio && audio.url) return { type: 'redirect', url: audio.url, filename: `${data.data.title || 'audio'}.mp3` };
                } else {
                    const targetHeight = Number(quality) || 720;
                    const video = downloads.find(d => d.quality && d.quality.includes(String(targetHeight))) || downloads[0];
                    if (video && video.url) return { type: 'redirect', url: video.url, filename: `${data.data.title || 'video'}_${quality || 'HD'}p.mp4` };
                }
            }
        }
    } catch (e) {}
    return null;
}

// SSE Endpoint
app.get('/api/progress', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Job ID required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    progressClients.set(id, res);
    logger.info(`SSE client connected. Job ID: ${id}`);

    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    const heartbeat = setInterval(() => {
        res.write(': ping\n\n');
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        progressClients.delete(id);
    });
});

function sendProgress(jobId, data) {
    const client = progressClients.get(jobId);
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// GET /api/info
app.get('/api/info', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const videoId = extractVideoId(url);
    url = normalizeYouTubeUrl(url);

    if (youtubedl) {
        try {
            const baseOptions = {
                dumpSingleJson: true,
                noWarnings: true,
                noCheckCertificates: true,
                preferFreeFormats: true,
                geoBypass: true,
                extractorArgs: 'youtube:player_client=mweb,android_vr',
                addHeader: [
                    'referer:https://www.youtube.com/',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                ]
            };

            const info = await youtubedl(url, baseOptions);
            const specificResolutions = [4320, 2160, 1440, 1080, 720, 480, 360];
            let formats = [];

            if (info && info.formats && Array.isArray(info.formats)) {
                info.formats.forEach(format => {
                    if (format.vcodec !== 'none' && format.height) {
                        if (!formats.includes(format.height)) formats.push(format.height);
                    }
                });
            }

            formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
            formats = [...new Set(formats)];
            if (formats.length === 0) formats = [1080, 720, 480, 360];

            return res.json({
                title: info.title || 'YouTube Video',
                thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                duration: info.duration || 0,
                formats: formats.map(h => ({ height: h, filesize: null }))
            });

        } catch (error) {
            logger.error(`yt-dlp info error: ${error.message}`);
        }
    }

    // Fallback oEmbed info
    try {
        if (videoId) {
            const oRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
            if (oRes.ok) {
                const oData = await oRes.json();
                return res.json({
                    title: oData.title || 'YouTube Video',
                    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    duration: 0,
                    formats: [{ height: 1080 }, { height: 720 }, { height: 480 }, { height: 360 }]
                });
            }
        }
    } catch (e) {}

    res.status(500).json({ error: 'Failed to fetch video info. Please check the URL and try again.' });
});

// GET /api/download
app.get('/api/download', async (req, res) => {
    let { url, quality, jobId, format } = req.query;
    if (!url || !jobId) return res.status(400).json({ error: 'URL and jobId are required' });
    
    format = format === 'mp3' ? 'mp3' : 'mp4';
    url = normalizeYouTubeUrl(url);
    const videoId = extractVideoId(url);
    
    logger.info(`[Job ${jobId}] Download request. Format: ${format}, Quality: ${quality || 'audio'}, URL: ${url}`);

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    res.json({ success: true, message: 'Download initiated successfully' });

    try {
        // TIER 0: Direct Download Engines (Cobalt & VKR API)
        sendProgress(jobId, { type: 'progress', percent: 10, totalSize: 'Connecting to direct download engine...', speed: 'High Speed', eta: null });
        
        let directResult = await fetchFromCobaltApi(url, quality, format);
        if (!directResult) {
            directResult = await fetchFromVKRApi(url, quality, format);
        }

        if (directResult && directResult.url) {
            if (directResult.type === 'tunnel') {
                sendProgress(jobId, { type: 'progress', percent: 20, totalSize: 'Downloading video stream...', speed: 'High Speed', eta: null });
                const sanitizedTitle = (directResult.filename || `video_${quality}`).replace(/[/\\?%*:|"<>]/g, '_');
                const finalFilename = `${tempId}---${sanitizedTitle}`;
                const finalPath = path.join(downloadsDir, finalFilename);

                await downloadStreamToFile(directResult.url, finalPath);

                const downloadName = finalFilename.replace(`${tempId}---`, '');
                activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: finalPath });
                sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
                logger.info(`[Job ${jobId}] ✅ Direct tunnel download SUCCESS`);
                return;
            } else {
                sendProgress(jobId, {
                    type: 'ready',
                    directUrl: directResult.url,
                    filename: directResult.filename || `video_${quality || 'HD'}.${format}`
                });
                logger.info(`[Job ${jobId}] ✅ Direct redirect download SUCCESS`);
                return;
            }
        }

        // TIER 1: yt-dlp Core Engine (Powered by Cloudflare WARP Proxy if active)
        if (youtubedl) {
            sendProgress(jobId, { type: 'progress', percent: 20, totalSize: 'Extracting video via engine...', speed: 'Direct', eta: null });
            
            let outputPathTemplate;
            const flags = {
                noCheckCertificates: true,
                noWarnings: true,
                geoBypass: true,
                concurrentFragments: 16,
                bufferSize: '2M',
                httpChunkSize: '10M',
                retries: 10,
                fragmentRetries: 10,
                newline: true,
                extractorArgs: 'youtube:player_client=mweb,android_vr',
                addHeader: [
                    'referer:https://www.youtube.com/',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ],
                proxy: 'socks5://127.0.0.1:4001'
            };

            if (format === 'mp3') {
                outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s.%(ext)s`);
                flags.extractAudio = true;
                flags.audioFormat = 'mp3';
                flags.audioQuality = 0;
                flags.output = outputPathTemplate;
            } else {
                outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);
                let formatOption = 'bestvideo+bestaudio/best';
                if (quality) {
                    formatOption = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;
                }
                flags.format = formatOption;
                flags.mergeOutputFormat = 'mp4';
                flags.output = outputPathTemplate;
            }

            const ytdlpProcess = youtubedl.exec(url, flags);

            if (ytdlpProcess.stdout) {
                ytdlpProcess.stdout.on('data', (data) => {
                    const text = data.toString();
                    const match = text.match(/\[download\]\s+(\d+\.\d+)%/);
                    if (match) {
                        const percent = parseFloat(match[1]);
                        const sizeMatch = text.match(/of\s+(~?\s*[\d\.]+\s*\w+)/);
                        const speedMatch = text.match(/at\s+([\d\.]+\s*\w+\/s)/);
                        const etaMatch = text.match(/ETA\s+([\d:]+)/);

                        sendProgress(jobId, {
                            type: 'progress',
                            percent: percent,
                            totalSize: sizeMatch ? sizeMatch[1] : 'Calculating...',
                            speed: speedMatch ? speedMatch[1] : 'Fast',
                            eta: etaMatch ? etaMatch[1] : null
                        });
                    }
                    if (text.includes('[Merger]') || text.includes('[ExtractAudio]')) {
                        sendProgress(jobId, { type: 'merging' });
                    }
                });
            }

            await ytdlpProcess;

            const files = fs.readdirSync(downloadsDir);
            const downloadedFile = files.find(f => f.startsWith(`${tempId}---`));

            if (downloadedFile) {
                const localPath = path.join(downloadsDir, downloadedFile);
                const downloadName = downloadedFile.replace(`${tempId}---`, '');

                activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: localPath });
                sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
                logger.info(`[Job ${jobId}] ✅ yt-dlp Download SUCCESS: ${downloadName}`);
                return;
            }
        }

        throw new Error('All download engines failed to extract stream.');

    } catch (err) {
        logger.error(`[Job ${jobId}] ❌ Download failed: ${err.message}`);
        sendProgress(jobId, { type: 'error', message: err.message || 'Failed to download video.' });
    }
});

// GET /api/serve
app.get('/api/serve', async (req, res) => {
    const { tempId, filename } = req.query;
    if (!tempId) return res.status(400).json({ error: 'tempId is required' });

    const jobMeta = activeJobs.get(tempId);
    if (!jobMeta || !jobMeta.localPath || !fs.existsSync(jobMeta.localPath)) {
        return res.status(404).json({ error: 'File expired or not found.' });
    }

    const displayName = filename || jobMeta.filename || 'download';
    res.download(jobMeta.localPath, displayName, (err) => {
        if (err) {
            logger.error(`Error serving file ${tempId}: ${err.message}`);
        }
        setTimeout(() => {
            try {
                if (fs.existsSync(jobMeta.localPath)) fs.unlinkSync(jobMeta.localPath);
                activeJobs.delete(tempId);
            } catch (e) {}
        }, 10000);
    });
});

app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});