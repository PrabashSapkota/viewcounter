/* ── CORE SITE LOGIC ── */

let socket;
let myId = localStorage.getItem('lc_uid') || Math.random().toString(36).slice(2);
let shortId = 'default';
let encodedData = '';

// --- Initialization ---
window.onload = () => {
    initPlayer();
    
    // Viewer count logic - independent of local chat UI
    connectSocket();
};

function initPlayer() {
    const params = new URLSearchParams(window.location.search);
    const src = params.get('src');
    const title = params.get('title');

    if (src) {
        document.getElementById('mainVideoPlayer').src = src;
        shortId = src.length >= 30 ? src.slice(-50) : btoa(src).slice(0, 30);
        encodedData = btoa(src);
    }

    if (title) {
        const cleanTitle = decodeURIComponent(title);
        const dateString = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
        document.getElementById('displayTitle').innerHTML = `${cleanTitle} <span class="date-span">. ${dateString}</span>`;
        document.title = cleanTitle + " - BINTV";
    }
}

// --- Socket Management ---
function connectSocket() {
    if (socket && socket.connected) return;

    socket = io({ query: { id: shortId, userId: myId } });

    socket.on('connect', () => {
        socket.emit('requestViewCount');
    });

    socket.on('updateViewCount', data => {
        if (data.id === shortId) {
            const count = data.viewCount || 0;
            const vc = document.getElementById('viewerCount');
            if (vc) vc.textContent = count;
        }
    });
}

// --- Global Utils for Modals ---
window.toggleModal = (id) => {
    const el = document.getElementById(id);
    if (id === 'embedModal') {
        const embedUrl = `https://bintv.pages.dev/?id=${shortId}&data=${encodedData}`;
        document.getElementById('embedCode').value = `<iframe src="${embedUrl}" width="800" height="450" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
    }
    el.classList.toggle('active');
};

window.closeModals = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
    }
};

window.copyText = (id, isText) => {
    const el = document.getElementById(id);
    const val = isText ? el.innerText : el.value;
    navigator.clipboard.writeText(val).then(() => {
        alert('Copied to clipboard!');
    });
};
