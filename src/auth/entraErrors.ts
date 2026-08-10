/**
 * Maps Entra ID (Azure AD) error codes surfaced during the device code grant to
 * messages a user can act on, instead of raw AADSTS codes.
 */

import { t } from '../i18n';

const CONDITIONAL_ACCESS_CODES = ['AADSTS53003'];
const APP_NOT_AUTHORIZED_CODES = ['AADSTS700016', 'AADSTS65001', 'AADSTS90094'];
const ACCOUNT_TYPE_MISMATCH_CODES = ['AADSTS50020', 'AADSTS90072'];

// Match on a whole code only. A bare substring test would let a longer code
// that shares a prefix (AADSTS530032 vs AADSTS53003) be reported as an
// unrelated cause — and because a match aborts polling, that misdiagnosis is
// fatal rather than cosmetic.
function includesAnyCode(text: string, codes: string[]): boolean {
	return codes.some((code) => new RegExp(`\\b${code}\\b`).test(text));
}

/**
 * Returns a user-facing message for a known Entra rejection, or undefined if
 * the error doesn't match a recognized cause (caller should fall back to a
 * generic message).
 */
export function mapEntraAuthError(
	errorCode: string | undefined,
	errorDescription: string | undefined
): string | undefined {
	// Entra usually puts the AADSTS code in the description, but the /devicecode
	// endpoint can also surface it as the error code itself — search both.
	const text = `${errorCode || ''} ${errorDescription || ''}`;

	if (includesAnyCode(text, CONDITIONAL_ACCESS_CODES)) {
		return t('notices.auth.entra.conditionalAccessBlocked');
	}
	if (includesAnyCode(text, APP_NOT_AUTHORIZED_CODES)) {
		return t('notices.auth.entra.appNotAuthorized');
	}
	if (includesAnyCode(text, ACCOUNT_TYPE_MISMATCH_CODES)) {
		return t('notices.auth.entra.accountTypeMismatch');
	}

	return undefined;
}
