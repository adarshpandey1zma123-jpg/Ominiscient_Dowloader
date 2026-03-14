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
    
    let currentUrl = '';

    function formatTime(seconds) {
        if (!seconds) return '00:00';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
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

            if (!res.ok) {
                throw new Error(data.error || 'Failed to fetch video details.');
            }

            // Populate UI
            videoThumb.src = data.thumbnail;
            videoTitle.textContent = data.title;
            
            // Handle duration structure (sometimes it's a number, sometimes a string)
            let dur = data.duration;
            if (typeof dur === 'string' && dur.includes(':')) {
                videoDuration.querySelector('span').textContent = dur;
            } else {
                videoDuration.querySelector('span').textContent = formatTime(Number(dur));
            }

            // Populate qualities
            qualitySelect.innerHTML = '<option value="" disabled selected>Select Quality</option>';
            if (data.formats && data.formats.length > 0) {
                data.formats.forEach(f => {
                    const opt = document.createElement('option');
                    opt.value = f;
                    let label = `${f}p`;
                    if (f === 2160) label += ' (4K)';
                    else if (f === 1440) label += ' (2K)';
                    else if (f === 1080) label += ' (HD)';
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

            // Scroll to results
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

        progressContainer.classList.remove('hidden');
        downloadBtn.disabled = true;
        
        const downloadUrl = `/api/download?url=${encodeURIComponent(currentUrl)}&quality=${quality}`;
        
        // Mobile browsers block programmatic anchor clicks for downloads taking a long time.
        // Directing window.location is more reliable.
        window.location.href = downloadUrl;

        // We reset the UI because native browser downloads happen outside the JS sandbox.
        // It might take the backend a little while to merge the video before the browser "Save As" prompts.
        setTimeout(() => {
            progressContainer.classList.add('hidden');
            downloadBtn.disabled = false;
        }, 8000);
    });
});
