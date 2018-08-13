const TypeAdvisory = require('./models').TypeAdvisory;
const User = require('./models').User;
const constants = require('./constants');
const PaymentController = require('./controller/PaymentsHistoryController');
const NotificationController = require('./controller/NotificationController');
const SendNotification = require('./controller/NotificationFCMController');
const VideoCall = require('./controller/VideoCallHistoryController');

module.exports = function (io, streams, app) {
    let minimist = require("minimist");
    const uuidv4 = require('uuid/v4');
    let idTypeAdvisory = "5b6c63d7370072f452d6f13a";
    let linkVideo = "";
    let doctors = {};
    let argv = minimist(process.argv.slice(2), {
        default: {
            as_uri: "https://localhost:6008/",
            ws_uri: "ws://192.168.35.128:8888/kurento"
        }
    });

    /*
   * Definition of global variables.
   */
    let kurento = require("kurento-client");

    let kurentoClient = null;
    let userRegistry = new UserRegistry();
    let pipelines = {};
    let candidatesQueue = {};

    /*
   * Definition of helper classes
   */

    // Represents caller and callee sessions
    function UserSession(id, userId, name, avatar, type) {
        this.id = id;
        this.userId = userId;
        this.name = name;
        this.avatar = avatar;
        this.peer = null;
        this.sdpOffer = null;
        this.startTime = null;
        this.endTime = null;
        this.type = type;
        this.recorderEndpoint = null;
        this.videoURL = null;
    }

    UserSession.prototype.sendMessage = function (event, message) {
        io.to(this.id).emit(event, JSON.stringify(message));
    };

    // Represents registrar of users
    function UserRegistry() {
        this.usersById = {};
        this.usersByUserId = {};
    }

    UserRegistry.prototype.register = function (user) {
        this.usersById[user.id] = user;
        this.usersByUserId[user.userId] = user;
    };

    UserRegistry.prototype.unregister = function (id) {
        let user = this.getById(id);
        if (user) delete this.usersById[id];
        if (user && this.getByUserId(user.userId))
            delete this.usersByUserId[user.userId];
    };

    UserRegistry.prototype.getById = function (id) {
        return this.usersById[id];
    };

    UserRegistry.prototype.getByUserId = function (userId) {
        return this.usersByUserId[userId];
    };

    UserRegistry.prototype.removeById = function (id) {
        let userSession = this.usersById[id];
        if (!userSession) return;
        delete this.usersById[id];
        delete this.usersByUserId[userSession.userId];
    };

    // Represents a B2B active call
    function CallMediaPipeline() {
        this.pipeline = null;
        this.webRtcEndpoint = {};
    }

    CallMediaPipeline.prototype.createPipeline = function (
        callerId,
        calleeId,
        callback
    ) {
        let self = this;
        const videoUrl = "tmp/videos/" + uuidv4() + ".mp4";
        recordParams = {
            uri: "file:///" + videoUrl,
            mediaProfile: 'MP4'
        };
        getKurentoClient(function (error, kurentoClient) {
            if (error) {
                return callback(error);
            }

            kurentoClient.create("MediaPipeline", function (error, pipeline) {
                if (error) {
                    return callback(error);
                }
                pipeline.create("RecorderEndpoint", recordParams, function (error, recorderEndpoint) {
                    if (error) {
                        return callback(error);
                    }

                    // recorderEndpoint.record();

                    pipeline.create("WebRtcEndpoint", function (
                        error,
                        callerWebRtcEndpoint
                    ) {
                        if (error) {
                            pipeline.release();
                            return callback(error);
                        }

                        if (candidatesQueue[callerId]) {
                            while (candidatesQueue[callerId].length) {
                                let candidate = candidatesQueue[callerId].shift();
                                callerWebRtcEndpoint.addIceCandidate(candidate);
                            }
                        }

                        callerWebRtcEndpoint.on("OnIceCandidate", function (event) {
                            let candidate = kurento.getComplexType("IceCandidate")(
                                event.candidate
                            );
                            userRegistry.getById(callerId).sendMessage("iceCandidate", {
                                id: "iceCandidate",
                                candidate: candidate
                            });
                        });

                        pipeline.create("WebRtcEndpoint", function (
                            error,
                            calleeWebRtcEndpoint
                        ) {
                            if (error) {
                                pipeline.release();
                                return callback(error);
                            }

                            if (candidatesQueue[calleeId]) {
                                while (candidatesQueue[calleeId].length) {
                                    let candidate = candidatesQueue[calleeId].shift();
                                    calleeWebRtcEndpoint.addIceCandidate(candidate);
                                }
                            }

                            calleeWebRtcEndpoint.on("OnIceCandidate", function (event) {
                                let candidate = kurento.getComplexType("IceCandidate")(
                                    event.candidate
                                );
                                userRegistry.getById(calleeId).sendMessage("iceCandidate", {
                                    id: "iceCandidate",
                                    candidate: candidate
                                });
                            });

                            callerWebRtcEndpoint.connect(
                                calleeWebRtcEndpoint,
                                function (error) {
                                    if (error) {
                                        pipeline.release();
                                        return callback(error);
                                    }
                                    calleeWebRtcEndpoint.connect(
                                        callerWebRtcEndpoint,
                                        function (error) {
                                            if (error) {
                                                pipeline.release();
                                                return callback(error);
                                            }

                                            calleeWebRtcEndpoint.connect(recorderEndpoint, function (error) {
                                                if (error) {
                                                    pipeline.release();
                                                    return callback(error);
                                                }
                                                userRegistry.getById(callerId).recorderEndpoint = recorderEndpoint;
                                                userRegistry.getById(callerId).videoURL = videoUrl;
                                                userRegistry.getById(calleeId).videoURL = videoUrl;
                                                recorderEndpoint.record(); //You are alredy invoking recorderEndpoit.record() above.
                                            });
                                        }
                                    );

                                    self.pipeline = pipeline;
                                    self.webRtcEndpoint[callerId] = callerWebRtcEndpoint;
                                    self.webRtcEndpoint[calleeId] = calleeWebRtcEndpoint;
                                    callback(null);
                                }
                            );
                        });
                    });
                });
            });
        });
    };

    CallMediaPipeline.prototype.generateSdpAnswer = function (
        id,
        sdpOffer,
        callback
    ) {
        this.webRtcEndpoint[id].processOffer(sdpOffer, callback);
        this.webRtcEndpoint[id].gatherCandidates(function (error) {
            if (error) {
                return callback(error);
            }
        });
    };

    CallMediaPipeline.prototype.release = function () {
        if (this.pipeline) this.pipeline.release();
        this.pipeline = null;
    };

    // Recover kurentoClient for the first time.
    function getKurentoClient(callback) {
        if (kurentoClient !== null) {
            return callback(null, kurentoClient);
        }

        kurento(argv.ws_uri, function (error, _kurentoClient) {
            if (error) {
                let message = "Coult not find media server at address " + argv.ws_uri;
                return callback(message + ". Exiting with error " + error);
            }

            kurentoClient = _kurentoClient;
            callback(null, kurentoClient);
        });
    }


    async function stop(sessionId) {
        if (!pipelines[sessionId]) {
            return;
        }
        let stopperUser = userRegistry.getById(sessionId);
        let stoppedUser = userRegistry.getByUserId(stopperUser.peer);
        stopperUser.peer = null;
        if (stoppedUser && stoppedUser.recorderEndpoint) {
            stoppedUser.recorderEndpoint.stop();
            stoppedUser.recorderEndpoint.release();
            stoppedUser.recorderEndpoint = null;
        }
        if (stopperUser && stopperUser.recorderEndpoint) {
            stopperUser.recorderEndpoint.stop();
            stopperUser.recorderEndpoint.release();
            stopperUser.recorderEndpoint = null;
        }
        let pipeline = pipelines[sessionId];
        delete pipelines[sessionId];
        pipeline.release();


        if (stoppedUser) {
            stoppedUser.peer = null;
            delete pipelines[stoppedUser.id];
            let message = {
                id: "stopCommunication",
                message: "remote user hanged out"
            };
            stoppedUser.sendMessage("stopCommunication", message);
        }
        clearCandidatesQueue(sessionId);

        ////// Todo: create payment for patient and doctor, notification
        // get price of video call


        //// get Id
        let idPatient;
        let idDoctor;
        if (stopperUser && stopperUser.type === 1) {
            idPatient = stopperUser.userId;
        }
        else if (stopperUser) {
            idDoctor = stopperUser.userId;
        }
        if (stoppedUser && stoppedUser.type === 1) {
            idPatient = stoppedUser.userId;
        }
        else if (stoppedUser) {
            idDoctor = stoppedUser.userId;
        }
        let fullNamePatient = userRegistry.getByUserId(idPatient).name;
        let fullNameDoctor = userRegistry.getByUserId(idDoctor).name;


        // get time
        let stopperStartTime = stopperUser.startTime;
        let stoppedStartTime = stoppedUser.startTime;
        let finalStartTime;
        if (stopperStartTime < stoppedStartTime) {
            finalStartTime = stoppedStartTime;
        } else {
            finalStartTime = stopperStartTime;
        }
        // tính tiền
        let timeCall = new Date().getTime() - finalStartTime;
        let objTypeAdvisory = await TypeAdvisory.findById({_id: idTypeAdvisory});
        let amount = (timeCall / 1000) * objTypeAdvisory.price;

        ///////PATIENT
        // 1: create payment for patient
        // get remain_money patient
        let objPatient = await User.findById({_id: idPatient}).select('remainMoney');
        console.log(objPatient);
        let newRemainMoneyPatient = objPatient.remainMoney - amount;
        let objPaymentForPatient = {
            userID: idPatient,
            amount: amount,
            remainMoney: newRemainMoneyPatient,
            fromUser: idDoctor,
            typeAdvisoryID: objTypeAdvisory.id,
            status: constants.PAYMENT_SUCCESS
        };
        // create payment history
        // save remain money to user
        objPatient.set({remainMoney: newRemainMoneyPatient});
        let objPatientReturn = await objPatient.save();
        let objPaymentPatientReturn;
        if (objPatientReturn) {
            objPaymentPatientReturn = await PaymentController.createPaymentForUser(objPaymentForPatient);
            if (objPaymentPatientReturn) {
                // send notification, save notification
                // create notification
                let objNotificationPatient = {
                    senderId: idDoctor,
                    nameSender: fullNameDoctor,
                    receiveId: idPatient,
                    type: constants.NOTIFICATION_TYPE_PAYMENT,
                    storageId: objPaymentPatientReturn.id,
                    message: "Cuộc tư vấn với bác sỹ " + fullNameDoctor + " đã kết thúc. " +
                        "Thời gian tư vấn là: " + (timeCall / 1000) + "s. Bạn đã thanh toán: " + amount + ". Số tiền bạn có hiện tại: " + newRemainMoneyPatient
                };
                await NotificationController.createNotification(objNotificationPatient)


            }
            /////////// DOCTOR
            let objDoctor = await User.findById({_id: idDoctor}).select('remainMoney');
            let newRemainMoneyDoctor = objDoctor.remainMoney - amount;

            let objPaymentForDoctor = {
                userID: idDoctor,
                amount: amount,
                remainMoney: newRemainMoneyDoctor,
                fromUser: idPatient,
                typeAdvisoryID: objTypeAdvisory.id,
                status: constants.PAYMENT_SUCCESS
            };
            // update remain money to doctor
            objDoctor.set({remainMoney: newRemainMoneyDoctor});
            let objDoctorReturn = await objDoctor.save();
            // create payment doctor
            let objPaymentDoctorReturn;
            if (objDoctorReturn) {
                objPaymentDoctorReturn = await PaymentController.createPaymentForUser(objPaymentForDoctor);
                if (objPaymentDoctorReturn) {
                    // send notification, save notification
                    // create notification

                    let objNotificationDoctor = {
                        senderId: idPatient,
                        nameSender: fullNamePatient,
                        receiveId: idDoctor,
                        type: constants.NOTIFICATION_TYPE_PAYMENT,
                        storageId: objPaymentDoctorReturn.id,
                        message: "Cuộc tư vấn với bệnh nhân " + fullNamePatient + " đã kết thúc. " +
                            "Thời gian tư vấn là: " + (timeCall / 1000) + "s. Bạn đã thanh toán: " + amount + ". Số tiền bạn có hiện tại: " + newRemainMoneyDoctor
                    };
                    await NotificationController.createNotification(objNotificationDoctor)


                }
            }
            //// end doctor
            /// create video call history
            let objDataVideoCall = {
                patientId: idPatient,
                doctorId: idDoctor,
                timeStart: finalStartTime,
                timeEnd: new Date().getTime(),
                typeAdvisoryID: objTypeAdvisory.id,
                paymentPatientID: objPaymentPatientReturn.id,
                paymentDoctorID: objPaymentDoctorReturn.id,
                linkVideo: stoppedUser.videoURL
            }
            let objVideoCall = await VideoCall.createVideoCallHistory(objDataVideoCall)

            // send notification
            let notificationToDoctor = {
                data: {
                    senderId: idPatient,
                    nameSender: fullNamePatient,
                    receiveId: idDoctor,
                    type: constants.NOTIFICATION_TYPE_PAYMENT,
                    storageId: objPaymentDoctorReturn.id,
                    message: "Cuộc tư vấn với bệnh nhân " + fullNamePatient + " đã kết thúc. " +
                        "Thời gian tư vấn là: " + (timeCall / 1000) + "s. Bạn đã thanh toán: " + amount + ". Số tiền bạn có hiện tại: " + newRemainMoneyDoctor,
                    createTime: Date.now().toString()
                }
            };
            await SendNotification.sendNotification(idDoctor, notificationToDoctor);

            // send notification
            let notificationToPatient = {
                data: {
                    senderId: idDoctor,
                    nameSender: fullNameDoctor,
                    receiveId: idPatient,
                    type: constants.NOTIFICATION_TYPE_PAYMENT,
                    storageId: objPaymentPatientReturn.id,
                    message: "Cuộc tư vấn với bác sỹ " + fullNameDoctor + " đã kết thúc. " +
                        "Thời gian tư vấn là: " + (timeCall / 1000) + ". Bạn đã thanh toán: " + amount + ". Số tiền bạn có hiện tại: " + newRemainMoneyPatient,
                    createTime: Date.now().toString()
                }
            };
            await SendNotification.sendNotification(idPatient, notificationToPatient);
            stoppedUser.videoURL = null;
            stopperUser.videoURL = null;
        }
    }

    function incomingCallResponse(calleeId, from, callResponse, calleeSdp) {
        clearCandidatesQueue(calleeId);

        function onError(callerReason, calleeReason) {
            if (pipeline && pipeline !== undefined) {
                pipeline.release();
            }
            if (caller) {
                let callerMessage = {
                    id: "callResponse",
                    response: "rejected"
                };
                if (callerReason) callerMessage.message = callerReason;
                caller.sendMessage("callResponse", callerMessage);
            }

            let calleeMessage = {
                id: "stopCommunication"
            };
            if (calleeReason) calleeMessage.message = calleeReason;
            callee.sendMessage("stopCommunication", calleeMessage);
        }

        let callee = userRegistry.getById(calleeId);
        if (!from || !userRegistry.getByUserId(from)) {
            return onError(null, "unknown from = " + from);
        }
        let caller = userRegistry.getByUserId(from);
        if (callResponse === "accept") {
            let pipeline = new CallMediaPipeline();
            pipelines[caller.id] = pipeline;
            pipelines[callee.id] = pipeline;

            pipeline.createPipeline(caller.id, callee.id, function (error) {
                if (error) {
                    return onError(error, error);
                }

                pipeline.generateSdpAnswer(caller.id, caller.sdpOffer, function (
                    error,
                    callerSdpAnswer
                ) {
                    if (error) {
                        return onError(error, error);
                    }

                    pipeline.generateSdpAnswer(callee.id, calleeSdp, function (
                        error,
                        calleeSdpAnswer
                    ) {
                        if (error) {
                            return onError(error, error);
                        }

                        let message = {
                            id: "startCommunication",
                            sdpAnswer: calleeSdpAnswer
                        };
                        callee.sendMessage("startCommunication", message);

                        message = {
                            id: "callResponse",
                            response: "accepted",
                            sdpAnswer: callerSdpAnswer
                        };
                        caller.sendMessage("callResponse", message);
                    });
                });
            });
        } else {
            let decline = {
                id: "callResponse",
                response: "rejected",
                message: "user declined"
            };
            caller.sendMessage("callResponse", decline);
        }
    }

    function call(callerId, to, from, sdpOffer) {
        clearCandidatesQueue(callerId);
        let caller = userRegistry.getById(callerId);
        let rejectCause = "User " + to + " is not registered";
        if (userRegistry.getByUserId(to)) {
            let callee = userRegistry.getByUserId(to);
            caller.sdpOffer = sdpOffer;
            callee.peer = from;
            caller.peer = to;
            let message = {
                id: "incomingCall",
                from: from,
                callerName: caller.name,
                callerAvatar: caller.avatar
            };
            try {
                return callee.sendMessage("incomingCall", message);
            } catch (exception) {
                rejectCause = "Error " + exception;
            }
        }
        let message = {
            id: "callResponse",
            response: "rejected: ",
            message: rejectCause
        };
        caller.sendMessage("callResponse", message);
    }

    function register(id, userId, name, avatar, type) {
        function onError(error) {
            io.to(id).emit(
                JSON.stringify({
                    id: "registerResponse",
                    response: "rejected ",
                    message: error
                })
            );
        }

        if (!userId) {
            return onError("empty user id");
        }

        if (userRegistry.getByUserId(userId)) {
            const lateUser = userRegistry.getByUserId(userId);
            userRegistry.unregister(lateUser.id);
        }

        userRegistry.register(new UserSession(id, userId, name, avatar, type));
        try {
            io.to(id).emit(
                JSON.stringify({
                    id: "registerResponse",
                    response: "accepted"
                })
            );
        } catch (exception) {
            onError(exception);
        }
    }

    function clearCandidatesQueue(sessionId) {
        if (candidatesQueue[sessionId]) {
            delete candidatesQueue[sessionId];
        }
    }

    function onIceCandidate(sessionId, _candidate) {
        let candidate = kurento.getComplexType("IceCandidate")(_candidate);
        let user = userRegistry.getById(sessionId);
        if (!user) {
            return;
        }
        if (
            pipelines[user.id] &&
            pipelines[user.id].webRtcEndpoint &&
            pipelines[user.id].webRtcEndpoint[user.id]
        ) {
            let webRtcEndpoint = pipelines[user.id].webRtcEndpoint[user.id];
            webRtcEndpoint.addIceCandidate(candidate);
        } else {
            if (!candidatesQueue[user.id]) {
                candidatesQueue[user.id] = [];
            }
            candidatesQueue[sessionId].push(candidate);
        }
    }

    io.on("connection", function (client) {
        console.log("-- " + client.id + " joined --");
        const sessionId = client.id;

        // TODO Kurento

        client.on("register", function (message) {
            if (message && message.type === 2) {
                doctors[sessionId] = message.userId;
                io.emit('getDoctorOnline', doctors);
            }
            register(sessionId, message.userId, message.name, message.avatar, message.type);
        });

        client.on("getDoctorOnline", function () {
            client.emit("getDoctorOnline", doctors);
        });

        client.on("call", function (message) {
            call(sessionId, message.to, message.from, message.sdpOffer);
        });

        client.on("incomingCallResponse", function (message) {
            incomingCallResponse(
                sessionId,
                message.from,
                message.callResponse,
                message.sdpOffer
            );
        });

        client.on("connectedCall", function (message) {
            let connectedUser = userRegistry.getById(sessionId);
            connectedUser.startTime = new Date().getTime();
        });

        client.on("stop", function (message) {
            stop(sessionId);
        });

        client.on("onIceCandidate", function (message) {
            onIceCandidate(sessionId, message.candidate);
        });

        client.on("onCallerReject", function (calleeId) {
            onCallerReject(calleeId);
        });
        client.on("onGetVideoCallType", function (id) {
            idTypeAdvisory = id;
        });

        function leave() {
            console.log("-- " + client.id + " left --");
            if (doctors && doctors.hasOwnProperty(client.id)) {
                delete doctors[client.id];
                io.emit('getDoctorOnline', doctors);
            }
            stop(sessionId);
            userRegistry.unregister(client.id);
        }

        client.on("disconnect", leave);
        client.on("leave", leave);
    });

    function onCallerReject(calleeId) {
        const callee = userRegistry.getByUserId(calleeId);
        if (callee) {
            callee.sendMessage("onCallerReject", "caller reject");
        }
    }
};

