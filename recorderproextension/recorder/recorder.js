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

document.addEventListener('DOMContentLoaded', () => {
    const closePlayerBtn = document.getElementById('playerclose');
    if (closePlayerBtn) {
        closePlayerBtn.addEventListener('click', closeVideoPlayer);
    }
});

// Recording functions
async function startRecording() {
    if (!recording) {
        recording = true;
        recordBtn.textContent = 'Stop Recording';
        recordBtn.classList.add('recording');
        startTimer();
        downloadBtn.style.display = 'none';

        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            if (recordMode === 'screen') {
                screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                combinedStream = new MediaStream([
                    ...screenStream.getTracks(), 
                    ...micStream.getTracks()
                ]);
            } else {
                combinedStream = new MediaStream([...micStream.getTracks()]);
            }

            mediaRecorder = new MediaRecorder(combinedStream, { 
                mimeType: recordMode === 'screen' ? 'video/mp4' : 'audio/webm'
            });
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = async () => {
                try {
                    const blob = new Blob(recordedChunks, { 
                        type: recordMode === 'screen' ? 'video/mp4' : 'audio/webm' 
                    });
                    const thumbnail = recordMode === 'screen' ? await generateThumbnail(blob) : null;
                    await saveRecording(blob, thumbnail, recordMode);
                    recordedChunks = [];
                } catch (error) {
                    console.error('Error processing recording:', error);
                } finally {
                    stopMediaTracks();
                }
            };

            mediaRecorder.start();
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
    recordBtn.textContent = 'Start Recording';
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

// Database operations
function saveRecording(blob, thumbnail, type) {
    const transaction = db.transaction(['recordings', 'thumbnails'], 'readwrite');
    const recordingsStore = transaction.objectStore('recordings');
    const thumbnailsStore = transaction.objectStore('thumbnails');

    const recordingId = Date.now();
    const recording = {
        id: recordingId,
        blob: blob,
        timestamp: recordingId,
        type: type
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
    infoDiv.innerHTML = `<p>Recorded on: ${new Date(recording.timestamp).toLocaleString()} (${recording.type})</p>`;
    listItem.appendChild(infoDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'recording-actions';

    const playLink = document.createElement('a');
    playLink.textContent = 'Play';
    playLink.href = '#';
    playLink.onclick = (e) => {
        e.preventDefault();
        const videoPlayer = document.getElementById('videoplayer');
        videoPlayer.src = URL.createObjectURL(recording.blob);
        videoPlayer.controls = true;
        document.getElementById("playercontainer").style.display = "block";
    };

    const downloadLink = document.createElement('a');
    downloadLink.textContent = 'Download';
    downloadLink.href = '#';
    downloadLink.onclick = (e) => {
        e.preventDefault();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(recording.blob);
        a.download = `recording_${recordingId}.${recording.type === 'screen' ? 'mp4' : 'webm'}`;
        a.click();
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
function closeVideoPlayer() {
    const videoPlayer = document.getElementById('videoplayer');
    const playerContainer = document.getElementById('playercontainer');
    videoPlayer.pause();
    videoPlayer.src = '';
    playerContainer.style.display = 'none';
}

document.getElementById('delete-all-btn')?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to delete ALL recordings? This action cannot be undone!')) {
        await deleteAllRecordings();
    }
});

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