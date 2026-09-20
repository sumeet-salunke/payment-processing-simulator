import crypto from "crypto";

export const generateEventID = () => {
  return `evt-${crypto.randomBytes(8).toString("hex")}`;
};
