// Exact names avoid treating "Zapłać później" as a payment submission.
export const paymentButtonName = /^(?:płacę|zapłać(?: teraz)?)(?:\s+[\d\s,.]+\s*zł)?$/i;
