const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Write cookies file from env if available
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
if (process.env.YOUTUBE_COOKIES_BASE64) {
    fs.writeFileSync(COOKIES_PATH, Buffer.from(process.env.YOUTUBE_COOKIES_BASE64, 'base64').toString('utf8'));
}

const app = express();
const PORT = process.env.PORT || 3000;

// Normalize any YouTube URL variant to a standard watch URL
function normalizeYouTubeUrl(url) {
    try {
        // Handle youtu.be short links
        // Handle youtube.com/shorts/
        // Handle m.youtube.com
        // Handle URLs with extra params
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
            // Clean videoId — remove any trailing slashes or query params
            videoId = videoId.split('?')[0].split('&')[0].split('/')[0];
            return `https://www.youtube.com/watch?v=${videoId}`;
        }

        return url; // Return as-is if we cannot normalize
    } catch {
        return url;
    }
}

app.use(cors());
app.use(express.static('public'));

// Store SSE clients: jobId -> res
const progressClients = new Map();

// SSE endpoint - client connects here to receive progress updates
app.get('/api/progress', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Job ID required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    progressClients.set(id, res);

    // Send immediate confirmation that SSE is connected
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    req.on('close', () => {
        progressClients.delete(id);
    });
});

function sendProgress(jobId, data) {
    const client = progressClients.get(jobId);
    if (client) {
        client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

app.get('/api/info', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    url = normalizeYouTubeUrl(url);
    console.log('Info request for:', url);

    try {
        const info = await youtubedl(url, {
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    ...(fs.existsSync(COOKIES_PATH) && { cookies: COOKIES_PATH }) // ADD THIS
});

        const specificResolutions = [2160, 1440, 1080, 720, 480, 360];
        let formats = [];

        // Build a map of resolution -> estimated filesize
        const filesizeMap = {};
        info.formats.forEach(format => {
            if (format.vcodec !== 'none' && format.height) {
                if (!formats.includes(format.height)) {
                    formats.push(format.height);
                }
                // Prefer filesize over filesize_approx
                const size = format.filesize || format.filesize_approx;
                if (size && (!filesizeMap[format.height] || size > filesizeMap[format.height])) {
                    filesizeMap[format.height] = size;
                }
            }
        });

        formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
        formats = [...new Set(formats)];

        // Build format objects with size info
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
        console.error("Info Error:", error.stderr || error.message);
        res.status(500).json({ error: 'Failed to fetch video info: ' + (error.stderr || error.message || 'Unknown error') });
    }
});

app.get('/api/download', async (req, res) => {
    let { url, quality, jobId } = req.query;
    if (!url || !quality) return res.status(400).json({ error: 'URL and quality are required' });
    url = normalizeYouTubeUrl(url);
    console.log('Download request for:', url, 'quality:', quality);

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);

    // Acknowledge the request immediately so the browser doesn't hang
    res.json({ success: true, message: 'Download started' });

    // Process in background
    try {
        let formatString = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;

        const args = [
    url,
    '--format', formatString,
    '--merge-output-format', 'mp4',
    '--output', outputPathTemplate,
    '--ffmpeg-location', ffmpegStatic,
    '--no-check-certificates',
    '--no-warnings',
    '--concurrent-fragments', '4',
    '--retries', '3',
    '--fragment-retries', '3',
    '--newline',
    '--add-header', 'referer:youtube.com',
    '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : []) // ADD THIS
];

        const ytdlpPath = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
        const { spawn } = require('child_process');

        console.log(`Starting background download for ${url} at ${quality}p`);

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
                        if (jobId) sendProgress(jobId, { type: 'progress', ...progressData });
                    }
                }
            });

            child.stderr.on('data', data => {
                console.error(`yt-dlp error: ${data}`);
            });

            child.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`yt-dlp exited with code ${code}`));
            });
            child.on('error', reject);
        });

        console.log(`Download finished for ${url}`);
        if (jobId) sendProgress(jobId, { type: 'merging' });

        const files = fs.readdirSync(downloadsDir);
        const targetFile = files.find(f => f.startsWith(tempId));

        if (!targetFile) {
            throw new Error("File not found after download");
        }

        const downloadName = targetFile.replace(`${tempId}---`, '');

        // Notify client that file is ready for download
        // Provide the tempId so the client can request the exact file
        if (jobId) sendProgress(jobId, { type: 'ready', filename: downloadName, tempId: tempId });

    } catch (error) {
        console.error("Background Download Error:", error);
        if (jobId) sendProgress(jobId, { type: 'error', message: 'Download failed.' });
    }
});

// New endpoint to actually serve the file after it's ready
app.get('/api/serve', (req, res) => {
    const { tempId, filename } = req.query;
    if (!tempId || !filename) return res.status(400).send('Missing file parameters');

    const downloadsDir = path.join(__dirname, 'downloads');
    const files = fs.readdirSync(downloadsDir);
    const targetFile = files.find(f => f.startsWith(tempId));

    if (!targetFile) {
         return res.status(404).send('File not found or expired');
    }

    const finalPath = path.join(downloadsDir, targetFile);

    res.download(finalPath, filename, (err) => {
        if (err) {
            console.error("Serve Error:", err);
        }
        // Clean up the file after serving
        fs.unlink(finalPath, (err) => {
            if (err) console.error("Failed to delete temp file:", err);
            else console.log(`Deleted temp file: ${finalPath}`);
        });
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (accessible via local network)`);
});

44
