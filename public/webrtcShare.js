import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, get, onValue, push, serverTimestamp, child, remove, onChildAdded, update } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getDatabase(app);

// STUN servers
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

const NUM_CHANNELS = 3;
const CHUNK_SIZE = 65536; // 64KB

// UI Elements
const btnOpenWebRTCShare = document.getElementById("btnOpenWebRTCShare");
const webrtcShareModal = document.getElementById("webrtcShareModal");
const closeWebRTCShareBtn = document.getElementById("closeWebRTCShareBtn");

const stateInitial = document.getElementById("webrtcStateInitial");
const stateSender = document.getElementById("webrtcStateSender");
const stateConnected = document.getElementById("webrtcStateConnected");

const btnCreateShareRoom = document.getElementById("btnCreateShareRoom");
const webrtcRoomInput = document.getElementById("webrtcRoomInput");
const btnJoinShareRoom = document.getElementById("btnJoinShareRoom");

const webrtcDisplayRoomId = document.getElementById("webrtcDisplayRoomId");

const webrtcFileInput = document.getElementById("webrtcFileInput");
const btnSelectWebRTCFile = document.getElementById("btnSelectWebRTCFile");
const webrtcSelectedFileName = document.getElementById("webrtcSelectedFileName");
const btnSendWebRTCFile = document.getElementById("btnSendWebRTCFile");

const webrtcProgressContainer = document.getElementById("webrtcProgressContainer");
const webrtcProgressBar = document.getElementById("webrtcProgressBar");
const webrtcProgressText = document.getElementById("webrtcProgressText");
const webrtcSpeedDisplay = document.getElementById("webrtcSpeedDisplay");

const webrtcReceiveContainer = document.getElementById("webrtcReceiveContainer");
const webrtcDownloadLink = document.getElementById("webrtcDownloadLink");

// State
let peerConnection = null;
let dataChannels = [];
let roomId = null;
let unsubscribeRefs = [];
let fileToSend = null;

let receivedChunks = Array.from({ length: NUM_CHANNELS }, () => []);
let receivedSizes = Array(NUM_CHANNELS).fill(0);
let fileInfo = null;

let transferStartTime = null;
let bytesTransferred = 0;
let speedInterval = null;

// Initialization
btnOpenWebRTCShare.addEventListener("click", () => {
    resetState();
    webrtcShareModal.style.display = "flex";
});

closeWebRTCShareBtn.addEventListener("click", () => {
    resetState();
    webrtcShareModal.style.display = "none";
});

function generateRoomId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function resetState() {
    unsubscribeRefs.forEach(unsub => unsub());
    unsubscribeRefs = [];

    if (peerConnection) {
        if (peerConnection.signalingState !== 'closed') {
            peerConnection.close();
        }
        peerConnection = null;
    }

    dataChannels.forEach(dc => {
        if (dc.readyState !== 'closed') {
            dc.close();
        }
    });
    dataChannels = [];

    if (roomId) {
        remove(ref(db, `webrtcRooms/${roomId}`)).catch(err => console.warn("Could not clean up room doc", err));
    }

    roomId = null;
    fileToSend = null;
    webrtcRoomInput.value = "";
    webrtcFileInput.value = "";
    webrtcSelectedFileName.textContent = "";
    btnSendWebRTCFile.style.display = "none";
    webrtcProgressContainer.style.display = "none";
    webrtcReceiveContainer.style.display = "none";

    receivedChunks = Array.from({ length: NUM_CHANNELS }, () => []);
    receivedSizes = Array(NUM_CHANNELS).fill(0);
    fileInfo = null;

    if (speedInterval) clearInterval(speedInterval);
    transferStartTime = null;
    bytesTransferred = 0;

    showState(stateInitial);
}

function showState(stateEl) {
    stateInitial.style.display = "none";
    stateSender.style.display = "none";
    stateConnected.style.display = "none";
    stateEl.style.display = "block";
}

function startSpeedCalculator() {
    transferStartTime = Date.now();
    bytesTransferred = 0;
    if (speedInterval) clearInterval(speedInterval);

    speedInterval = setInterval(() => {
        if (!transferStartTime) return;
        const elapsedTime = (Date.now() - transferStartTime) / 1000;
        if (elapsedTime > 0) {
            const speedMbps = (bytesTransferred * 8) / (elapsedTime * 1000000);
            webrtcSpeedDisplay.textContent = speedMbps.toFixed(2) + " Mbps";
        }
    }, 500);
}

function stopSpeedCalculator() {
    if (speedInterval) clearInterval(speedInterval);
    transferStartTime = null;
}

function createPeerConnection() {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection = pc;

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
            alert("Connection to the other peer was lost.");
            resetState();
            webrtcShareModal.style.display = "none";
        }
    };
    return pc;
}

function setupDataChannelEvents(channel, index) {
    channel.onopen = () => {
        const allOpen = dataChannels.every(dc => dc.readyState === 'open');
        if (allOpen) {
            showState(stateConnected);
        }
    };
    channel.onclose = () => {
        const anyStillOpen = dataChannels.some(dc => dc.readyState === 'open' || dc.readyState === 'connecting');
        if (!anyStillOpen) {
            resetState();
            webrtcShareModal.style.display = "none";
        }
    };
    channel.onmessage = (event) => {
        try {
            if (typeof event.data === 'string') {
                const data = JSON.parse(event.data);
                if (data.type === 'fileInfo') {
                    fileInfo = data.payload;
                    receivedChunks = Array.from({ length: NUM_CHANNELS }, () => []);
                    receivedSizes = Array(NUM_CHANNELS).fill(0);
                    webrtcProgressBar.style.width = "0%";
                    webrtcProgressText.textContent = "0%";
                    webrtcProgressContainer.style.display = "block";
                    startSpeedCalculator();
                }
            } else {
                bytesTransferred += event.data.byteLength;
                receivedChunks[index].push(event.data);
                receivedSizes[index] += event.data.byteLength;

                if (fileInfo) {
                    const size = fileInfo.size;
                    const totalReceived = receivedSizes.reduce((a, b) => a + b, 0);
                    const percent = (totalReceived / size) * 100;

                    webrtcProgressBar.style.width = percent + "%";
                    webrtcProgressText.textContent = Math.round(percent) + "%";

                    const allPartsDone = receivedSizes.every((partSizeReceived, i) => {
                        const expected = (i === NUM_CHANNELS - 1) ? size - (fileInfo.partSize * (NUM_CHANNELS - 1)) : fileInfo.partSize;
                        return partSizeReceived >= expected;
                    });

                    if (allPartsDone) {
                        stopSpeedCalculator();
                        const allChunks = receivedChunks.flat();
                        const fileBlob = new Blob(allChunks, { type: fileInfo.type });
                        const url = URL.createObjectURL(fileBlob);

                        webrtcReceiveContainer.style.display = "block";
                        webrtcDownloadLink.href = url;
                        webrtcDownloadLink.download = fileInfo.name;
                        webrtcDownloadLink.textContent = `Download ${fileInfo.name}`;
                    }
                }
            }
        } catch (error) {
            console.error("Error processing message:", error);
        }
    };
}

// Create Room Action
btnCreateShareRoom.addEventListener("click", async () => {
    showState(stateSender);
    const pc = createPeerConnection();

    for (let i = 0; i < NUM_CHANNELS; i++) {
        const dc = pc.createDataChannel(`fileChannel-${i}`, { ordered: true });
        dataChannels.push(dc);
        setupDataChannelEvents(dc, i);
    }

    const newRoomId = generateRoomId();
    roomId = newRoomId;
    webrtcDisplayRoomId.textContent = roomId;

    const roomRef = ref(db, `webrtcRooms/${roomId}`);
    const offerCandidatesRef = ref(db, `webrtcRooms/${roomId}/offerCandidates`);

    pc.onicecandidate = async (event) => {
        if (event.candidate) {
            push(offerCandidatesRef, event.candidate.toJSON());
        }
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);
    const offerPayload = { sdp: offerDescription.sdp, type: offerDescription.type };

    await set(roomRef, { offer: offerPayload, createdAt: serverTimestamp() });

    // Listen for Answer
    const unsubRoom = onValue(roomRef, async (snapshot) => {
        const data = snapshot.val();
        if (!data) return;
        if (pc.currentRemoteDescription || !data.answer) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (e) {
            console.error("Error setting remote description:", e);
        }
    });

    // Listen for Answer ICE Candidates
    const answerCandidatesRef = ref(db, `webrtcRooms/${roomId}/answerCandidates`);
    const unsubCandidates = onChildAdded(answerCandidatesRef, async (snapshot) => {
        const data = snapshot.val();
        if (data) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(data));
            } catch (e) {
                console.error("Error adding answer ICE candidate:", e);
            }
        }
    });

    unsubscribeRefs.push(() => {
        // Firebase realtime db listener cleanup is complex, we just simplify here wrapper or use off()
    });
});

// Join Room Action
btnJoinShareRoom.addEventListener("click", async () => {
    const joinRoomId = webrtcRoomInput.value.trim().toUpperCase();
    if (joinRoomId.length !== 6) return;

    roomId = joinRoomId;

    // UI Loading state
    btnJoinShareRoom.textContent = "Joining...";
    btnJoinShareRoom.disabled = true;

    const pc = createPeerConnection();
    pc.ondatachannel = (event) => {
        const channelIndex = parseInt(event.channel.label.split('-')[1]);
        dataChannels[channelIndex] = event.channel;
        setupDataChannelEvents(event.channel, channelIndex);
    };

    const roomRef = ref(db, `webrtcRooms/${roomId}`);
    const roomSnapshot = await get(roomRef);

    if (!roomSnapshot.exists()) {
        alert("Room not found. Please check the ID.");
        btnJoinShareRoom.textContent = "Join";
        btnJoinShareRoom.disabled = false;
        resetState();
        return;
    }

    const answerCandidatesRef = ref(db, `webrtcRooms/${roomId}/answerCandidates`);
    pc.onicecandidate = async (event) => {
        if (event.candidate) {
            push(answerCandidatesRef, event.candidate.toJSON());
        }
    };

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(roomSnapshot.val().offer));
        const answerDescription = await pc.createAnswer();
        await pc.setLocalDescription(answerDescription);

        await update(roomRef, { answer: { sdp: answerDescription.sdp, type: answerDescription.type } });

        const offerCandidatesRef = ref(db, `webrtcRooms/${roomId}/offerCandidates`);
        const unsubCandidates = onChildAdded(offerCandidatesRef, async (snapshot) => {
            const data = snapshot.val();
            if (data) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(data));
                } catch (e) {
                    console.error("Error adding offer ICE candidate:", e);
                }
            }
        });

    } catch (e) {
        console.error("Failed to join room and answer:", e);
    }
});

// File Selection
btnSelectWebRTCFile.addEventListener("click", () => {
    webrtcFileInput.click();
});

webrtcFileInput.addEventListener("change", (e) => {
    if (e.target.files && e.target.files[0]) {
        fileToSend = e.target.files[0];
        webrtcSelectedFileName.textContent = `Selected: ${fileToSend.name}`;
        btnSendWebRTCFile.style.display = "block";
    }
});

// Send File
btnSendWebRTCFile.addEventListener("click", () => {
    if (!fileToSend || dataChannels.some(dc => dc.readyState !== 'open')) {
        alert("No file selected or not connected.");
        return;
    }

    webrtcProgressContainer.style.display = "block";
    webrtcProgressBar.style.width = "0%";
    webrtcProgressText.textContent = "0%";
    btnSendWebRTCFile.disabled = true;
    startSpeedCalculator();

    const fileSize = fileToSend.size;
    const partSize = Math.ceil(fileSize / NUM_CHANNELS);

    const fInfo = JSON.stringify({
        type: 'fileInfo',
        payload: { name: fileToSend.name, size: fileSize, type: fileToSend.type, partSize }
    });

    dataChannels.forEach(dc => dc.send(fInfo));

    const sendPart = (channelIndex) => {
        const start = channelIndex * partSize;
        const end = Math.min(start + partSize, fileSize);
        let offset = start;

        const fileReader = new FileReader();

        const readSlice = () => {
            if (offset >= end) {
                if (bytesTransferred >= fileSize) {
                    stopSpeedCalculator();
                    btnSendWebRTCFile.textContent = "Transfer Complete";
                }
                return;
            }
            const slice = fileToSend.slice(offset, offset + CHUNK_SIZE);
            fileReader.readAsArrayBuffer(slice);
        };

        fileReader.onload = (e) => {
            const dc = dataChannels[channelIndex];
            if (!e.target.result || dc.readyState !== 'open') return;

            try {
                dc.send(e.target.result);
                const currentChunkSize = e.target.result.byteLength;
                offset += currentChunkSize;
                bytesTransferred += currentChunkSize;

                const percent = (bytesTransferred / fileSize) * 100;
                webrtcProgressBar.style.width = percent + "%";
                webrtcProgressText.textContent = Math.round(percent) + "%";

                if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
                    dc.onbufferedamountlow = () => {
                        dc.onbufferedamountlow = null;
                        readSlice();
                    };
                } else {
                    readSlice();
                }
            } catch (error) {
                console.error("Send Error", error);
                alert("Could not send file data.");
            }
        };

        readSlice();
    };

    for (let i = 0; i < NUM_CHANNELS; i++) {
        sendPart(i);
    }
});
