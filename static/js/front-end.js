var clientId = guid();



var app = new Vue({
    el: '#app',
    data: {
        socket: null,
        message: 'Hello Vue!',
        customCommands: {}, // 커맨드 값을 저장할 객체
        photoCommand :"",
        cameras: [],
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
        }
    },
    created: function () {
        this.socket = io('http://' + location.hostname + ':3000');

        this.socket.emit('client-online', {});

        var that = this;
        this.socket.on('camera-update', function(response) {
            //console.log("camera update", response);
            that.cameras = [];
            for (let i = 0; i < response.length; i++) {
                if (response[i].type == 'camera') {
                    var photoError = '';
                    if (response[i].photoError) {
                        photoError = 'yes';
                    }
                    response[i].photoError = photoError;
                    lastUpdateProblem = false;
                    var timeSinceLastUpdate = Math.round((new Date() - new Date(response[i].lastCheckin)) / 100) / 10;
                    if ((timeSinceLastUpdate > 10) && !response[i].photoSending) {
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
    },
    methods: {
        takePhoto: function () {
            if (this.photoCommand.trim() === '') {
                alert('Please enter a photo command.');
                return;
            }
            // Emit take-photo event with the command
 
            takeId = guid();
            this.socket.emit('take-photo', { command: this.photoCommand,customCommands: this.customCommands, time: Date.now(), takeId: takeId});
            //takeId = guid();
            //this.socket.emit('take-photo', {takeId: takeId, time: Date.now()});
        },
        takeVideo: function () {
 
            takeId = guid();
            this.socket.emit('take-video', 
                { command: this.photoCommand,
                    customCommands: this.customCommands, 
                    time: Date.now(), 
                    takeId: takeId,
                    caramId:socketId});
            //takeId = guid();
            //this.socket.emit('take-photo', {takeId: takeId, time: Date.now()});
        },
        updateSoftware: function () {
            this.socket.emit('update-software', {});
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
