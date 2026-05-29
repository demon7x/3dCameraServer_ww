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
        // Each capture click produces one session; new files from that
        // round land in the latest session. Subsequent clicks unshift a
        // new session so the tiles accumulate left-to-right (newest first).
        photoSessions: [],   // [{takeId, startedAt, photos:[]}]
        videoSessions: [],   // [{takeId, startedAt, videos:[]}]
        gallery: { open: false, kind: null, sessionIdx: 0, index: 0 }
    },
    computed: {
        orderedCameras: function () {
            return this.cameras.slice().sort((a, b) => a.name.localeCompare(b.name));
        },
        // For the gallery currently open: produce a cameraName-sorted
        // list of the items in that session.
        galleryList: function () {
            var sess = (this.gallery.kind === 'video' ? this.videoSessions : this.photoSessions)[this.gallery.sessionIdx];
            if (!sess) return [];
            var items = this.gallery.kind === 'video' ? sess.videos : sess.photos;
            return items.slice().sort(function (a, b) {
                return (a.cameraName || '').localeCompare(b.cameraName || '', undefined, {numeric: true});
            });
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

        // Route an incoming asset to a session: prefer takeId match,
        // otherwise the most recent session, otherwise create one.
        function landIn(sessions, key, data) {
            var idx = -1;
            if (data && data.takeId) {
                for (var i = 0; i < sessions.length; i++) {
                    if (sessions[i].takeId === data.takeId) { idx = i; break; }
                }
            }
            if (idx === -1) {
                if (!sessions.length) {
                    sessions.unshift({ takeId: (data && data.takeId) || null, startedAt: Date.now(), photos: [], videos: [] });
                }
                idx = 0;
            }
            sessions[idx][key].push(data);
        }

        this.socket.on('new-photo', function (data) {
            landIn(that.photoSessions, 'photos', data);
        });

        this.socket.on('photo-error', function(data){
            console.log(data);
        });

        this.socket.on('take-photo', function (data) {
            // Broadcast from another client (or this one). Open a fresh
            // session for this takeId if we haven't seen it yet.
            if (!data || !data.takeId) return;
            var seen = that.photoSessions.find(function (s) { return s.takeId === data.takeId; });
            if (!seen) {
                that.photoSessions.unshift({ takeId: data.takeId, startedAt: Date.now(), photos: [], videos: [], project: data.project || null });
            }
        });

        this.socket.on('new-video', function (data) {
            landIn(that.videoSessions, 'videos', data);
        });

        this.socket.on('take-video', function (data) {
            if (!data || !data.takeId) return;
            var seen = that.videoSessions.find(function (s) { return s.takeId === data.takeId; });
            if (!seen) {
                that.videoSessions.unshift({ takeId: data.takeId, startedAt: Date.now(), photos: [], videos: [], project: data.project || null });
            }
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
        openGallery: function (kind, sessionIdx, index) {
            this.gallery = { open: true, kind: kind, sessionIdx: sessionIdx || 0, index: index || 0 };
        },
        formatSessionTime: function (ts) {
            if (!ts) return '';
            var d = new Date(ts);
            function p(n) { return n < 10 ? '0' + n : '' + n; }
            return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
