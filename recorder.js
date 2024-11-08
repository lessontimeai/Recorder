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

// Render interval
let renderInterval = null;
const RENDER_INTERVAL = 1000 / 30; // 30 fps

// Initialize IndexedDB
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

        // Get webcam stream
        webcamStream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                width: 640,
                height: 480
            } 
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

// Modified renderVideoToCanvas function
function renderVideoToCanvas() {
    if (!recording) return;
    
    try {
        faceMeshCtx.drawImage(screenVideo, 0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
        drawResults(latest_results);
    } catch (error) {
        console.error('Error rendering to canvas:', error);
    }
}

// Record button click handler
recordBtn.addEventListener('click', async () => {
    if (!recording) {
        try {
            recording = true;
            recordBtn.textContent = 'Stop Recording';
            recordBtn.classList.add('recording');
            startTimer();
            downloadBtn.style.display = 'none';

            // Get screen stream
            screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: {
                    displaySurface: 'monitor',
                    frameRate: 30
                }
            });
            
            screenVideo = document.getElementById('screenvideo');
            screenVideo.srcObject = screenStream;
            await screenVideo.play();

            // Initialize face mesh
            const faceMeshInitialized = await initFaceMesh();
            if (!faceMeshInitialized) {
                throw new Error('Failed to initialize face mesh');
            }

            // Set up canvas
            faceMeshCanvas.width = 3840;
            faceMeshCanvas.height = 2160;
            
            // Get microphone stream
            micStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });

            // Start continuous rendering
            renderInterval = setInterval(() => {
                renderVideoToCanvas();
                if (webcamStream && faceMesh) {
                    const webcamVideo = document.getElementById('webcam');
                    faceMesh.send({ image: webcamVideo }).catch(console.error);
                }
            }, RENDER_INTERVAL);

            // Combine streams
            const canvasStream = faceMeshCanvas.captureStream(30);
            combinedStream = new MediaStream([
                ...canvasStream.getTracks(),
                ...micStream.getTracks()
            ]);

            // Initialize video recorder
            recordedVideoChunks = [];
            videoRecorder = new MediaRecorder(combinedStream, {
                mimeType: 'video/mp4',
                videoBitsPerSecond: 8000000 // 8 Mbps
            });
            
            videoRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedVideoChunks.push(event.data);
                }
            };

            videoRecorder.onstop = () => {
                const blob = new Blob(recordedVideoChunks, { type: 'video/mp4' });
                saveRecording(blob, null, 'face');
            };

            videoRecorder.start(1000); // Capture chunks every second
            isRecordingVideo = true;

        } catch (err) {
            console.error('Error starting recording:', err);
            stopRecording();
        }
    } else {
        stopRecording();
    }
});

function onResults(results) {
    latest_results = results;
}

function drawResults(results) {
    if (!results) return;
    
    if (results.multiFaceLandmarks) {
        for (const landmarks of results.multiFaceLandmarks) {
            const scaledLandmarks = landmarks.map(landmark => ({
                x: landmark.x * 0.33 + 0,
                y: landmark.y * 0.33 + 0.7,
                z: landmark.z * 0.33
            }));

            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_TESSELATION,
                { color: '#C0C0C070', lineWidth: 1 });
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

function stopRecording() {
    recording = false;
    recordBtn.textContent = 'Start Recording';
    recordBtn.classList.remove('recording');
    stopTimer();

    // Stop rendering
    if (renderInterval) {
        clearInterval(renderInterval);
        renderInterval = null;
    }

    if (videoRecorder && videoRecorder.state !== 'inactive') {
        videoRecorder.stop();
    }

    // Stop all streams
    stopMediaTracks();
    
    // Clear face mesh
    if (faceMesh) {
        faceMesh.close();
        faceMesh = null;
    }

    // Clear canvas
    faceMeshCtx.clearRect(0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
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

const closeVideoPlayer = (event) => {
    const videoPlayer = document.getElementById('videoplayer');
    videoPlayer.pause();
    videoPlayer.src = '';
    document.getElementById("playercontainer").style.display = "none";
    window.removeEventListener('click', closeVideoPlayer);
};

async function loadRecordings() {
    const transaction = db.transaction(['recordings', 'thumbnails'], 'readonly');
    const recordingsStore = transaction.objectStore('recordings');
    const thumbnailsStore = transaction.objectStore('thumbnails');

    const recordings = [];
    const thumbnails = new Map();

    // Load recordings
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

    // Load thumbnails
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

    // Clear existing list
    const recordingsList = document.getElementById('recordings-list');
    recordingsList.innerHTML = '';

    // Append recordings
    recordings.sort((a, b) => b.timestamp - a.timestamp); // Sort by latest first
    recordings.forEach(recording => {
        const thumbnailUrl = thumbnails.get(recording.id) || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJYAAACWCAMAAADzP4xAAAAA1BMVEX///+nxBvIAAAAK0lEQVR4nO3BMQEAAADCoPVPbQ0PoAAAAAAAAAAAAAAAAAAAAPwG8tgAAAXT5DUsAAAAASUVORK5CYII='; // Placeholder image
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

    // Play link
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

    // Download link
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

    // Delete link
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
            const thumbnailId = recordingId;
            const thumbnailData = {
                id: thumbnailId,
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
            // Delete thumbnail
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
