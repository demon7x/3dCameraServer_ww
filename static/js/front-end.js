var clientId = guid();



var app = new Vue({
    el: '#app',
    data: {
        socket: null,
        message: 'Hello Vue!',
        customCommands: {}, // 커맨드 값을 저장할 객체
        photoCommand :"",
        projectName: (typeof localStorage !== 'undefined' && localStorage.getItem('projectName')) || '',
        cameras: [],
        videos: [],
        gallery: { open: false, kind: null, index: 0 },
        photos: [
            {
                imagePath: '/img/placeholder.png',
                cameraName: 'test'
            },
            {
                imagePath: '/img/placeholder.png',
                cameraName: 'test'
            },
            {
                imagePath: '/img/placeholder.png',
                cameraName: 'test'
            },
            {
                imagePath: '/img/placeholder.png',
                cameraName: 'test'
            }
        ]
    },
    computed: {
        orderedCameras: function () {
            return this.cameras.slice().sort((a, b) => a.name.localeCompare(b.name));
        },
        orderedPhotos: function () {
            return this.photos.slice().sort((a, b) =>
                (a.cameraName || '').localeCompare(b.cameraName || '', undefined, {numeric: true})
            );
        },
        orderedVideos: function () {
            return this.videos.slice().sort((a, b) =>
                (a.cameraName || '').localeCompare(b.cameraName || '', undefined, {numeric: true})
            );
        },
        galleryList: function () {
            return this.gallery.kind === 'video' ? this.orderedVideos : this.orderedPhotos;
        },
        currentItem: function () {
            var list = this.galleryList;
            if (!list.length) return {};
            var i = this.gallery.index;
            if (i < 0) i = 0;
            if (i >= list.length) i = list.length - 1;
            return list[i] || {};
        },
        majorityCommit: function () {
            var counts = {};
            for (var i = 0; i < this.cameras.length; i++) {
                var c = this.cameras[i].commit;
                if (c && c !== 'unknown') {
                    counts[c] = (counts[c] || 0) + 1;
                }
            }
            var best = null, bestN = 0;
            for (var k in counts) {
                if (counts[k] > bestN) { best = k; bestN = counts[k]; }
            }
            return best;
        }
    },
    created: function () {
        this.socket = io('http://' + location.hostname + ':3000');

        this.socket.emit('client-online', {});

        window.addEventListener('keydown', this.onGalleryKey);

        var that = this;
        this.socket.on('camera-update', function(response) {
            //console.log("camera update", response);
            that.cameras = [];
            for (let i = 0; i < response.length; i++) {
                if (response[i].type == 'camera') {
                    var photoError = '';
                    if (response[i].photoError) {
                        var stage = response[i].photoErrorStage ? '[' + response[i].photoErrorStage + '] ' : '';
                        photoError = stage + (response[i].photoErrorReason || 'yes');
                    }
                    response[i].photoError = photoError;
                    lastUpdateProblem = false;
                    var timeSinceLastUpdate = Math.round((new Date() - new Date(response[i].lastCheckin)) / 100) / 10;
                    if ((timeSinceLastUpdate > 10) && !response[i].photoSending && response[i].status !== 'recording') {
                        lastUpdateProblem = true;
                    }
                    response[i].lastUpdateProblem = lastUpdateProblem;
                    response[i].timeSinceLastUpdate = timeSinceLastUpdate;

                    that.cameras.push(response[i]);
                }
            }

        });

        this.socket.on('new-photo', function(data){
            that.photos.push(data);
        });

        this.socket.on('photo-error', function(data){
            console.log(data);
        });

        this.socket.on('take-photo', function(data){
            that.photos = [];
        });

        this.socket.on('new-video', function (data) {
            that.videos.push(data);
        });

        this.socket.on('take-video', function (data) {
            that.videos = [];
        });
    },
    methods: {
        takePhoto: function () {
            if (this.photoCommand.trim() === '') {
                alert('Please enter a photo command.');
                return;
            }
            this.persistProject();
            takeId = guid();
            this.socket.emit('take-photo', {
                command: this.photoCommand,
                customCommands: this.customCommands,
                project: this.projectName.trim(),
                time: Date.now(),
                takeId: takeId
            });
        },
        takeVideo: function () {
            this.persistProject();
            takeId = guid();
            this.socket.emit('take-video', {
                command: this.photoCommand,
                customCommands: this.customCommands,
                project: this.projectName.trim(),
                time: Date.now(),
                takeId: takeId
            });
        },
        persistProject: function () {
            if (typeof localStorage !== 'undefined') {
                try { localStorage.setItem('projectName', this.projectName || ''); } catch (e) {}
            }
        },
        updateSoftware: function () {
            this.socket.emit('update-software', {});
        },
        rebootAll: function () {
            var n = this.cameras.filter(function (c) { return c.connected !== false; }).length;
            if (!confirm('연결된 카메라 ' + n + '대를 모두 재부팅합니다. 계속할까요?')) return;
            this.socket.emit('reboot-all', {});
        },
        enableNtpAll: function () {
            var server = prompt('NTP 서버 주소 (비우면 기본 pool.ntp.org 사용):', '');
            if (server === null) return;
            this.socket.emit('enable-ntp-all', { server: server.trim() });
        },
        syncClockAll: function () {
            this.socket.emit('sync-all-now', {});
        },
        openGallery: function (kind, index) {
            this.gallery = { open: true, kind: kind, index: index || 0 };
        },
        closeGallery: function () {
            this.gallery.open = false;
        },
        galleryPrev: function () {
            var n = this.galleryList.length; if (!n) return;
            this.gallery.index = (this.gallery.index - 1 + n) % n;
        },
        galleryNext: function () {
            var n = this.galleryList.length; if (!n) return;
            this.gallery.index = (this.gallery.index + 1) % n;
        },
        onGalleryKey: function (e) {
            if (!this.gallery.open) return;
            if (e.key === 'Escape')        { this.closeGallery(); e.preventDefault(); }
            else if (e.key === 'ArrowLeft')  { this.galleryPrev(); e.preventDefault(); }
            else if (e.key === 'ArrowRight') { this.galleryNext(); e.preventDefault(); }
        },
        ntpLabel: function (camera) {
            var n = camera.ntp;
            if (!n || n.synchronized == null) return '?';
            if (!n.synchronized) return 'no';
            if (n.offsetMs != null) return 'yes (' + n.offsetMs + 'ms)';
            return 'yes';
        },
        ntpColor: function (camera) {
            var n = camera.ntp;
            if (!n || n.synchronized == null) return '#888';
            return n.synchronized ? '#4caf50' : '#d64545';
        },
        ntpTitle: function (camera) {
            var n = camera.ntp;
            if (!n) return 'NTP status unknown';
            var parts = [];
            parts.push('synchronized: ' + (n.synchronized ? 'yes' : 'no'));
            if (n.server) parts.push('server: ' + n.server);
            if (n.offsetMs != null) parts.push('system offset: ' + n.offsetMs + 'ms');
            return parts.join('\n');
        },
        rebootCamera: function (socketId, name) {
            if (!confirm('"' + (name || socketId) + '" 카메라를 재부팅합니다. 계속할까요?')) return;
            this.socket.emit('reboot-camera', {socketId: socketId});
        },
        updateName: function (socketId, event) {
            console.log("Update name", socketId, event.target.value);
            this.socket.emit('update-name', {socketId: socketId, newName: event.target.value});
            event.target.value = null;
        },
        updateFocus: function(socketId, event) {
            this.socket.emit('update-focus', {socketId: socketId, newName: event.target.value});
        },
        preview: function (socketId) {
            window.open(`/preview?socketId=${socketId}&clientId=${socketId}`, 'Camera Preview', 'width=800,height=600');
            console.log("cameraPreview", socketId);
        },
        updateCustomCommand: function (socketId, event) {
            console.log("Update custom command", socketId, event.target.value);
            this.customCommands[socketId] = event.target.value;
        },
        isCommitStale: function (camera) {
            if (!this.majorityCommit) return false;
            if (!camera.commit || camera.commit === 'unknown') return true;
            return camera.commit !== this.majorityCommit;
        },
        updateAllCustomCommands: function () {
            console.log("Updating all custom commands with photoCommand:", this.photoCommand);
            for (let camera of this.cameras) {
                this.$set(this.customCommands, camera.socketId, this.photoCommand);

                // 강제로 @input 이벤트 트리거
                this.$nextTick(() => {
                    let inputElement = this.$refs.customCommandInputs.find(input => input.name === 'customCommand' && input.value === this.photoCommand);
                    if (inputElement) {
                        let event = new Event('input', { bubbles: true });
                        inputElement.dispatchEvent(event);
                    }
                });
            }
        }
    }
})

function guid() {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4();
}
