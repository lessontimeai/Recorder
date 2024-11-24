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
let screenVideo = null;
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

// Global references to streams
let screenStream = null;
let micStream = null;
let combinedStream = null;

// Face Mesh Variables
let faceMesh;
let webcamStream = null;
let faceMeshCanvas = document.getElementById('facepoints');
let faceMeshCtx = faceMeshCanvas.getContext('2d');
let camera = null;

// Initialize Face Mesh on Page Load
window.addEventListener('DOMContentLoaded', async () => {
    try {
        await initFaceMesh();
    } catch (error) {
        console.error('Failed to initialize Face Mesh on page load:', error);
        alert('Failed to initialize Face Mesh. Please ensure you have granted webcam permissions.');
    }
});

async function startRecording() {
    if (!recording) {
        // Start Recording
        recording = true;
        recordBtn.textContent = 'Stop Recording';
        recordBtn.classList.add('recording');
        startTimer();
        downloadBtn.style.display = 'none';

        try {
            // Get screen and microphone streams
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            screenVideo = document.getElementById('screenvideo');
            screenVideo.srcObject = screenStream;
            await screenVideo.play();

            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Combine screen and microphone streams
            combinedStream = new MediaStream([...screenStream.getTracks(), ...micStream.getTracks()]);

            // Initialize MediaRecorder for screen recording
            mediaRecorder = new MediaRecorder(combinedStream, { mimeType: 'video/mp4;' });

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: 'video/mp4' });
                generateThumbnail(blob).then(thumbnail => {
                    saveRecording(blob, thumbnail, 'screen');
                }).catch(err => {
                    console.error('Error generating thumbnail:', err);
                    saveRecording(blob, null, 'screen');
                });
                recordedChunks = []; // Clear after saving

                // Stop all media tracks to end screen sharing and microphone
                stopMediaTracks();
            };

            // Start recording
            mediaRecorder.start();
            startCanvasRecording(); // Start recording the canvas

        } catch (err) {
            console.error('Error accessing media devices.', err);
            recording = false;
            recordBtn.textContent = 'Start Recording';
            recordBtn.classList.remove('recording');
            stopTimer();
        }

    } else {
        // Stop Recording
        recording = false;
        recordBtn.textContent = 'Start Recording';
        recordBtn.classList.remove('recording');
        stopTimer();

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        stopCanvasRecording(); // Stop recording the canvas
    }
}

recordBtn.addEventListener('click', startRecording);

function stopMediaTracks() {
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (combinedStream) {
        combinedStream.getTracks().forEach(track => track.stop());
        combinedStream = null;
    }
}

async function generateThumbnail(blob) {
    // Create a video element to extract a frame
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(blob);
        video.crossOrigin = 'anonymous';
        video.addEventListener('loadeddata', () => {
            // Wait for the video to be ready
            video.currentTime = 1; // Capture frame at 1 second
        });
        video.addEventListener('seeked', () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob((thumbnailBlob) => {
                resolve(thumbnailBlob);
            }, 'image/jpeg');
        });
        video.onerror = (event) => {
            reject(new Error('Error generating thumbnail'));
        };
    });
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
        type: type // Store type for identification
    };

    const recordingRequest = recordingsStore.put(recording);

    recordingRequest.onsuccess = () => {
        console.log('Recording saved:', recordingId);
        if (thumbnail) {
            const thumbnailId = recordingId; // Use the same ID for easier reference
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

function fetchThumbnail(recordingId) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(['thumbnails'], 'readonly');
        const objectStore = transaction.objectStore('thumbnails');
        const request = objectStore.index('recordingId').get(recordingId);

        request.onsuccess = (event) => {
            const result = event.target.result;
            if (result) {
                resolve(result.thumbnail);
            } else {
                resolve(null);
            }
        };

        request.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

// Close video player function
function closeVideoPlayer(event) {
    const videoPlayer = document.getElementById('videoplayer');
    const playerContainer = document.getElementById('playercontainer');
    videoPlayer.pause();
    videoPlayer.src = '';
    playerContainer.style.display = 'none';
    window.removeEventListener('click', closeVideoPlayer);
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

// Face Mesh Functions using MediaPipe
async function initFaceMesh() {
    return new Promise((resolve, reject) => {
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

            const webcamVideo = document.getElementById('webcam');

            camera = new Camera(webcamVideo, {
                onFrame: async () => {
                    await faceMesh.send({ image: webcamVideo });
                },
                width: 640,
                height: 480
            });
            camera.start();

            resolve();
        } catch (error) {
            console.error('Error initializing Face Mesh:', error);
            reject(error);
        }
    });
}
let latest_results=null;
function onResults(results) {
    latest_results = results;
}

function drawResults(results) {
    if (!results) return;



    if (results.multiFaceLandmarks) {
        for (const landmarks of results.multiFaceLandmarks) {
            const scaledLandmarks = landmarks.map(landmark => ({
                x: landmark.x * 0.25 + 0.75,
                y: landmark.y * 0.25 + 0.75,
                z: landmark.z * 0.25
            }));

            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_TESSELATION,
                { color: '#C0C0C070', lineWidth: 0.5 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_RIGHT_EYE, 
                { color: '#30FF30', lineWidth: 0.5 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_LEFT_EYE, 
                { color: '#30FF30', lineWidth: 0.5 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_FACE_OVAL, 
                { color: '#E0E0E0', lineWidth: 0.5 });
            drawConnectors(faceMeshCtx, scaledLandmarks, FACEMESH_LIPS, 
                { color: '#E0E0E0', lineWidth: 0.5 });
        }
    }
}

function renderFaceCanvas() {
    if (screenVideo)
        faceMeshCtx.drawImage(screenVideo, 0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
    if (latest_results)
        drawResults(latest_results);
    requestAnimationFrame(renderFaceCanvas);
}
requestAnimationFrame(renderFaceCanvas);


// Start recording canvas video
function startCanvasRecording() {
    recordedVideoChunks = []; // Clear previous video chunks

    const canvasStream = faceMeshCanvas.captureStream(30); // Capture the canvas at 30 fps
    videoRecorder = new MediaRecorder(canvasStream, { mimeType: 'video/mp4' });

    videoRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            recordedVideoChunks.push(event.data);
        }
    };

    videoRecorder.onstop = () => {};
    videoRecorder.start();
    isRecordingVideo = true;
}

// Stop recording canvas video
function stopCanvasRecording() {
    if (videoRecorder && isRecordingVideo) {
        videoRecorder.stop();
        isRecordingVideo = false;
    }
}

// Function to reset face mesh
function stopFaceMesh() {
    if (camera) {
        camera.stop();
        camera = null;
    }
    if (faceMesh) {
        faceMesh.close();
        faceMesh = null;
    }
    // Clear canvas
    faceMeshCtx.clearRect(0, 0, faceMeshCanvas.width, faceMeshCanvas.height);
}
