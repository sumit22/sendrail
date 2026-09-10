/**
 * Injection tokens for everything the module provides.
 *
 * Symbols, not string tokens, so a host cannot collide with them by accident,
 * and not classes, so the host can swap any implementation without the module
 * needing to know.
 */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
export const EMAIL_TRANSPORT = Symbol('EMAIL_TRANSPORT');
export const EMAIL_ADDRESS_VALIDATOR = Symbol('EMAIL_ADDRESS_VALIDATOR');
export const EMAIL_DELIVERY_LOG_STORE = Symbol('EMAIL_DELIVERY_LOG_STORE');
export const EMAIL_REPUTATION_STORE = Symbol('EMAIL_REPUTATION_STORE');
export const EMAIL_SUPPRESSION_STORE = Symbol('EMAIL_SUPPRESSION_STORE');
export const EMAIL_FEEDBACK_REGISTRY = Symbol('EMAIL_FEEDBACK_REGISTRY');
export const EMAIL_FEEDBACK_PROCESSOR = Symbol('EMAIL_FEEDBACK_PROCESSOR');
export const EMAIL_DELIVERY_LOG_PRUNER = Symbol('EMAIL_DELIVERY_LOG_PRUNER');
export const SES_MANAGEMENT_SERVICE = Symbol('SES_MANAGEMENT_SERVICE');
export const EMAIL_MODULE_OPTIONS = Symbol('EMAIL_MODULE_OPTIONS');
