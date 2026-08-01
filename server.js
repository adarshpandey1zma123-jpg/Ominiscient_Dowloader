try {
    require('dotenv').config();
} catch (e) {
    console.warn('[Server] dotenv module not found. Proceeding with raw process.env.');
}

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
    console.warn('[Server] youtube-dl-exec load notice:', e.message);
}

// Ensure binary executables (ffmpeg, yt-dlp) have executable permissions on Linux / Docker
try {
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
        fs.chmodSync(ffmpegStatic, 0o755);
    }
    const ytdlpPath = (youtubedl && youtubedl.constants) ? youtubedl.constants.YOUTUBE_DL_PATH : null;
    if (ytdlpPath && fs.existsSync(ytdlpPath)) {
        fs.chmodSync(ytdlpPath, 0o755);
    }
} catch (chmodErr) {
    console.warn('[Server] Note on binary chmod permissions:', chmodErr.message);
}

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
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
        max: parseInt(process.env.RATE_LIMIT_MAX) || 150,
        message: { error: 'Too many requests from this IP. Please try again after 15 minutes.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    const downloadLimiter = rateLimit({
        windowMs: parseInt(process.env.DOWNLOAD_LIMIT_WINDOW_MS) || 60 * 60 * 1000,
        max: parseInt(process.env.DOWNLOAD_LIMIT_MAX) || 20,
        message: { error: 'Download limit reached for this hour. Please try again later.' },
        standardHeaders: true,
        legacyHeaders: false
    });

    app.use('/api/', apiLimiter);
    app.use('/api/info', downloadLimiter);
    app.use('/api/download', downloadLimiter);
}

// Function to extract client real IP
function getClientIp(req) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (cfIp) return cfIp;
    const xff = req.headers['x-forwarded-for'];
    if (xff) return xff.split(',')[0].trim();
    return req.socket ? req.socket.remoteAddress : req.ip;
}

// Store SSE clients: jobId -> res
const progressClients = new Map();

// Map to track active jobs meta: tempId -> { s3Key, filename, localPath }
const activeJobs = new Map();

// Function to get a random proxy from list or single proxy URL
function getRandomProxy() {
    if (process.env.PROXY_LIST) {
        const proxies = process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean);
        if (proxies.length > 0) {
            const randomIndex = Math.floor(Math.random() * proxies.length);
            return proxies[randomIndex];
        }
    }
    return process.env.PROXY_URL || null;
}

// Helper to mask credentials in proxy logs
function getSanitizedProxy(proxyUrl) {
    if (!proxyUrl) return '';
    try {
        const parsedProxy = new URL(proxyUrl);
        if (parsedProxy.password) {
            parsedProxy.password = '******';
        }
        return parsedProxy.toString();
    } catch (e) {
        return proxyUrl.replace(/:[^:@]+@/, ':******@');
    }
}

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

// Extract clean YouTube video ID
function extractVideoId(url) {
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
            return videoId.split('?')[0].split('&')[0].split('/')[0];
        }
        return null;
    } catch {
        return null;
    }
}

// Reliable stream downloader using Node.js built-in https module
function downloadStreamToFile(url, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const protocol = url.startsWith('https') ? require('https') : require('http');
        
        logger.info(`Downloading stream: ${url.substring(0, 100)}...`);
        
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
                reject(new Error(`HTTP ${response.statusCode} downloading stream`));
                return;
            }
            
            const file = fs.createWriteStream(destPath);
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    const stat = fs.statSync(destPath);
                    logger.info(`Stream downloaded: ${destPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
                    if (stat.size < 1000) {
                        reject(new Error(`Downloaded file too small: ${stat.size} bytes`));
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

// Ultra-Fast Parallel Cobalt API Engine
async function fetchFromCobaltApi(url, quality, format) {
    const videoId = extractVideoId(url);
    const fullUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;

    const cobaltEndpoints = [
        'https://api.cobalt.tools',
        'https://cobalt-api.kavin.rocks/api/json',
        'https://co.wuk.sh/api/json',
        'https://cobalt.api.timelessnesses.me',
        'https://cobalt.q137.net/api/json'
    ];

    const qualityMap = { '360': '360', '480': '480', '720': '720', '1080': '1080', '1440': '1440', '2160': '2160', '4320': '4320' };
    const vQuality = qualityMap[String(quality)] || '720';

    const payload = {
        url: fullUrl,
        videoQuality: vQuality,
        downloadMode: format === 'mp3' ? 'audio' : 'auto'
    };

    const requests = cobaltEndpoints.map(async (baseUrl) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);

        try {
            const res = await fetch(baseUrl, {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
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
        logger.warn(`All Cobalt parallel instances failed`);
        return null;
    }
}

// Direct YouTube Innertube Client (Fast 3s timeout per client)
async function fetchFromYouTubeInnertube(videoId) {
    const clients = [
        { clientName: 'ANDROID_TESTSUITE', clientVersion: '1.9', userAgent: 'com.google.android.youtube/19.09.37 (Linux; U; Android 11)' },
        { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', userAgent: 'Mozilla/5.0 (SmartHub; SMART-TV; U; Linux/SmartTV) AppleWebKit/537.42 TV Safari/537.42' }
    ];

    for (const c of clients) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);

            const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': c.userAgent
                },
                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: c.clientName,
                            clientVersion: c.clientVersion
                        }
                    },
                    videoId: videoId
                }),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!res.ok) continue;
            const data = await res.json();

            if (data && data.streamingData) {
                const title = (data.videoDetails && data.videoDetails.title) ? data.videoDetails.title : 'YouTube Video';
                const duration = (data.videoDetails && data.videoDetails.lengthSeconds) ? parseInt(data.videoDetails.lengthSeconds, 10) : 0;
                const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

                let videoStreams = [];
                let audioStreams = [];

                if (data.streamingData.formats && Array.isArray(data.streamingData.formats)) {
                    data.streamingData.formats.forEach(f => {
                        // Only use direct URLs, discard signatureCipher since un-deciphered URLs return HTTP 403
                        if (f.url && f.height) {
                            videoStreams.push({ height: f.height, url: f.url, isMuxed: true });
                        }
                    });
                }

                if (data.streamingData.adaptiveFormats && Array.isArray(data.streamingData.adaptiveFormats)) {
                    data.streamingData.adaptiveFormats.forEach(f => {
                        // Only use direct URLs, discard signatureCipher since un-deciphered URLs return HTTP 403
                        if (f.url) {
                            if (f.mimeType && f.mimeType.includes('video') && f.height) {
                                videoStreams.push({ height: f.height, url: f.url, isMuxed: false });
                            }
                            if (f.mimeType && f.mimeType.includes('audio')) {
                                audioStreams.push({ bitrate: f.bitrate || 128000, url: f.url });
                            }
                        }
                    });
                }

                let formats = videoStreams.map(s => s.height).filter(Boolean);
                formats = [...new Set(formats)].sort((a, b) => b - a);
                if (formats.length === 0) formats = [1080, 720, 480, 360];

                if (videoStreams.length > 0 || audioStreams.length > 0) {
                    logger.info(`Innertube ${c.clientName} success: ${title} (${videoStreams.length} video, ${audioStreams.length} audio)`);
                    return {
                        title,
                        thumbnail,
                        duration,
                        formats: formats.map(h => ({ height: h, filesize: null })),
                        rawStreams: { videoStreams, audioStreams }
                    };
                }
            }
        } catch (e) {
            logger.warn(`Innertube client ${c.clientName} failed: ${e.message}`);
        }
    }
    return null;
}

// 4-Tier Permanent API Fallback Engine (Innertube + Piped + Invidious + YouTube oEmbed)
async function fetchVideoInfoFallback(videoId) {
    let result = null;

    // Tier 0: YouTube Direct Innertube API
    try {
        result = await fetchFromYouTubeInnertube(videoId);
    } catch (itErr) {
        logger.warn(`Innertube engine fallback error: ${itErr.message}`);
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    };

    // Tier 1: Parallel Active Piped API Instances
    if (!result) {
        const pipedInstances = [
            `https://pipedapi.kavin.rocks/streams/${videoId}`,
            `https://pipedapi.tokhmi.xyz/streams/${videoId}`,
            `https://pipedapi.moomoo.me/streams/${videoId}`,
            `https://pipedapi.sync.yt/streams/${videoId}`,
            `https://piped-api.lunar.icu/streams/${videoId}`,
            `https://pipedapi.adminforge.de/streams/${videoId}`,
            `https://pipedapi.mha.fi/streams/${videoId}`
        ];

        const pipedRequests = pipedInstances.map(async (endpoint) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const res = await fetch(endpoint, { headers, signal: controller.signal });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data && data.title) {
                    const specificResolutions = [4320, 2160, 1440, 1080, 720, 480, 360];
                    let formats = [];
                    const filesizeMap = {};

                    if (data.videoStreams && Array.isArray(data.videoStreams)) {
                        data.videoStreams.forEach(stream => {
                            if (stream.height) {
                                if (!formats.includes(stream.height)) formats.push(stream.height);
                                if (stream.contentLength && (!filesizeMap[stream.height] || stream.contentLength > filesizeMap[stream.height])) {
                                    filesizeMap[stream.height] = stream.contentLength;
                                }
                            }
                        });
                    }

                    formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
                    formats = [...new Set(formats)];
                    if (formats.length === 0) formats = [1080, 720, 480, 360];

                    return {
                        title: data.title,
                        thumbnail: data.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                        duration: data.duration || 0,
                        formats: formats.map(h => ({ height: h, filesize: filesizeMap[h] || null })),
                        rawStreams: data
                    };
                }
                throw new Error('Invalid Piped data');
            } catch (e) {
                clearTimeout(timeout);
                throw e;
            }
        });

        try {
            result = await Promise.any(pipedRequests);
        } catch (e) {
            // Piped failed
        }
    }

    // Tier 2: Parallel Active Invidious API Instances
    if (!result) {
        const invidiousInstances = [
            `https://yewtu.be/api/v1/videos/${videoId}`,
            `https://invidious.nerdvpn.de/api/v1/videos/${videoId}`,
            `https://invidious.flokinet.to/api/v1/videos/${videoId}`,
            `https://invidious.drgns.space/api/v1/videos/${videoId}`,
            `https://iv.melmac.space/api/v1/videos/${videoId}`
        ];

        const invidiousRequests = invidiousInstances.map(async (endpoint) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const res = await fetch(endpoint, { headers, signal: controller.signal });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data && data.title) {
                    let videoStreams = [];
                    let audioStreams = [];

                    if (data.formatStreams && Array.isArray(data.formatStreams)) {
                        data.formatStreams.forEach(fs => {
                            const h = parseInt(fs.qualityLabel || fs.height, 10);
                            if (h && fs.url) {
                                videoStreams.push({ height: h, url: fs.url, qualityLabel: fs.qualityLabel });
                            }
                        });
                    }

                    if (data.adaptiveFormats && Array.isArray(data.adaptiveFormats)) {
                        data.adaptiveFormats.forEach(af => {
                            if (af.type && af.type.includes('video') && af.height && af.url) {
                                videoStreams.push({ height: af.height, url: af.url, qualityLabel: `${af.height}p` });
                            }
                            if (af.type && af.type.includes('audio') && af.url) {
                                audioStreams.push({ bitrate: af.bitrate || 128000, url: af.url });
                            }
                        });
                    }

                    let formats = videoStreams.map(s => s.height).filter(Boolean);
                    formats = [...new Set(formats)].sort((a, b) => b - a);
                    if (formats.length === 0) formats = [1080, 720, 480, 360];

                    return {
                        title: data.title,
                        thumbnail: (data.videoThumbnails && data.videoThumbnails[0]) ? data.videoThumbnails[0].url : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                        duration: data.lengthSeconds || 0,
                        formats: formats.map(h => ({ height: h, filesize: null })),
                        rawStreams: { videoStreams, audioStreams }
                    };
                }
                throw new Error('Invalid Invidious data');
            } catch (e) {
                clearTimeout(timeout);
                throw e;
            }
        });

        try {
            result = await Promise.any(invidiousRequests);
        } catch (e) {
            // Invidious failed
        }
    }

    // Tier 3: Official YouTube oEmbed API
    if (!result) {
        try {
            const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
            const res = await fetch(oembedUrl, { headers });
            if (res.ok) {
                const data = await res.json();
                if (data && data.title) {
                    result = {
                        title: data.title,
                        thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                        duration: 0,
                        formats: [1080, 720, 480, 360].map(h => ({ height: h, filesize: null })),
                        rawStreams: null
                    };
                }
            }
        } catch (oeErr) {
            logger.error(`YouTube oEmbed fallback failed: ${oeErr.message}`);
        }
    }

    // Direct YouTube HTML Duration Resolution (Guarantees non-zero video duration)
    if (result && (!result.duration || result.duration === 0)) {
        result.duration = await getYouTubeVideoDuration(videoId);
    }

    return result;
}

// Fallback duration fetcher directly from YouTube watch HTML
async function getYouTubeVideoDuration(videoId) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);
        const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            signal: controller.signal
        });
        clearTimeout(timeout);
        if (res.ok) {
            const html = await res.text();
            const match = html.match(/"lengthSeconds":"(\d+)"/);
            if (match && match[1]) {
                return parseInt(match[1], 10);
            }
            const isoMatch = html.match(/itemprop="duration"\s+content="PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?"/i);
            if (isoMatch) {
                const hours = parseInt(isoMatch[1] || '0', 10);
                const minutes = parseInt(isoMatch[2] || '0', 10);
                const seconds = parseInt(isoMatch[3] || '0', 10);
                return hours * 3600 + minutes * 60 + seconds;
            }
        }
    } catch (e) {
        // Ignore fallback errors
    }
    return 0;
}

// SSE endpoint - client connects here to receive progress updates
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
        logger.info(`SSE client disconnected. Job ID: ${id}`);
    });
});

function sendProgress(jobId, data) {
    const client = progressClients.get(jobId);
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// BLAZING FAST Video Info Resolution (under 200ms)
app.get('/api/info', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const videoId = extractVideoId(url);
    url = normalizeYouTubeUrl(url);
    const clientIp = getClientIp(req);
    logger.info(`Info request received for URL: ${url} from IP: ${clientIp}`);

    // Fast Track: Try ultra-fast fallback engine first for instant 0.2s load speed
    if (videoId) {
        try {
            const fastData = await fetchVideoInfoFallback(videoId);
            if (fastData && fastData.title && fastData.formats && fastData.formats.length > 0) {
                logger.info(`Ultra-Fast Info Resolution successful for: ${fastData.title}`);
                return res.json({
                    title: fastData.title,
                    thumbnail: fastData.thumbnail,
                    duration: fastData.duration,
                    formats: fastData.formats
                });
            }
        } catch (fastErr) {
            logger.warn(`Fast track info resolution error: ${fastErr.message}`);
        }
    }

    if (youtubedl) {
        try {
            const proxyUrl = getRandomProxy();
            const baseOptions = {
                dumpSingleJson: true,
                noCheckCertificates: true,
                noWarnings: true,
                preferFreeFormats: true,
                noPlaylist: true,
                noCheckFormats: true,
                skipDownload: true,
                geoBypass: true,
                extractorArgs: 'youtube:player_client=tvhtml5,android_testsuite,web_creator,mweb,ios',
                addHeader: [
                    'referer:https://www.youtube.com/',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                ]
            };

            if (proxyUrl) {
                baseOptions.proxy = proxyUrl;
            }

            const info = await youtubedl(url, baseOptions);
            const specificResolutions = [4320, 2160, 1440, 1080, 720, 480, 360];
            let formats = [];

            if (info && info.formats && Array.isArray(info.formats)) {
                info.formats.forEach(format => {
                    if (format.vcodec !== 'none' && format.height) {
                        if (!formats.includes(format.height)) {
                            formats.push(format.height);
                        }
                    }
                });
            }

            formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
            formats = [...new Set(formats)];

            return res.json({
                title: info.title || 'YouTube Video',
                thumbnail: info.thumbnail || '',
                duration: info.duration || 0,
                formats: formats.map(h => ({ height: h, filesize: null }))
            });

        } catch (error) {
            logger.error(`yt-dlp info error: ${error.message}`);
        }
    }

    res.status(500).json({ error: 'Failed to fetch video info. Please check the URL and try again.' });
});

// Download Video (MP4) or Audio (MP3)
app.get('/api/download', async (req, res) => {
    let { url, quality, jobId, format } = req.query;
    if (!url || !jobId) return res.status(400).json({ error: 'URL and jobId are required' });
    
    format = format === 'mp3' ? 'mp3' : 'mp4';
    url = normalizeYouTubeUrl(url);
    const clientIp = getClientIp(req);
    const videoId = extractVideoId(url);
    
    logger.info(`[Job ${jobId}] Download request. Format: ${format}, Quality: ${quality || 'audio'}, URL: ${url}`);

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir, { recursive: true });
    }

    let outputPathTemplate;
    if (format === 'mp3') {
        outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s.%(ext)s`);
    } else {
        outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);
    }

    res.json({ success: true, message: 'Download initiated successfully' });

    try {
        // === TIER 0: Cobalt Direct Download (Instant High-Speed) ===
        sendProgress(jobId, { type: 'progress', percent: 5, totalSize: 'Connecting...', speed: 'High Speed Direct', eta: null });
        try {
            const cobaltResult = await fetchFromCobaltApi(url, quality, format);
            if (cobaltResult && cobaltResult.url) {
                logger.info(`[Job ${jobId}] Cobalt ${cobaltResult.type}: ${cobaltResult.url.substring(0, 80)}...`);

                if (cobaltResult.type === 'tunnel') {
                    // Tunnel: download through our server to client
                    sendProgress(jobId, { type: 'progress', percent: 10, totalSize: 'Downloading via tunnel...', speed: 'High Speed', eta: null });
                    const sanitizedTitle = (cobaltResult.filename || `video_${quality}`).replace(/[/\\?%*:|"<>]/g, '_');
                    const finalFilename = `${tempId}---${sanitizedTitle}`;
                    const finalPath = path.join(downloadsDir, finalFilename);

                    await downloadStreamToFile(cobaltResult.url, finalPath);

                    const downloadName = finalFilename.replace(`${tempId}---`, '');
                    activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: finalPath });
                    sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
                    logger.info(`[Job ${jobId}] ✅ Cobalt tunnel download SUCCESS`);
                    return;
                } else {
                    // Redirect: send direct URL to client browser
                    sendProgress(jobId, {
                        type: 'ready',
                        directUrl: cobaltResult.url,
                        filename: cobaltResult.filename || `video_${quality || 'HD'}.${format}`
                    });
                    logger.info(`[Job ${jobId}] ✅ Cobalt redirect download SUCCESS`);
                    return;
                }
            }
        } catch (cobaltErr) {
            logger.warn(`[Job ${jobId}] Cobalt TIER 0 failed: ${cobaltErr.message}`);
        }

        // === TIER 1: YouTube Innertube / Stream Download ===
        if (videoId) {
            logger.info(`[Job ${jobId}] TIER 1: Trying Innertube/Stream download...`);
            sendProgress(jobId, { type: 'progress', percent: 10, totalSize: 'Connecting to stream...', speed: 'Stream Engine', eta: null });

            try {
                const fallbackData = await fetchVideoInfoFallback(videoId);
                
                if (fallbackData && fallbackData.rawStreams) {
                    const rawStreams = fallbackData.rawStreams;
                    const sanitizedTitle = (fallbackData.title || 'video').replace(/[/\\?%*:|"<>]/g, '_');

                    if (format === 'mp3') {
                        const audioStreams = rawStreams.audioStreams || [];
                        if (audioStreams.length > 0) {
                            const bestAudio = audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
                            
                            if (bestAudio.url) {
                                sendProgress(jobId, { type: 'progress', percent: 25, totalSize: 'Downloading audio...', speed: 'Stream Engine', eta: null });
                                
                                const tempAudioPath = path.join(downloadsDir, `${tempId}_audio_temp`);
                                await downloadStreamToFile(bestAudio.url, tempAudioPath);
                                
                                sendProgress(jobId, { type: 'progress', percent: 80, totalSize: 'Converting to MP3...', speed: 'FFmpeg', eta: null });
                                
                                const finalFilename = `${tempId}---${sanitizedTitle}.mp3`;
                                const finalPath = path.join(downloadsDir, finalFilename);
                                
                                const { spawn } = require('child_process');
                                await new Promise((res, rej) => {
                                    const proc = spawn(ffmpegStatic, ['-y', '-i', tempAudioPath, '-vn', '-b:a', '320k', finalPath]);
                                    proc.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg exit ${code}`)));
                                    proc.on('error', rej);
                                });
                                
                                try { fs.unlinkSync(tempAudioPath); } catch (e) {}
                                
                                const downloadName = finalFilename.replace(`${tempId}---`, '');
                                activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: finalPath });
                                sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
                                logger.info(`[Job ${jobId}] ✅ MP3 download SUCCESS`);
                                return;
                            }
                        }
                    } else {
                        const videoStreams = rawStreams.videoStreams || [];
                        const audioStreams = rawStreams.audioStreams || [];

                        const targetQuality = Number(quality) || 720;
                        let bestVideo = videoStreams.find(s => s.height === targetQuality)
                            || videoStreams.find(s => s.height <= targetQuality && s.height >= 360)
                            || (videoStreams.length > 0 ? videoStreams[0] : null);

                        if (bestVideo && bestVideo.url) {
                            sendProgress(jobId, { type: 'progress', percent: 15, totalSize: 'Downloading video...', speed: 'Stream Engine', eta: null });
                            
                            const tempVideoPath = path.join(downloadsDir, `${tempId}_video_temp`);
                            await downloadStreamToFile(bestVideo.url, tempVideoPath);
                            
                            let finalFilename, finalPath;
                            const bestAudio = audioStreams.length > 0 ? audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] : null;

                            if (bestAudio && bestAudio.url) {
                                sendProgress(jobId, { type: 'progress', percent: 55, totalSize: 'Downloading audio...', speed: 'Stream Engine', eta: null });
                                
                                const tempAudioPath = path.join(downloadsDir, `${tempId}_audio_temp`);
                                await downloadStreamToFile(bestAudio.url, tempAudioPath);
                                
                                sendProgress(jobId, { type: 'progress', percent: 85, totalSize: 'Merging video + audio...', speed: 'FFmpeg', eta: null });
                                
                                finalFilename = `${tempId}---${sanitizedTitle}_(${bestVideo.height}p).mp4`;
                                finalPath = path.join(downloadsDir, finalFilename);
                                
                                const { spawn } = require('child_process');
                                await new Promise((res, rej) => {
                                    const proc = spawn(ffmpegStatic, [
                                        '-y', '-i', tempVideoPath, '-i', tempAudioPath,
                                        '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', finalPath
                                    ]);
                                    proc.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg exit ${code}`)));
                                    proc.on('error', rej);
                                });
                                
                                try { fs.unlinkSync(tempVideoPath); } catch (e) {}
                                try { fs.unlinkSync(tempAudioPath); } catch (e) {}
                            } else {
                                finalFilename = `${tempId}---${sanitizedTitle}_(${bestVideo.height}p).mp4`;
                                finalPath = path.join(downloadsDir, finalFilename);
                                fs.renameSync(tempVideoPath, finalPath);
                            }

                            const downloadName = finalFilename.replace(`${tempId}---`, '');
                            activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: finalPath });
                            sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
                            logger.info(`[Job ${jobId}] ✅ Video download SUCCESS`);
                            return;
                        }
                    }
                }
            } catch (tier1Err) {
                logger.error(`[Job ${jobId}] TIER 1 FAILED: ${tier1Err.message}`);
                try { fs.unlinkSync(path.join(downloadsDir, `${tempId}_video_temp`)); } catch (e) {}
                try { fs.unlinkSync(path.join(downloadsDir, `${tempId}_audio_temp`)); } catch (e) {}
            }
        }

        // === TIER 2: yt-dlp ===
        if (youtubedl) {
            sendProgress(jobId, { type: 'progress', percent: 15, totalSize: 'Trying yt-dlp...', speed: 'Direct', eta: null });
            
            const proxyUrl = getRandomProxy();
            const cookiesPath = path.join(__dirname, 'cookies.txt');

            const commonArgs = [
                '--no-check-certificates', '--no-warnings', '--geo-bypass',
                '--concurrent-fragments', '16', '--buffer-size', '2M', '--http-chunk-size', '10M',
                '--retries', '10', '--fragment-retries', '10', '--newline',
                '--extractor-args', 'youtube:player_client=tvhtml5,android_testsuite,web_creator,mweb,ios',
                '--add-header', 'referer:https://www.youtube.com/',
                '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            ];

            if (fs.existsSync(cookiesPath)) commonArgs.push('--cookies', cookiesPath);
            if (clientIp) commonArgs.push('--add-header', `X-Forwarded-For:${clientIp}`);
            if (proxyUrl) commonArgs.push('--proxy', proxyUrl);

            let args = [url];
            if (format === 'mp3') {
                args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
                    '--output', outputPathTemplate, '--ffmpeg-location', ffmpegStatic, ...commonArgs);
            } else {
                args.push('--format', `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`,
                    '--merge-output-format', 'mp4',
                    '--output', outputPathTemplate, '--ffmpeg-location', ffmpegStatic, ...commonArgs);
            }

            const ytdlpPath = (youtubedl && youtubedl.constants) ? youtubedl.constants.YOUTUBE_DL_PATH : 'yt-dlp';
            const { spawn } = require('child_process');
            const progressRegex = /\[download\]\s+([\d.]+)%\s+of\s+([\d.]+\s*\w+)\s+at\s+([\d.]+\s*\w+\/s)(?:\s+ETA\s+([\d:]+))?/;

            await new Promise((resolve, reject) => {
                const child = spawn(ytdlpPath, args);
                let buffer = '';
                child.stdout.on('data', data => {
                    buffer += data.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const match = line.match(progressRegex);
                        if (match) {
                            sendProgress(jobId, {
                                type: 'progress', percent: parseFloat(match[1]),
                                totalSize: match[2].trim(), speed: match[3].trim(),
                                eta: match[4] ? match[4].trim() : null
                            });
                        }
                    }
                });
                child.stderr.on('data', data => logger.error(`yt-dlp stderr: ${data}`));
                child.on('close', code => code === 0 ? resolve() : reject(new Error(`yt-dlp exit code ${code}`)));
                child.on('error', reject);
            });

            sendProgress(jobId, { type: 'merging' });

            const files = fs.readdirSync(downloadsDir);
            const targetFile = files.find(f => f.startsWith(tempId));
            if (!targetFile) throw new Error("File not found after yt-dlp download");

            const downloadName = targetFile.replace(`${tempId}---`, '');
            const finalLocalPath = path.join(downloadsDir, targetFile);

            if (storage.isCloudEnabled()) {
                const s3Key = `downloads/${tempId}/${downloadName}`;
                await storage.uploadFile(finalLocalPath, s3Key);
                fs.unlinkSync(finalLocalPath);
                activeJobs.set(tempId, { s3Key, filename: downloadName, localPath: null });
            } else {
                activeJobs.set(tempId, { s3Key: null, filename: downloadName, localPath: finalLocalPath });
            }

            sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });
            return;
        }

    } catch (error) {
        logger.error(`[Job ${jobId}] ❌ ALL TIERS FAILED: ${error.message}`);
    }

    sendProgress(jobId, { type: 'error', message: 'Failed to download video. Please try again.' });
});

// Serve the file directly to the client
app.get('/api/serve', async (req, res) => {
    const { tempId, filename } = req.query;
    if (!tempId) return res.status(400).send('tempId is required');

    const job = activeJobs.get(tempId);
    
    if (!job) {
        const downloadsDir = path.join(__dirname, 'downloads');
        if (fs.existsSync(downloadsDir)) {
            const files = fs.readdirSync(downloadsDir);
            const foundFile = files.find(f => f.startsWith(tempId));
            if (foundFile) {
                const fullPath = path.join(downloadsDir, foundFile);
                const stat = fs.statSync(fullPath);
                const range = req.headers.range;

                if (range) {
                    const parts = range.replace(/bytes=/, "").split("-");
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                    const chunksize = (end - start) + 1;
                    const file = fs.createReadStream(fullPath, { start, end });
                    const head = {
                        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunksize,
                        'Content-Type': foundFile.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
                    };
                    res.writeHead(206, head);
                    file.pipe(res);
                } else {
                    const head = {
                        'Content-Length': stat.size,
                        'Content-Type': foundFile.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
                        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename || foundFile.replace(`${tempId}---`, ''))}"`
                    };
                    res.writeHead(200, head);
                    fs.createReadStream(fullPath).pipe(res);
                }
                return;
            }
        }
        return res.status(404).send('File not found or expired.');
    }

    if (job.localPath && fs.existsSync(job.localPath)) {
        const fullPath = job.localPath;
        const stat = fs.statSync(fullPath);
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(fullPath, { start, end });
            const head = {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4',
            };
            res.writeHead(206, head);
            file.pipe(res);
        } else {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
            res.setHeader('Content-Type', job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
            res.setHeader('Content-Length', stat.size);
            const stream = fs.createReadStream(fullPath);
            stream.pipe(res);
            stream.on('end', () => {
                fs.unlink(fullPath, (err) => {
                    if (err) logger.error(`Failed to delete local temp file: ${err.message}`);
                });
                activeJobs.delete(tempId);
            });
        }
        return;
    }

    if (storage.isCloudEnabled() && job.s3Key) {
        try {
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename)}"`);
            res.setHeader('Content-Type', job.filename.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
            res.setHeader('X-Accel-Buffering', 'no');
            const cloudStream = await storage.downloadStream(job.s3Key);
            cloudStream.pipe(res);
            cloudStream.on('end', async () => {
                if (process.env.DELETE_FROM_CLOUD_AFTER_DOWNLOAD !== 'false') {
                    try { await storage.deleteFile(job.s3Key); } catch (delErr) {}
                }
                activeJobs.delete(tempId);
            });
        } catch (error) {
            res.status(500).send('Error serving file from cloud storage');
        }
    }
});

// Global Error Handler
app.use((err, req, res, next) => {
    logger.error(`Unhandled Exception: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
});

process.on('SIGTERM', async () => {
    logger.info('SIGTERM signal received. Synchronizing logs and shutting down...');
    await logger.syncLogs();
    process.exit(0);
});