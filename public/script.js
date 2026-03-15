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
    const qualitySelect = document.getElementById('qualitySelect');
    const downloadBtn = document.getElementById('downloadBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressText = document.getElementById('progressText');
    const progressFill = document.getElementById('progressFill');
    const progressPercent = document.getElementById('progressPercent');
    const progressInfo = document.getElementById('progressInfo');

    let currentUrl = '';

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
            const data = await res.json();

            if (!res.ok) throw new Error(data.error || 'Failed to fetch video details.');

            videoThumb.src = data.thumbnail;
            videoTitle.textContent = data.title;

            let dur = data.duration;
            if (typeof dur === 'string' && dur.includes(':')) {
                videoDuration.querySelector('span').textContent = dur;
            } else {
                videoDuration.querySelector('span').textContent = formatTime(Number(dur));
            }

            qualitySelect.innerHTML = '<option value="" disabled selected>Select Quality</option>';
            if (data.formats && data.formats.length > 0) {
                data.formats.forEach(f => {
                    const height = f.height;
                    const size = f.filesize ? formatBytes(f.filesize) : null;
                    const opt = document.createElement('option');
                    opt.value = height;
                    let label = `${height}p`;
                    if (height === 2160) label += ' (4K)';
                    else if (height === 1440) label += ' (2K)';
                    else if (height === 1080) label += ' (HD)';
                    if (size) label += ` — ~${size}`;
                    opt.textContent = label;
                    qualitySelect.appendChild(opt);
                });
            } else {
                const opt = document.createElement('option');
                opt.value = "720";
                opt.textContent = "720p (Default)";
                qualitySelect.appendChild(opt);
            }

            loading.classList.add('hidden');
            resultSection.classList.remove('hidden');
            resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

        } catch (error) {
            showError(error.message);
        } finally {
            fetchBtn.disabled = false;
        }
    });

    downloadBtn.addEventListener('click', () => {
        const quality = qualitySelect.value;
        if (!quality) {
            alert('Please select a video quality first.');
            return;
        }

        const jobId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

        progressContainer.classList.remove('hidden');
        downloadBtn.disabled = true;

        progressFill.style.width = '0%';
        progressPercent.textContent = '0%';
        progressText.textContent = 'Connecting to server...';
        progressInfo.textContent = '';

        const eventSource = new EventSource(`/api/progress?id=${jobId}`);

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            if (data.type === 'connected') {
                const downloadUrl = `/api/download?url=${encodeURIComponent(currentUrl)}&quality=${quality}&jobId=${jobId}`;
                
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
                progressFill.style.width = '100%';
                progressPercent.textContent = '100%';
                progressText.textContent = 'Download starting...';
                progressInfo.textContent = data.filename || '';
                eventSource.close();
                
                window.location.href = `/api/serve?tempId=${data.tempId}&filename=${encodeURIComponent(data.filename)}`;
                
                setTimeout(() => {
                    progressContainer.classList.add('hidden');
                    downloadBtn.disabled = false;
                }, 4000);
                
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
