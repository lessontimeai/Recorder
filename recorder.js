// Variables
let recording = false;
let mediaRecorder;
let recordedChunks = [];
let timerElement = document.getElementById('timer');
let recordBtn = document.getElementById('record-btn');
let downloadBtn = document.getElementById('download-btn');
let timerInterval;

// Video recording for the canvas
let videoRecorder;
let recordedVideoChunks = [];
let isRecordingVideo = false;

// Streams and video elements
let screenStream = null;
let micStream = null;
let combinedStream = null;
let screenVideo = null;
let webcamStream = null;

// Face Mesh Variables
let faceMesh;
let faceMeshCanvas = document.getElementById('facepoints');
let faceMeshCtx = faceMeshCanvas.getContext('2d');
let latest_results = null;
let recordingInterval = null;
let face_background_process = false;

// FaceMesh constants assumed available
// (Ensure these imports or definitions in actual code environment)
// import { FACEMESH_TESSELATION, FACEMESH_RIGHT_EYE, FACEMESH_LEFT_EYE, 
// FACEMESH_FACE_OVAL, FACEMESH_LIPS } from '@mediapipe/face_mesh';
// import { drawConnectors } from '@mediapipe/drawing_utils';

// Create Web Worker for timing
const workerCode = `
    let interval;
    self.onmessage = function(e) {
        if (e.data === 'start') {
            interval = setInterval(() => {
                self.postMessage('tick');
            }, 100); // ~100 fps
        } else if (e.data === 'stop') {
            clearInterval(interval);
        }
    };
`;

const blob = new Blob([workerCode], { type: 'application/javascript' });
const worker = new Worker(URL.createObjectURL(blob));

worker.onmessage = async function() {
    renderVideoToCanvas();
    if (face_background_process)
        face_detect();
};

worker.postMessage('start');

window.addEventListener('beforeunload', () => {
    worker.postMessage('stop');
    worker.terminate();
});

// IndexedDB Initialization
let db;
const request = indexedDB.open('ScreenRecorderDB', 4);

request.onerror = (event) => {
    console.error('IndexedDB error:', event.target.errorCode);
};

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

// Face detection
const face_detect = async () => {
    const webcamVideo = document.getElementById('webcam');
    if (webcamVideo.readyState === 4 && recording) {
        if (faceMesh)
            await faceMesh.send({ image: webcamVideo });
    }
};

// Initialize Face Mesh
async function initFaceMesh() {
    try {
        faceMesh = new FaceMesh({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
            }
        });

        faceMesh.setOptions({
            maxNumFaces: 3,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        faceMesh.onResults(onResults);


        webcamStream = await navigator.mediaDevices.getUserMedia({ 
            video: { width: 640, height: 480 } 
        });

        
        const webcamVideo = document.getElementById('webcam');


        
        webcamVideo.srcObject = webcamStream;
        await webcamVideo.play();

        return true;
    } catch (error) {
        console.error('Error initializing Face Mesh:', error);
        return false;
    }
}

// Start/Stop Recording
let startRecording = async () => {
    if (!recording) {
        try {
            recording = true;
            recordBtn.textContent = 'Stop Recording';
            recordBtn.classList.add('recording');
            startTimer();
            downloadBtn.style.display = 'none';

            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            screenVideo = document.getElementById('screenvideo');
            screenVideo.srcObject = screenStream;
            await screenVideo.play();

            const faceMeshInitialized = await initFaceMesh();
            
            if (!faceMeshInitialized) {
                throw new Error('Failed to initialize face mesh');
            }

            faceMeshCanvas.width = 4096;
            faceMeshCanvas.height = 2160;
            
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            startRendering();

            const canvasStream = faceMeshCanvas.captureStream(60);
            combinedStream = new MediaStream([
                ...canvasStream.getTracks(),
                ...micStream.getTracks()
            ]);

            recordedVideoChunks = [];
            videoRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/mp4' });
            
            videoRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedVideoChunks.push(event.data);
                }
            };

            setTimeout (()=> {
                face_background_process = true;
            }, 1000);
            videoRecorder.onstop = async () => {
                const blob = new Blob(recordedVideoChunks, { type: 'video/mp4' });
                setTimeout(async () => {
                    const thumbnail = await captureThumbnail();
                    saveRecording(blob, thumbnail, 'face');
                }, 2000);
            };

            videoRecorder.start();
            isRecordingVideo = true;
        } catch (err) {
            console.error('Error starting recording:', err);
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

    if (videoRecorder && videoRecorder.state !== 'inactive') {
        videoRecorder.stop();
    }

    stopMediaTracks();
    stopRendering();

    if (faceMesh) {
        faceMesh.close();
        faceMesh = null;
    }

    faceMeshCtx.clearRect(0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
    face_background_process = false;
}

function stopMediaTracks() {
    const streams = [screenStream, micStream, webcamStream, combinedStream];
    streams.forEach(stream => {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
    });
    screenStream = null;
    micStream = null;
    webcamStream = null;
    combinedStream = null;
}

// Rendering
function startRendering() {
    if (recordingInterval) return;

    recordingInterval = setInterval(() => {
        if (screenVideo && faceMeshCanvas) {
            faceMeshCtx.clearRect(0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
            faceMeshCtx.drawImage(screenVideo, 0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
            drawResults(latest_results);
        }
    }, 16.666);  // ~60FPS
}

function stopRendering() {
    if (recordingInterval) {
        clearInterval(recordingInterval);
        recordingInterval = null;
    }
}

async function captureThumbnail() {
    try {
        const thumbnailCanvas = document.createElement('canvas');
        const THUMBNAIL_WIDTH = 320;
        const THUMBNAIL_HEIGHT = 180;

        thumbnailCanvas.width = THUMBNAIL_WIDTH;
        thumbnailCanvas.height = THUMBNAIL_HEIGHT;
        const thumbnailCtx = thumbnailCanvas.getContext('2d');

        if (screenVideo && screenVideo.readyState === 4) {
            try {
                thumbnailCtx.drawImage(
                    screenVideo, 
                    0, 0, screenVideo.videoWidth, screenVideo.videoHeight,
                    0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT
                );
            } catch (error) {
                console.warn('Could not draw screen content:', error);
            }
        }

        return new Promise((resolve, reject) => {
            thumbnailCanvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Failed to create thumbnail blob'));
                    }
                },
                'image/jpeg',
                0.85
            );
        });
    } catch (error) {
        console.error('Error in captureThumbnail:', error);
        return null;
    }
}

function onResults(results) {
    latest_results = results;
}

function drawResults(results) {
    if (!results) return;
    if (results.multiFaceLandmarks) {
        for (const landmarks of results.multiFaceLandmarks) {
            const scaledLandmarks = landmarks.map(landmark => ({
                x: landmark.x * 0.2 + 0.8,
                y: landmark.y * 0.2 + 0.8,
                z: landmark.z * 0.2
            }));

            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_TESSELATION,
                { color: '#C0C0C0A0', lineWidth: 1 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_RIGHT_EYE, 
                { color: '#30FF30', lineWidth: 1 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_LEFT_EYE, 
                { color: '#30FF30', lineWidth: 1 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_FACE_OVAL, 
                { color: '#E0E0E0', lineWidth: 1 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_LIPS, 
                { color: '#E0E0E0', lineWidth: 1 });
        }
    }
}

// Timer Functions
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

// Record Button Click Handler
recordBtn.addEventListener('click', startRecording);

function renderVideoToCanvas() {
    if (!recording) return;
    if (screenVideo) {
        faceMeshCtx.drawImage(screenVideo, 0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
    }
    drawResults(latest_results);
}

async function loadRecordings() {
    const transaction = db.transaction(['recordings', 'thumbnails'], 'readonly');
    const recordingsStore = transaction.objectStore('recordings');
    const thumbnailsStore = transaction.objectStore('thumbnails');

    const recordings = [];
    const thumbnails = new Map();

    const recordingsCursor = recordingsStore.openCursor();
    await new Promise((resolve, reject) => {
        recordingsCursor.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                recordings.push(cursor.value);
                cursor.continue();
            } else {
                resolve();
            }
        };
        recordingsCursor.onerror = (event) => reject(event.target.error);
    });

    const thumbnailsCursor = thumbnailsStore.openCursor();
    await new Promise((resolve, reject) => {
        thumbnailsCursor.onsuccess = (event) => {
            const cursor = event.target.result;
            if (cursor) {
                thumbnails.set(cursor.value.recordingId, URL.createObjectURL(cursor.value.thumbnail));
                cursor.continue();
            } else {
                resolve();
            }
        };
        thumbnailsCursor.onerror = (event) => reject(event.target.error);
    });

    const recordingsList = document.getElementById('recordings-list');
    recordingsList.innerHTML = '';

    recordings.sort((a, b) => b.timestamp - a.timestamp);
    recordings.forEach(recording => {
        const thumbnailUrl = thumbnails.get(recording.id) || 
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAMAAADzP4xAAAAA1BMVEX///+nxBvIAAAAK0lEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAPwG8tgAAAXT5DUsAAAAASUVORK5CYII=';
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
    const timestamp = new Date(recording.timestamp).toLocaleString();
    const infoText = document.createElement('p');
    infoText.textContent = `Recorded on: ${timestamp} (${recording.type})`;
    infoDiv.appendChild(infoText);
    listItem.appendChild(infoDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'recording-actions';

    const playLink = document.createElement('a');
    playLink.textContent = 'Play';
    playLink.href = '#';
    playLink.addEventListener('click', (e) => {
        e.preventDefault();
        const videoPlayer = document.getElementById('videoplayer');
        const videoURL = URL.createObjectURL(recording.blob);
        videoPlayer.src = videoURL;
        videoPlayer.controls = true;
        document.getElementById("playercontainer").style.display = "block";
    });
    actionsDiv.appendChild(playLink);

    const downloadLink = document.createElement('a');
    downloadLink.textContent = 'Download';
    downloadLink.href = '#';
    downloadLink.addEventListener('click', (e) => {
        e.preventDefault();
        const videoURL = URL.createObjectURL(recording.blob);
        const a = document.createElement('a');
        a.href = videoURL;
        a.download = `recording_${recordingId}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });
    actionsDiv.appendChild(downloadLink);

    const deleteLink = document.createElement('a');
    deleteLink.textContent = 'Delete';
    deleteLink.href = '#';
    deleteLink.className = 'delete-link';
    deleteLink.addEventListener('click', async (e) => {
        e.preventDefault();
        if (confirm('Are you sure you want to delete this recording?')) {
            await deleteRecording(recordingId);
        }
    });
    actionsDiv.appendChild(deleteLink);

    listItem.appendChild(actionsDiv);
    document.getElementById('recordings-list').appendChild(listItem);
}

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

    const recordingRequest = recordingsStore.put(recording);

    recordingRequest.onsuccess = () => {
        console.log('Recording saved:', recordingId);
        if (thumbnail) {
            const thumbnailData = {
                id: recordingId,
                recordingId: recordingId,
                thumbnail: thumbnail
            };
            thumbnailsStore.put(thumbnailData);
        }
        loadRecordings();
    };

    recordingRequest.onerror = (event) => {
        console.error('Error saving recording:', event.target.error);
    };
}

function deleteRecording(recordingId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['recordings', 'thumbnails'], 'readwrite');
        const recordingsStore = transaction.objectStore('recordings');
        const thumbnailsStore = transaction.objectStore('thumbnails');

        const deleteRecordingRequest = recordingsStore.delete(recordingId);
        const deleteThumbnailRequest = thumbnailsStore.index('recordingId').openCursor(IDBKeyRange.only(recordingId));

        deleteRecordingRequest.onsuccess = () => {
            console.log('Recording deleted:', recordingId);
            deleteThumbnailRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    thumbnailsStore.delete(cursor.primaryKey);
                    cursor.continue();
                }
                loadRecordings();
                resolve();
            };
            deleteThumbnailRequest.onerror = (event) => {
                console.error('Error deleting thumbnail:', event.target.error);
                loadRecordings();
                resolve();
            };
        };

        deleteRecordingRequest.onerror = (event) => {
            console.error('Error deleting recording:', event.target.error);
            reject(event.target.error);
        };
    });
}

function closeVideoPlayer(event) {
    const videoPlayer = document.getElementById('videoplayer');
    const playerContainer = document.getElementById('playercontainer');
    videoPlayer.pause();
    videoPlayer.src = '';
    playerContainer.style.display = 'none';
    window.removeEventListener('click', closeVideoPlayer);
}
