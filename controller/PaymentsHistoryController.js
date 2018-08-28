const PaymentsHistory = require('../models').PaymentsHistory;

const createPaymentForUser = async function (body) {
    let objPayment;
    if (!body) {
        objPayment = null;
        return objPayment;
    }
    try{
        let paymentsHistory = new PaymentsHistory({
            userID: body.userID,
            amount: body.amount,
            remainMoney: body.remainMoney,
            fromUser: body.fromUser,
            typeAdvisoryID: body.typeAdvisoryID,
            status: body.status
        });
        objPayment = await  paymentsHistory.save();
    }catch (e) {
        console.log(e)
    }
    return objPayment;
};

module.exports.createPaymentForUser = createPaymentForUser;