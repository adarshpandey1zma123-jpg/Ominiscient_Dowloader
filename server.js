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

         info.formats.forEach(format => {
             if (format.vcodec !== 'none' && format.height) {
                 if (!formats.includes(format.height)) {
                     formats.push(format.height);
                 }
             }
         });

         formats = formats.filter(h => specificResolutions.includes(h) || h > 360).sort((a, b) => b - a);
         formats = [...new Set(formats)];

         res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            formats: formats
         });

    } catch (error) {
        console.error("Info Error:", error);
        res.status(500).json({ error: 'Failed to fetch video info. It may be restricted or invalid.' });
    }
});

app.get('/api/download', async (req, res) => {
    const { url, quality } = req.query;
    if (!url || !quality) return res.status(400).json({ error: 'URL and quality are required' });

    const tempId = crypto.randomBytes(8).toString('hex');
    const downloadsDir = path.join(__dirname, 'downloads');
    
    if (!fs.existsSync(downloadsDir)){
        fs.mkdirSync(downloadsDir);
    }
    
    // Naming it with tempId so we can find it, yt-dlp will replace %(title)s
    const outputPathTemplate = path.join(downloadsDir, `${tempId}---%(title)s_(${quality}p).%(ext)s`);

    try {
         // Best video format up to requested quality, merged with best audio, into mp4
         let formatString = `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`;

         const args = [
             url,
             '--format', formatString,
             '--merge-output-format', 'mp4',
             '--output', outputPathTemplate,
             '--ffmpeg-location', ffmpegStatic,
             '--no-check-certificates',
             '--no-warnings',
             '--prefer-free-formats',
             '--add-header', 'referer:youtube.com',
             '--add-header', 'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
         ];

         const ytdlpPath = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
         const { spawn } = require('child_process');

         console.log(`Starting download for ${url} at ${quality}p using native spawn`);
         
         await new Promise((resolve, reject) => {
             const child = spawn(ytdlpPath, args);
             
             child.stdout.on('data', data => console.log(`yt-dlp: ${data}`));
             child.stderr.on('data', data => console.error(`yt-dlp error: ${data}`));
             
             child.on('close', code => {
                 if (code === 0) resolve();
                 else reject(new Error(`yt-dlp exited with code ${code}`));
             });
             child.on('error', reject);
         });

         console.log(`Download finished for ${url}`);

         const files = fs.readdirSync(downloadsDir);
         const targetFile = files.find(f => f.startsWith(tempId));

         if (!targetFile) {
             throw new Error("File not found after download");
         }

         const finalPath = path.join(downloadsDir, targetFile);
         
         // The filename without the prefix tempId
         const downloadName = targetFile.replace(`${tempId}---`, '');

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
        res.status(500).json({ error: 'Failed to process video download.' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT} (accessible via local network)`);
});
