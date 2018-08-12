const VideoCallHistory = require('../models').VideoCallHistory;

const createVideoCallHistory = async function (body) {
    let objVideoCall;
    if (!body) {
        objVideoCall = null;
        return objVideoCall;
    }
    try{
        let videoCall = new VideoCallHistory({
            patientId: body.patientId,
            doctorId: body.doctorId,
            timeStart: body.timeStart,
            timeEnd: body.timeEnd,
            typeAdvisoryID: body.typeAdvisoryID,
            paymentPatientID: body.paymentPatientID,
            paymentDoctorID: body.paymentDoctorID,
            linkVideo: body.linkVideo
        });
        objVideoCall = await  videoCall.save();
    }catch (e) {
        console.log(e)
    }
    return objVideoCall;
};

module.exports.createVideoCallHistory = createVideoCallHistory;