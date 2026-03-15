const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

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
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });

    try {
        const info = await youtubedl(url, {
            dumpSingleJson: true,
            noCheckCertificates: true,
            noWarnings: true,
            preferFreeFormats: true
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
        console.error("Info Error:", error);
        res.status(500).json({ error: 'Failed to fetch video info. It may be restricted or invalid.' });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, quality, jobId } = req.query;
    if (!url || !quality) return res.status(400).json({ error: 'URL and quality are required' });

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');

    if (!fs.existsSync(downloadsDir)) {
        fs.mkdirSync(downloadsDir);
    }

    const outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);

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
            '--newline',  // Force one-line-per-progress output for easy parsing
            '--add-header', 'referer:youtube.com',
            '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];

        const ytdlpPath = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
        const { spawn } = require('child_process');

        console.log(`Starting download for ${url} at ${quality}p`);

        // Regex to parse yt-dlp progress line:
        // [download]  45.2% of 123.45MiB at  2.34MiB/s ETA 00:30
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
                        console.log(`Progress: ${progressData.percent}% of ${progressData.totalSize} at ${progressData.speed}`);
                        if (jobId) sendProgress(jobId, { type: 'progress', ...progressData });
                    }
                }
            });

            child.stderr.on('data', data => {
                console.error(`yt-dlp: ${data}`);
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

        const finalPath = path.join(downloadsDir, targetFile);
        const downloadName = targetFile.replace(`${tempId}---`, '');

        // Notify client that file is ready for download
        if (jobId) sendProgress(jobId, { type: 'ready', filename: downloadName });

        res.download(finalPath, downloadName, (err) => {
            if (err) {
                console.error("Download Error:", err);
            }
            fs.unlink(finalPath, (err) => {
                if (err) console.error("Failed to delete temp file:", err);
                else console.log(`Deleted temp file: ${finalPath}`);
            });
        });

    } catch (error) {
        console.error("Download Error Details:", error);
        if (jobId) sendProgress(jobId, { type: 'error', message: 'Download failed.' });
        res.status(500).json({ error: 'Failed to process video download.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (accessible via local network)`);
});

44