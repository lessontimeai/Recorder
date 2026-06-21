// Recording state variables
let recording = false;
let mediaRecorder;
let recordedChunks = [];
let timerElement = document.getElementById('timer');
let recordBtn = document.getElementById('record-btn');
let downloadBtn = document.getElementById('download-btn');
let timerInterval;

// Stream references
let screenStream = null;
let micStream = null;
let combinedStream = null;
let recordMode = 'screen'; // 'screen' or 'audio'

// Initialize IndexedDB
let db;
const request = indexedDB.open('ScreenRecorderDB', 4);

request.onerror = (event) => {
    console.error('IndexedDB error:', event.target.errorCode);
};

// Check if user has seen welcome modal
let hasSeenWelcome = localStorage.getItem('hasSeenWelcome');
const firstModal = document.getElementById('firstmodal');

if (hasSeenWelcome!='true') {
    firstModal.style.display = 'block';
    

    document.querySelector('#spay').addEventListener('click', () => {
        firstModal.style.display = 'none';
        localStorage.setItem('hasSeenWelcome', 'true');
    });

} else {
    firstModal.style.display = 'none';
}

function checkNumberofTrials(){
    let trialcount = localStorage.getItem('trialcount');
    if(trialcount==null){
        localStorage.setItem('trialcount', '1');
    }else{
        localStorage.setItem('trialcount', parseInt(trialcount)+1);
    }
    return trialcount;
}


request.onupgradeneeded = (event) => {
    db = event.target.result;
    if (!db.objectStoreNames.contains('recordings')) {
        const objectStore = db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
        objectStore.createIndex('timestamp', 'timestamp', { unique: false });
    }
    if (!db.objectStoreNames.contains('thumbnails')) {
        const thumbnailStore = db.createObjectStore('thumbnails', { keyPath: 'id', autoIncrement: true });
        thumbnailStore.createIndex('recordingId', 'recordingId', { unique: false });
    }
};

request.onsuccess = (event) => {
    db = event.target.result;
    loadRecordings();
};

// Timer functions
function startTimer() {
    let seconds = 0;
    timerInterval = setInterval(() => {
        seconds++;
        timerElement.textContent = `Recording: ${seconds} sec`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerElement.textContent = '';
}

// Button click handlers
document.getElementById('facemesh-btn').addEventListener('click', () => {
    window.location.href = 'https://lessontime.ai/recorderpro';
});

document.getElementById('soundrecord-btn').addEventListener('click', () => {
    recordMode = 'audio';
    startRecording();
});

document.getElementById('record-btn').addEventListener('click', () => {
    recordMode = 'screen';
    startRecording();
});

// Wire up listeners that depend on the DOM being ready.
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('playerclose')?.addEventListener('click', closeVideoPlayer);

    document.getElementById('delete-all-btn')?.addEventListener('click', async () => {
        if (confirm('Are you sure you want to delete ALL recordings? This action cannot be undone!')) {
            await deleteAllRecordings();
        }
    });
});

// Recording functions

// Choose a video container/codec that is both recordable and reliably
// playable in the browser, preferring real MP4, then native WebM codecs.
function pickVideoFormat() {
    const candidates = [
        { mimeType: 'video/mp4;codecs=avc1', fileExtension: 'mp4' },
        { mimeType: 'video/mp4', fileExtension: 'mp4' },
        { mimeType: 'video/webm;codecs=vp9', fileExtension: 'webm' },
        { mimeType: 'video/webm;codecs=vp8', fileExtension: 'webm' },
        { mimeType: 'video/webm', fileExtension: 'webm' },
    ];
    return candidates.find(c => MediaRecorder.isTypeSupported(c.mimeType))
        ?? { mimeType: 'video/webm', fileExtension: 'webm' };
}

async function startRecording() {
    let trialcount = checkNumberofTrials();
    if(trialcount>3 && hasSeenWelcome==null){
        alert('You have reached the maximum number of trials. Please upgrade to Pro to continue recording.');
        return;
    }
    if (!recording) {
        recording = true;
        recordBtn.textContent = 'Stop Recording';
        recordBtn.classList.add('recording');
        startTimer();
        downloadBtn.style.display = 'none';

        // Clear any chunks left over from a previous recording that errored
        // out before onstop could reset them.
        recordedChunks = [];

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            let videoBitsPerSecond;
            if (recordMode === 'screen') {
                // 4K recording with optimized settings
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        width: { ideal: 3840, max: 3840 },
                        height: { ideal: 2160, max: 2160 },
                        frameRate: { ideal: 30, max: 30 }
                    },
                    audio: false
                });

                // Hint the encoder that this is sharp, text-heavy content. Without
                // this, screen captures are treated as "motion" and the encoder
                // smears/flickers fine edges (menu bars, the top of the screen).
                const videoTrack = screenStream.getVideoTracks()[0];
                videoTrack.contentHint = 'detail';

                // Size the bitrate to the actual capture resolution. A flat 2 Mbps
                // starves a 4K stream and causes flicker; ~0.12 bits/pixel/frame
                // keeps the encoder fed across resolutions.
                const { width = 1920, height = 1080, frameRate = 30 } = videoTrack.getSettings();
                videoBitsPerSecond = Math.min(Math.round(width * height * frameRate * 0.12), 40000000);

                combinedStream = new MediaStream([
                    ...screenStream.getTracks(),
                    ...micStream.getTracks()
                ]);
            } else {
                combinedStream = new MediaStream([...micStream.getTracks()]);
            }

            // Pick the best codec the browser can both RECORD and PLAY BACK.
            // Note: Chrome can record "video/webm;codecs=h264" but cannot decode
            // it, which produces files with audio but a black picture — so it is
            // deliberately excluded here.
            const { mimeType, fileExtension } = recordMode === 'screen'
                ? pickVideoFormat()
                : { mimeType: 'audio/webm', fileExtension: 'webm' };

            const options = { mimeType };
            if (videoBitsPerSecond) {
                options.videoBitsPerSecond = videoBitsPerSecond;
            }

            mediaRecorder = new MediaRecorder(combinedStream, options);
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                try {
                    const blob = new Blob(recordedChunks, { type: mimeType });
                    const thumbnail = recordMode === 'screen' ? await generateThumbnail(blob) : null;
                    await saveRecording(blob, thumbnail, recordMode, fileExtension);
                    recordedChunks = [];
                } catch (error) {
                    console.error('Error processing recording:', error);
                } finally {
                    stopMediaTracks();
                }
            };

            mediaRecorder.start(1000);
        } catch (err) {
            console.error('Error accessing media devices:', err);
            stopRecording();
        }
    } else {
        stopRecording();
    }
}

function stopRecording() {
    recording = false;
    recordBtn.textContent = 'Screen Recording';
    recordBtn.classList.remove('recording');
    stopTimer();
    recordMode = 'screen'; // Reset to default mode

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
}

function stopMediaTracks() {
    const streams = [screenStream, micStream, combinedStream];
    streams.forEach(stream => {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
    });
    screenStream = null;
    micStream = null;
    combinedStream = null;
}

// Thumbnail generation
async function generateThumbnail(blob) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.autoplay = true;
        video.muted = true;
        const url = URL.createObjectURL(blob);
        video.src = url;

        video.addEventListener('loadeddata', () => {
            const canvas = document.createElement('canvas');
            canvas.width = 320;
            canvas.height = 180;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            canvas.toBlob((thumbnailBlob) => {
                URL.revokeObjectURL(url);
                video.remove();
                resolve(thumbnailBlob);
            }, 'image/jpeg', 0.8);
        });

        video.addEventListener('error', () => {
            URL.revokeObjectURL(url);
            video.remove();
            reject(new Error('Error generating thumbnail'));
        });
    });
}

// Format a timestamp (epoch ms) as a sortable, filename-safe string,
// e.g. 2026-06-09 14:05:37 -> "2026-06-09_14-05-37"
function formatTimestamp(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${date}_${time}`;
}

// Database operations
function saveRecording(blob, thumbnail, type, fileExtension) {
    const transaction = db.transaction(['recordings', 'thumbnails'], 'readwrite');
    const recordingsStore = transaction.objectStore('recordings');
    const thumbnailsStore = transaction.objectStore('thumbnails');

    const recordingId = Date.now();
    const recording = {
        id: recordingId,
        blob: blob,
        timestamp: recordingId,
        type: type,
        fileExtension: fileExtension || 'webm' // Default to webm if not provided
    };

    recordingsStore.put(recording).onsuccess = () => {
        if (thumbnail) {
            thumbnailsStore.put({
                id: recordingId,
                recordingId: recordingId,
                thumbnail: thumbnail
            });
        }
        loadRecordings();
    };
}

async function loadRecordings() {
    const transaction = db.transaction(['recordings', 'thumbnails'], 'readonly');
    const recordings = [];
    const thumbnails = new Map();

    await Promise.all([
        new Promise((resolve, reject) => {
            transaction.objectStore('recordings').openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    recordings.push(cursor.value);
                    cursor.continue();
                } else resolve();
            };
        }),
        new Promise((resolve, reject) => {
            transaction.objectStore('thumbnails').openCursor().onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    thumbnails.set(cursor.value.recordingId, URL.createObjectURL(cursor.value.thumbnail));
                    cursor.continue();
                } else resolve();
            };
        })
    ]);

    const recordingsList = document.getElementById('recordings-list');
    recordingsList.innerHTML = '';
    
    recordings.sort((a, b) => b.timestamp - a.timestamp)
        .forEach(recording => {
            const thumbnailUrl = thumbnails.get(recording.id) || 
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
            appendRecordingItem(recording.id, recording, thumbnailUrl);
        });
}

function appendRecordingItem(recordingId, recording, thumbnailUrl) {
    const listItem = document.createElement('li');
    listItem.className = 'recording-item';

    const thumbnailImg = document.createElement('img');
    thumbnailImg.src = thumbnailUrl;
    listItem.appendChild(thumbnailImg);

    const infoDiv = document.createElement('div');
    infoDiv.className = 'recording-info';
    infoDiv.innerHTML = `<p>Recorded on: ${new Date(recording.timestamp).toLocaleString()} (${recording.type} - ${recording.fileExtension?.toUpperCase() || 'WEBM'})</p>`;
    listItem.appendChild(infoDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'recording-actions';

    const playLink = document.createElement('a');
    playLink.textContent = 'Play';
    playLink.href = '#';
    playLink.onclick = (e) => {
        e.preventDefault();
        openVideoPlayer(recording.blob);
    };

    const downloadLink = document.createElement('a');
    downloadLink.textContent = 'Download';
    downloadLink.href = '#';
    downloadLink.onclick = (e) => {
        e.preventDefault();
        const url = URL.createObjectURL(recording.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording_${formatTimestamp(recording.timestamp)}.${recording.fileExtension}`;
        a.click();
        URL.revokeObjectURL(url);
    };

    const deleteLink = document.createElement('a');
    deleteLink.textContent = 'Delete';
    deleteLink.href = '#';
    deleteLink.className = 'delete-link';
    deleteLink.onclick = async (e) => {
        e.preventDefault();
        if (confirm('Are you sure you want to delete this recording?')) {
            await deleteRecording(recordingId);
        }
    };

    actionsDiv.append(playLink, downloadLink, deleteLink);
    listItem.appendChild(actionsDiv);
    document.getElementById('recordings-list').appendChild(listItem);
}

function deleteRecording(recordingId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['recordings', 'thumbnails'], 'readwrite');
        
        Promise.all([
            transaction.objectStore('recordings').delete(recordingId),
            new Promise(resolve => {
                const thumbnailCursor = transaction.objectStore('thumbnails')
                    .index('recordingId')
                    .openCursor(IDBKeyRange.only(recordingId));
                
                thumbnailCursor.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        cursor.delete();
                        cursor.continue();
                    } else resolve();
                };
            })
        ]).then(() => {
            loadRecordings();
            resolve();
        }).catch(reject);
    });
}

// Video player controls
let currentPlayerUrl = null;

function openVideoPlayer(blob) {
    const videoPlayer = document.getElementById('videoplayer');
    const playerContainer = document.getElementById('playercontainer');

    // Release the URL from any previously played recording.
    if (currentPlayerUrl) {
        URL.revokeObjectURL(currentPlayerUrl);
    }
    currentPlayerUrl = URL.createObjectURL(blob);

    playerContainer.style.display = 'block';
    videoPlayer.controls = true;
    videoPlayer.src = currentPlayerUrl;
    videoPlayer.load(); // force the element to pick up the new source
    videoPlayer.play().catch(() => { /* user can press play manually */ });
}

function closeVideoPlayer() {
    const videoPlayer = document.getElementById('videoplayer');
    const playerContainer = document.getElementById('playercontainer');

    videoPlayer.pause();
    videoPlayer.removeAttribute('src');
    videoPlayer.load();
    playerContainer.style.display = 'none';

    if (currentPlayerUrl) {
        URL.revokeObjectURL(currentPlayerUrl);
        currentPlayerUrl = null;
    }
}

function deleteAllRecordings() {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['recordings', 'thumbnails'], 'readwrite');
        
        transaction.objectStore('recordings').clear();
        transaction.objectStore('thumbnails').clear();
        
        transaction.oncomplete = () => {
            loadRecordings();
            resolve();
        };
        
        transaction.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

