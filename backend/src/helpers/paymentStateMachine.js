import { PAYMENT_TRANSITIONS } from "../constants/payment.transition.js";
import { PAYMENT_STATUS } from "../constants/payment.constants.js";

export const canTransition = (currentStatus, newStatus) => {
  return PAYMENT_TRANSITIONS[currentStatus].includes(newStatus);
};

//it returned false
/*console.log(canTransition(PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED));
*/