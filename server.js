var express = require('express');
var app = express();
var multer  = require('multer')
var upload = multer({ dest: 'uploads/' })

var server = require('http').Server(app);

var io = require('socket.io')(server);

var fs = require('fs');
var path = require('path');

var cameras = [];

var clientUpdateIntervalTimer;

// --- Per-camera config store ----------------------------------------------
// Persisted on disk as cameras-config.json, keyed by hostName. Holds
// camera-specific preferences that should survive restarts and be pushed to
// the Pi whenever it (re)connects.
var CONFIG_FILE = path.join(__dirname, 'cameras-config.json');
var camerasConfig = {};
try {
    if (fs.existsSync(CONFIG_FILE)) {
        camerasConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
        console.log('[config] loaded ' + Object.keys(camerasConfig).length + ' camera config entries');
    }
} catch (e) {
    console.error('[config] failed to load ' + CONFIG_FILE + ':', e.message);
    camerasConfig = {};
}

function saveCamerasConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(camerasConfig, null, 2));
    } catch (e) {
        console.error('[config] write failed:', e.message);
    }
}

function getCameraConfig(hostName) {
    if (!hostName) return {};
    return camerasConfig[hostName] || {};
}

function setCameraConfig(hostName, patch) {
    if (!hostName) return {};
    var current = camerasConfig[hostName] || {};
    camerasConfig[hostName] = Object.assign({}, current, patch || {});
    saveCamerasConfig();
    return camerasConfig[hostName];
}

// Let the server listen on port 3000 for the websocket connection
server.listen(3000);

app.get('/', function (request, response) {
    response.sendFile(__dirname + '/index.html');
});

app.get('/preview', function (request, response) {
    response.sendFile(__dirname + '/preview.html');
});

app.get('/viewer', function (request, response) {
    response.sendFile(__dirname + '/viewer.html');
});


app.post('/new-image', upload.single('image'), function (request, response) {
    console.log("received a new image", request.body.socketId);
    if (!request.file || !request.body.startTime) {
        return response.sendStatus(400);
    }

    let folderName = getFolderName(request.body.startTime, request.body.project);
    let folderDir  = './images/' + folderName;
    if (!fs.existsSync(folderDir)) fs.mkdirSync(folderDir, { recursive: true });
    let imagePath  = folderDir + '/' + request.body.fileName;

    var tmpPath = './' + request.file.path;

    fs.rename(tmpPath, imagePath, function(err) {
        if (err) {
            console.error('rename image failed:', err);
            return response.sendStatus(500);
        }

        var i = findCameraIndexByName(request.body.cameraName);
        if (cameras[i]) {
            cameras[i].photoError     = false;
            cameras[i].waitingOnPhoto = false;
            cameras[i].photoSending   = false;
            cameras[i].receivedPhoto  = true;
            cameras[i].latestImage    = folderName + '/' + request.body.fileName;
        }
    });

    response.sendStatus(201);
});

app.post('/new-video', upload.single('video'), function (request, response) {
    console.log('received a new video from', request.body.cameraName, 'startTime=' + request.body.startTime);
    if (!request.file || !request.body.startTime) {
        return response.sendStatus(400);
    }

    var folderName = getFolderName(request.body.startTime, request.body.project);
    var folderDir  = './videos/' + folderName;
    if (!fs.existsSync(folderDir)) fs.mkdirSync(folderDir, { recursive: true });

    var fileName = request.body.fileName || (request.body.cameraName || 'camera') + '.mp4';
    var videoPath = folderDir + '/' + fileName;
    var relPath   = folderName + '/' + fileName;
    var tmpPath   = './' + request.file.path;

    fs.rename(tmpPath, videoPath, function (err) {
        if (err) {
            console.error('rename video failed:', err);
            return response.sendStatus(500);
        }

        var i = findCameraIndexByName(request.body.cameraName);
        if (cameras[i]) {
            cameras[i].latestVideo = relPath;
        }

        io.emit('new-video', {
            cameraName: request.body.cameraName,
            fileName: fileName,
            videoPath: '/videos/' + relPath,
            startTime: request.body.startTime,
            time: Date.now()
        });

        response.sendStatus(201);
    });
});

app.use(express.static('static'));
app.use(express.static('images'));
app.use('/videos', express.static('videos'));

// Setup on port 8080 as well for the web app
app.listen(8080, function () {
  console.log('3D Camera app listening on port 8080 and 3000')
})


// When a new camera connects set up the following
io.on('connection', function (socket) {
    console.log('A connection was made', socket.id);
    console.log('A connection was made', socket.conn.remoteAddress);


    // Add the camera to a persistent list of devices
    cameras.push({
        socketId: socket.id,
        type: null,
        name: null,
        ipAddress: null,
        photoError: false,
        photoTaken: false,
        waitingOnPhoto: false,
        lastCheckin: null,
        photoSending: false,
        receivedPhoto: false,
        version: null,
        photoStatus: null,
        connected: true
    });


    // Listen for heartbeat notifications from the cameras
    socket.on('camera-online', function(msg){

        var i = findCameraIndex(socket.id);
        if (i == null) return;

        // If an older disconnected entry exists for the same hostName or name,
        // merge it into this fresh socket entry so the list doesn't grow on every reconnect.
        var matchKey = msg.hostName || msg.name;
        if (matchKey) {
            for (var j = cameras.length - 1; j >= 0; j--) {
                if (j === i) continue;
                var other = cameras[j];
                if (other.type !== 'camera') continue;
                var otherKey = other.hostName || other.name;
                if (otherKey === matchKey && other.connected === false) {
                    // Preserve any fields worth keeping from the old record
                    cameras[i].lastUpdateOk     = other.lastUpdateOk;
                    cameras[i].lastUpdateStderr = other.lastUpdateStderr;
                    cameras.splice(j, 1);
                    if (j < i) i--;
                }
            }
        }

        var wasConnected = cameras[i].connected === true;
        cameras[i].type             = 'camera';
        cameras[i].connected        = true;
        cameras[i].name             = msg.name;
        cameras[i].ipAddress        = msg.ipAddress;
        cameras[i].lastCheckin      = new Date();
        cameras[i].updateInProgress = msg.updateInProgress;
        cameras[i].status           = msg.status || 'idle';
        cameras[i].commit           = msg.commit || 'unknown';
        if (msg.version) {
            cameras[i].version = msg.version;
        }
        cameras[i].hostName = msg.hostName || null;

        // Push stored config to the camera once per socket (first heartbeat).
        if (!wasConnected && cameras[i].hostName) {
            var cfg = getCameraConfig(cameras[i].hostName);
            if (Object.keys(cfg).length) {
                io.to(cameras[i].socketId).emit('apply-config', cfg);
                console.log('[config] pushed to ' + cameras[i].hostName + ':', cfg);
            }
        }
    });


    // Sent by the web interface
    socket.on('client-online', function(msg){

        // Update our cache
        var i = findCameraIndex(socket.id);
        cameras[i].type = 'client';

        clientUpdateIntervalTimer = setInterval(clientUpdate, 100);
    });


    socket.on('disconnect', function(msg, msg2) {
        var i = findCameraIndex(socket.id);
        if (i == null) return;

        var entry = cameras[i];
        if (entry && entry.type === 'camera') {
            // Keep the camera in the list so operators can see it's offline
            entry.connected      = false;
            entry.photoStatus    = 'disconnected';
            entry.waitingOnPhoto = false;
            entry.photoSending   = false;
            console.log('[disconnect] camera=' + (entry.name || entry.hostName || 'unknown') + ' kept in list as offline');
        } else {
            // Web clients go away normally
            cameras.splice(i, 1);
            if (entry && entry.type === 'client') {
                clearInterval(clientUpdateIntervalTimer);
            }
        }

        io.emit('camera-update', cameras);
    });


    // When a take photo message comes in create the folder, update the cameras and pass on the take message to devices
    socket.on('take-photo', function(msg){
        console.log("Take a new photo, project=" + (msg.project || 'default'));

        let folderName = './images/' + getFolderName(msg.time, msg.project);

        if (!fs.existsSync(folderName)) {
            fs.mkdirSync(folderName, { recursive: true });
        }
        //msg.socketId = socket.id;
        io.emit('take-photo', msg);
        console.log(msg)

        for (let i = 0; i < cameras.length; i++) {
            if (cameras[i].type == 'camera') {
                cameras[i].waitingOnPhoto   = true;
                cameras[i].receivedPhoto    = false;
                cameras[i].photoError       = false;
                cameras[i].photoErrorReason = null;
                cameras[i].photoErrorStage  = null;

                if (msg.customCommands[cameras[i].socketId]) {
                    cameras[i].customCommand = msg.customCommands[cameras[i].socketId];
                }
            }
        }

    });

    socket.on('take-video', function (msg) {
        console.log("Start video recording");
        msg = msg || {};

        // Inject a future start timestamp so all cameras try to begin
        // recording at the same wall-clock instant. 2500ms buffer covers
        // LAN latency + camera pre-warm for --signal mode; tighten once
        // NTP is up.
        msg.startAt = Date.now() + 2500;

        let folderName = './videos/' + getFolderName(msg.time || Date.now(), msg.project);
        if (!fs.existsSync(folderName)) {
            fs.mkdirSync(folderName, { recursive: true });
        }

        io.emit('take-video', msg);
        console.log('[take-video] startAt=' + msg.startAt + ' cameras=' + cameras.filter(function(c){return c.type==='camera' && c.connected!==false;}).length);

        for (let i = 0; i < cameras.length; i++) {
            if (cameras[i].type === 'camera') {
                cameras[i].waitingOnVideo = true;
                cameras[i].receivedVideo = false;

                if (msg.customCommands && msg.customCommands[cameras[i].socketId]) {
                    cameras[i].customCommand = msg.customCommands[cameras[i].socketId];
                }
            }
        }
    });

    socket.on('update-software', function(msg){
        console.log("Updating software");

        io.emit('update-software', msg);

    });

    socket.on('reboot-all', function (msg) {
        console.log('[reboot-all] broadcasting reboot to all cameras');
        io.emit('reboot');
    });

    socket.on('reboot-camera', function (msg) {
        if (!msg || !msg.socketId) return;
        var i = findCameraIndex(msg.socketId);
        if (cameras[i]) {
            console.log('[reboot-camera] ' + (cameras[i].name || cameras[i].hostName));
            io.to(cameras[i].socketId).emit('reboot');
        }
    });

    socket.on('update-result', function (msg) {
        var i = findCameraIndex(socket.id);
        var camName = (cameras[i] && cameras[i].name) || (msg && msg.cameraName) || 'unknown';
        console.log('[update-result] camera=' + camName + ' ok=' + !!msg.ok +
            (msg.stderrTail ? '\n  stderr: ' + msg.stderrTail.replace(/\n/g, ' | ') : ''));
        if (cameras[i]) {
            cameras[i].lastUpdateOk = !!msg.ok;
            cameras[i].lastUpdateStderr = msg.stderrTail || null;
        }
    });

    // --- Per-camera config edit endpoints ---------------------------------
    socket.on('get-camera-config', function (msg) {
        if (!msg) msg = {};
        var host = msg.hostName;
        if (!host && msg.socketId) {
            var idx = findCameraIndex(msg.socketId);
            if (cameras[idx]) host = cameras[idx].hostName || cameras[idx].name;
        }
        var cfg = getCameraConfig(host);
        socket.emit('camera-config', { hostName: host, config: cfg });
    });

    socket.on('set-camera-config', function (msg) {
        if (!msg) return;
        var host = msg.hostName;
        var targetSocketId = null;
        if (!host && msg.socketId) {
            var idx = findCameraIndex(msg.socketId);
            if (cameras[idx]) {
                host = cameras[idx].hostName || cameras[idx].name;
                targetSocketId = cameras[idx].socketId;
            }
        } else if (host) {
            for (var j = 0; j < cameras.length; j++) {
                if ((cameras[j].hostName || cameras[j].name) === host) {
                    targetSocketId = cameras[j].socketId;
                    break;
                }
            }
        }
        if (!host) {
            console.log('[config] set-camera-config with no host resolvable, ignored');
            return;
        }
        var merged = setCameraConfig(host, msg.config || {});
        console.log('[config] ' + host + ' updated:', merged);
        if (targetSocketId) io.to(targetSocketId).emit('apply-config', merged);
        // Acknowledge to the requester so the UI can confirm
        socket.emit('camera-config', { hostName: host, config: merged, saved: true });
    });

    // Pi reports actual signal-fire time so we can log inter-camera skew.
    socket.on('video-started', function (msg) {
        if (!msg) return;
        console.log('[video-started] ' + (msg.cameraName || msg.hostName || '?') +
            ' target=' + msg.startAt +
            ' actual=' + msg.actualStart +
            ' skew=' + msg.skew + 'ms');
    });

    socket.on('update-name', function(msg){
        console.log("Updating device name");

        var i = findCameraIndex(msg.socketId);

        // Broadcast a message but pass the ip of the camera that needs to respond
        io.emit('update-name', {ipAddress: cameras[i].ipAddress, newName: msg.newName});
    });


    socket.on('sending-photo', function(msg){
        var i = findCameraIndex(socket.id);
        cameras[i].photoSending = true;
    });


    // When a new photo comes in save it and send it on to the client
    socket.on('new-photo', function(msg){
        console.log("New photo data");
        var i = findCameraIndex(socket.id);
        cameras[i].photoError = false;
        cameras[i].photoTaken = true;
        //cameras[i].waitingOnPhoto = false;
        //cameras[i].photoSending   = false;
        //cameras[i].receivedPhoto  = true;

        let folderName = getFolderName(msg.startTime);

        msg.cameraName = cameras[i].name;
        msg.imagePath  = folderName + '/' + msg.fileName;

        //io.emit('new-photo', msg);

        /*
        // Where is the image to be saved
        let folderName = getFolderName(msg.startTime);
        let fileName   = guid() + '.jpg';
        let imagePath  = './images/' + folderName + '/' + fileName;
        let thumbImagePath  = './images/' + folderName + '/thumb/' + fileName;

        if (!fs.existsSync('./images/' + folderName + '/thumb/')){
            fs.mkdirSync('./images/' + folderName + '/thumb/');
        }

        msg.cameraName = cameras[i].name;
        msg.imagePath  = folderName + '/' + fileName;

        let imageData = new Buffer(msg.data, 'base64')

        let parser = require('exif-parser').create(imageData);
        let result = parser.parse();

        fs.writeFile(imagePath, imageData, function () {
            msg.data       = null;

            if (result.hasThumbnail()) {
                console.log("Thumbnail found");
                fs.writeFile(thumbImagePath, result.getThumbnailBuffer(), function () {
                    msg.thumbImagePath  = folderName + '/thumb/' + fileName;
                    io.emit('new-photo', msg);
                });
            } else {
                io.emit('new-photo', msg);
            }
        });
        */

    });


    // There was an error taking a photo, update our data and the clients
    socket.on('photo-error', function(msg){
        var i = findCameraIndex(socket.id);
        var camName = (cameras[i] && cameras[i].name) || (msg && msg.cameraName) || 'unknown';
        console.log(
            '[photo-error] camera=' + camName +
            ' stage=' + (msg.stage || '?') +
            ' exitCode=' + (msg.exitCode != null ? msg.exitCode : '-') +
            ' signal=' + (msg.signal || '-') +
            ' timedOut=' + !!msg.timedOut +
            ' reason=' + (msg.reason || '-')
        );
        if (cameras[i]) {
            cameras[i].photoError       = true;
            cameras[i].photoErrorReason = msg.reason || ('stage:' + (msg.stage || '?'));
            cameras[i].photoErrorStage  = msg.stage || null;
            cameras[i].waitingOnPhoto   = false;
            cameras[i].photoSending     = false;
            cameras[i].receivedPhoto    = false;
        }
        io.emit('photo-error', msg);
    });
    socket.on('preview', function (msg) {
        console.log("Preview request for camera", msg && msg.socketId, "from client", socket.id);
        var i = findCameraIndex(msg && msg.socketId);
        let camera = cameras[i];
        if (camera) {
            io.to(camera.socketId).emit('preview', {
                cameraId: msg.cameraId,
                clientSocketId: socket.id,
                width:   msg && msg.width,
                height:  msg && msg.height,
                quality: msg && msg.quality
            });
        } else {
            console.log("Camera not found for preview:", msg && msg.socketId);
        }
    });

    // Pi reports the URL its MJPEG server is listening on; forward to the
    // originating browser client.
    socket.on('preview-url', function (msg) {
        if (!msg) return;
        var payload = typeof msg === 'string' ? { url: msg } : msg;
        console.log('[preview-url] from=' + socket.id + ' to=' + (payload.clientSocketId || '-') + ' url=' + payload.url);
        if (payload.clientSocketId) {
            io.to(payload.clientSocketId).emit('preview-url', payload.url);
        } else {
            console.log('[preview-url] dropped: no clientSocketId');
        }
    });

    socket.on('stop-preview', function (msg) {
        if (!msg || !msg.socketId) return;
        var i = findCameraIndex(msg.socketId);
        if (cameras[i]) {
            io.to(cameras[i].socketId).emit('stop-preview');
        }
    });

    socket.on('start-all-previews', function (msg) {
        console.log('[start-all-previews] requested by client=' + socket.id);
        for (var j = 0; j < cameras.length; j++) {
            var c = cameras[j];
            if (c.type === 'camera' && c.connected !== false) {
                io.to(c.socketId).emit('preview', { clientSocketId: socket.id });
            }
        }
    });

    socket.on('stop-all-previews', function () {
        console.log('[stop-all-previews]');
        for (var j = 0; j < cameras.length; j++) {
            var c = cameras[j];
            if (c.type === 'camera' && c.connected !== false) {
                io.to(c.socketId).emit('stop-preview');
            }
        }
    });

    // 포커스 값을 업데이트하는 이벤트 핸들러 추가
    socket.on('update-focus', function (msg) {
        console.log("Updating focus value for camera", msg.socketId, "to", msg.focusValue);
        var i = findCameraIndex(msg.socketId);
        let camera = cameras[i]
        if (camera) {
            io.to(camera.socketId).emit('update-focus', { focusValue: msg.focusValue });
        }
        else{

            console.log("Camera not found");
        }
    });

    // 카메라 스트림을 클라이언트로 전달하는 이벤트 핸들러 추가
    socket.on('camera-stream', function (msg) {
        io.to(msg.clientSocketId).emit('camera-stream', { stream: msg.stream });
    });
});



function clientUpdate() {

    // Generate a status message for the camera
    for (let i = 0; i < cameras.length; i++) {
        let photoStatus = 'standby';
        if (cameras[i].waitingOnPhoto) {
            photoStatus = 'taking';
        }
        if (cameras[i].photoSending) {
            photoStatus = 'sending';
        }
        if (cameras[i].receivedPhoto) {
            photoStatus = 'received';
        }
        if (cameras[i].updateInProgress) {
            photoStatus = 'updating-software';
        }
        if (cameras[i].connected === false) {
            photoStatus = 'disconnected';
        }
        cameras[i].photoStatus = photoStatus;
    }


    io.emit('camera-update', cameras);

    // See if any of the cameras have a new image
    for (let i = 0; i < cameras.length; i++) {
        if (cameras[i].receivedPhoto) {
            cameras[i].receivedPhoto = false;

            msg = {
                cameraName: cameras[i].name,
                imagePath: cameras[i].latestImage
            }
            io.emit('new-photo', msg);
        }
    }
}


// Locate our local camera data based on the socket id
function findCameraIndex(socketId) {
    for (let i = 0; i < cameras.length; i++) {
        if (cameras[i].socketId === socketId) {
            return i;
        }
    }
}

function findCameraIndexByName(name) {
    for (let i = 0; i < cameras.length; i++) {
        if (cameras[i].name === name) {
            return i;
        }
    }
}


// Generate a folder name based on the timestamp, optionally prefixed with
// the project name so operators can keep shoots grouped on disk.
function getFolderName(time, project) {
    let date = new Date(Number(time));
    let dayOfWeek = ("0" + date.getDate()).slice(-2);
    let month = ("0" + (date.getMonth() + 1)).slice(-2);
    let hour = ("0" + (date.getHours() + 1)).slice(-2);
    let minute = ("0" + (date.getMinutes() + 1)).slice(-2);
    let seconds = ("0" + (date.getSeconds() + 1)).slice(-2);
    let stamp = date.getFullYear() + month + dayOfWeek + hour + minute + seconds;
    let prefix = (project && String(project).trim()) ? String(project).trim().replace(/[^a-zA-Z0-9_\-]/g, '_') : 'default';
    return prefix + '_' + stamp;
}


// Generate a guid
function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
    s4() + '-' + s4() + s4() + s4();
}
