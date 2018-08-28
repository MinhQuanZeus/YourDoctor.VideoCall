const Notification = require('../models').Notification;

const createNotification = async function (body) {
    try {
        let notification = Notification({
            senderId: body.senderId,
            receiverId: body.receiverId,
            type: body.type,
            storageId: body.storageId,
            message: body.message,
            nameSender: body.nameSender,
        });
        await  notification.save(function (err, success) {
            if (err) {
                console.log(err)
            }
        });
    }
    catch (e) {
        console.log(e)
    }
};

module.exports.createNotification = createNotification;