document.addEventListener('DOMContentLoaded', () => {
    const fetchForm = document.getElementById('fetchForm');
    const urlInput = document.getElementById('urlInput');
    const fetchBtn = document.getElementById('fetchBtn');
    const loading = document.getElementById('loading');
    const errorMessage = document.getElementById('errorMessage');

    const resultSection = document.getElementById('resultSection');
    const videoThumb = document.getElementById('videoThumb');
    const videoTitle = document.getElementById('videoTitle');
    const videoDuration = document.getElementById('videoDuration');
    const formatSelect = document.getElementById('formatSelect');
    const qualityWrapper = document.getElementById('qualityWrapper');
    const qualitySelect = document.getElementById('qualitySelect');
    const downloadBtn = document.getElementById('downloadBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');
    const progressInfo = document.getElementById('progressInfo');

    let currentUrl = '';

    formatSelect.addEventListener('change', () => {
        if (formatSelect.value === 'mp3') {
            qualityWrapper.classList.add('hidden');
        } else {
            qualityWrapper.classList.remove('hidden');
        }
    });

    function formatTime(seconds) {
        if (!seconds) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function formatBytes(bytes) {
        if (!bytes) return null;
        if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return bytes + ' B';
    }

    function showError(msg) {
        errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
        loading.classList.add('hidden');
        resultSection.classList.add('hidden');
    }

    function hideError() {
        errorMessage.classList.add('hidden');
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

    // 1. Client-Side Cobalt API Engine (v10 Protocol)
    async function fetchCobaltClientSide(url, quality, format) {
        const videoId = extractVideoId(url);
        const canonicalUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;

        const cobaltEndpoints = [
            'https://api.cobalt.tools',
            'https://cobalt.api.sc7.io',
            'https://cobalt.imput.net'
        ];

        const payload = { url: canonicalUrl };
        if (format === 'mp3') {
            payload.downloadMode = 'audio';
            payload.audioFormat = 'mp3';
        } else {
            payload.videoQuality = String(quality || '720');
        }

        const requests = cobaltEndpoints.map(async (endpoint) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 6000);
            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data.url) {
                    return { url: data.url, filename: data.filename || `video.${format}` };
                }
                if (data.picker && data.picker.length > 0) {
                    return { url: data.picker[0].url, filename: data.filename || `video.${format}` };
                }
                throw new Error('No URL in Cobalt response');
            } catch (err) {
                clearTimeout(timeout);
                throw err;
            }
        });

        try {
            return await Promise.any(requests);
        } catch (e) {
            console.warn('[Client Cobalt] Failed:', e);
            return null;
        }
    }

    // 2. Client-Side Piped Stream Engine (Uses User Residential IP!)
    async function fetchPipedClientSide(videoId, quality, format) {
        const pipedEndpoints = [
            `https://pipedapi.kavin.rocks/streams/${videoId}`,
            `https://pipedapi.tokhmi.xyz/streams/${videoId}`,
            `https://pipedapi.adminforge.de/streams/${videoId}`
        ];

        const targetHeight = Number(quality) || 720;

        const requests = pipedEndpoints.map(async (ep) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch(ep, { signal: controller.signal });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (format === 'mp3' && data.audioStreams && data.audioStreams.length > 0) {
                    const bestAudio = data.audioStreams.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
                    if (bestAudio && bestAudio.url) {
                        return { url: bestAudio.url, filename: `${data.title || 'audio'}.mp3` };
                    }
                }

                if (data.videoStreams && data.videoStreams.length > 0) {
                    const validVideos = data.videoStreams.filter(v => v.url && v.height);
                    let bestVid = validVideos.find(v => v.height === targetHeight)
                        || validVideos.find(v => v.height <= targetHeight && v.height >= 360)
                        || validVideos[0];
                    if (bestVid && bestVid.url) {
                        return { url: bestVid.url, filename: `${data.title || 'video'}_${bestVid.height}p.mp4` };
                    }
                }
                throw new Error('No Piped stream found');
            } catch (e) {
                clearTimeout(timeout);
                throw e;
            }
        });

        try {
            return await Promise.any(requests);
        } catch (e) {
            console.warn('[Client Piped] Failed:', e);
            return null;
        }
    }

    // 3. Client-Side Invidious Stream Engine (Uses User Residential IP!)
    async function fetchInvidiousClientSide(videoId, quality, format) {
        const invidiousEndpoints = [
            `https://yewtu.be/api/v1/videos/${videoId}`,
            `https://iv.melmac.space/api/v1/videos/${videoId}`
        ];

        const targetHeight = Number(quality) || 720;

        const requests = invidiousEndpoints.map(async (ep) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch(ep, { signal: controller.signal });
                clearTimeout(timeout);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (format === 'mp3' && data.adaptiveFormats) {
                    const audio = data.adaptiveFormats.find(a => a.type && a.type.includes('audio') && a.url);
                    if (audio) return { url: audio.url, filename: `${data.title || 'audio'}.mp3` };
                }

                if (data.formatStreams && data.formatStreams.length > 0) {
                    const valid = data.formatStreams.filter(f => f.url);
                    let best = valid.find(f => parseInt(f.qualityLabel || f.height, 10) === targetHeight) || valid[0];
                    if (best && best.url) return { url: best.url, filename: `${data.title || 'video'}.mp4` };
                }
                throw new Error('No Invidious format stream');
            } catch (e) {
                clearTimeout(timeout);
                throw e;
            }
        });

        try {
            return await Promise.any(requests);
        } catch (e) {
            console.warn('[Client Invidious] Failed:', e);
            return null;
        }
    }

    function triggerDirectBrowserDownload(directUrl, filename) {
        progressFill.style.width = '100%';
        progressPercent.textContent = '100%';
        progressText.textContent = 'Download ready!';
        progressInfo.textContent = filename || 'Starting browser download...';

        const a = document.createElement('a');
        a.href = directUrl;
        a.download = filename || 'download';
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => {
            progressContainer.classList.add('hidden');
            downloadBtn.disabled = false;
        }, 3000);
    }

    fetchForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const url = urlInput.value.trim();
        if (!url) return;

        currentUrl = url;
        hideError();
        resultSection.classList.add('hidden');
        loading.classList.remove('hidden');
        fetchBtn.disabled = true;

        try {
            const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
            let data = null;

            if (res.ok) {
                data = await res.json();
            } else {
                const videoId = extractVideoId(url);
                if (videoId) {
                    const oRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                    if (oRes.ok) {
                        const oData = await oRes.json();
                        data = {
                            title: oData.title,
                            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                            duration: 0,
                            formats: [{ height: 1080 }, { height: 720 }, { height: 480 }, { height: 360 }]
                        };
                    }
                }
            }

            if (!data) throw new Error('Failed to fetch video details.');

            videoThumb.src = data.thumbnail;
            videoTitle.textContent = data.title;

            let dur = data.duration;
            if (typeof dur === 'string' && dur.includes(':')) {
                videoDuration.querySelector('span').textContent = dur;
            } else {
                videoDuration.querySelector('span').textContent = formatTime(Number(dur));
            }

            qualitySelect.innerHTML = '<option value="" disabled selected>Select Quality</option>';
            const standardResolutions = [
                { height: 4320, label: '8K Ultra HD' },
                { height: 2160, label: '4K Ultra HD' },
                { height: 1440, label: '2K Quad HD' },
                { height: 1080, label: 'Full HD' },
                { height: 720, label: 'HD' },
                { height: 480, label: 'SD (480p)' },
                { height: 360, label: 'Low (360p)' }
            ];

            const availableFormats = data.formats || [];
            const maxAvailableHeight = availableFormats.length > 0 ? Math.max(...availableFormats.map(f => f.height)) : 720;

            standardResolutions.forEach(res => {
                const matchedFormat = availableFormats.find(f => f.height === res.height);
                const size = matchedFormat && matchedFormat.filesize ? formatBytes(matchedFormat.filesize) : null;
                
                const opt = document.createElement('option');
                opt.value = res.height;
                
                let optionText = `${res.height}p — ${res.label}`;
                if (size) {
                    optionText += ` (~${size})`;
                } else if (res.height > maxAvailableHeight) {
                    optionText += ` (Best Available / Fallback)`;
                }
                
                opt.textContent = optionText;
                qualitySelect.appendChild(opt);
            });

            loading.classList.add('hidden');
            resultSection.classList.remove('hidden');
            resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        } catch (error) {
            showError(error.message);
        } finally {
            fetchBtn.disabled = false;
        }
    });

    downloadBtn.addEventListener('click', async () => {
        const format = formatSelect.value;
        const quality = qualitySelect.value;
        
        if (format === 'mp4' && !quality) {
            alert('Please select a video quality first.');
            return;
        }

        progressContainer.classList.remove('hidden');
        downloadBtn.disabled = true;

        progressFill.style.width = '30%';
        progressPercent.textContent = '30%';
        progressText.textContent = 'Resolving direct download link...';
        progressInfo.textContent = 'Using Client Residential IP Engine...';

        const videoId = extractVideoId(currentUrl);

        // TIER 0A: Client Cobalt v10
        try {
            const cobaltRes = await fetchCobaltClientSide(currentUrl, quality, format);
            if (cobaltRes && cobaltRes.url) {
                console.log('[Client Direct] Cobalt Success');
                triggerDirectBrowserDownload(cobaltRes.url, cobaltRes.filename);
                return;
            }
        } catch (e) {}

        // TIER 0B: Client Piped Engine
        if (videoId) {
            try {
                const pipedRes = await fetchPipedClientSide(videoId, quality, format);
                if (pipedRes && pipedRes.url) {
                    console.log('[Client Direct] Piped Success');
                    triggerDirectBrowserDownload(pipedRes.url, pipedRes.filename);
                    return;
                }
            } catch (e) {}

            // TIER 0C: Client Invidious Engine
            try {
                const invRes = await fetchInvidiousClientSide(videoId, quality, format);
                if (invRes && invRes.url) {
                    console.log('[Client Direct] Invidious Success');
                    triggerDirectBrowserDownload(invRes.url, invRes.filename);
                    return;
                }
            } catch (e) {}
        }

        // TIER 1 (SERVER BACKUP): Fallback to Server SSE Pipeline if client engines fail
        progressText.textContent = 'Connecting to server pipeline...';
        const jobId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
        const eventSource = new EventSource(`/api/progress?id=${jobId}`);

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'connected') {
                const downloadUrl = `/api/download?url=${encodeURIComponent(currentUrl)}&quality=${quality || ''}&jobId=${jobId}&format=${format}`;
                
                fetch(downloadUrl).then(res => {
                    if (!res.ok) {
                        res.json().then(d => {
                            alert('Download start error: ' + (d.error || 'Unknown error'));
                            eventSource.close();
                            progressContainer.classList.add('hidden');
                            downloadBtn.disabled = false;
                        });
                    }
                }).catch(err => {
                    console.error('Download init error:', err);
                    alert('Could not connect to download server. Check connection.');
                    eventSource.close();
                    progressContainer.classList.add('hidden');
                    downloadBtn.disabled = false;
                });
            } else if (data.type === 'progress') {
                const pct = Math.min(data.percent, 99).toFixed(1);
                progressFill.style.width = `${pct}%`;
                progressPercent.textContent = `${pct}%`;
                progressText.textContent = `Downloading...`;
                progressInfo.textContent = `${data.totalSize}  |  Speed: ${data.speed}${data.eta ? '  |  ETA: ' + data.eta : ''}`;
            } else if (data.type === 'merging') {
                progressFill.style.width = '99%';
                progressPercent.textContent = '99%';
                progressText.textContent = 'Merging video + audio...';
                progressInfo.textContent = 'Please wait, almost done!';
            } else if (data.type === 'ready') {
                eventSource.close();
                if (data.directUrl) {
                    triggerDirectBrowserDownload(data.directUrl, data.filename);
                } else if (data.tempId) {
                    window.location.href = `/api/serve?tempId=${data.tempId}&filename=${encodeURIComponent(data.filename)}`;
                    setTimeout(() => {
                        progressContainer.classList.add('hidden');
                        downloadBtn.disabled = false;
                    }, 4000);
                }
            } else if (data.type === 'error') {
                eventSource.close();
                alert('Download failed: ' + data.message);
                progressContainer.classList.add('hidden');
                downloadBtn.disabled = false;
            }
        };

        eventSource.onerror = () => {
            eventSource.close();
        };
    });
});
