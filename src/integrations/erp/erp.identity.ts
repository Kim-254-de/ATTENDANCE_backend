import type { ClaimedIdentity, ErpStaffRecord } from './erp.types.js';

/**
 * Guards against someone registering with a staff number that is genuinely in
 * the ERP but belongs to a colleague. Matching is deliberately forgiving about
 * formatting and strict about substance.
 */

/** Titles and honorifics an ERP may store but a person may not type. */
const HONORIFICS = new Set([
  'dr', 'prof', 'professor', 'mr', 'mrs', 'ms', 'miss', 'eng', 'engr', 'rev', 'sr', 'jr',
]);

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize('NFKD')
    // Strip accents so "Mwangí" matches "Mwangi".
    .replace(/[\u0300-\u036f]/g, '')
    // Punctuation between names varies wildly between systems.
    .replace(/[.,'`-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !HONORIFICS.has(token));
}

/**
 * Names match when every token the ERP holds also appears in what was typed,
 * or vice versa. This tolerates a dropped middle name and reordered surnames,
 * which are both common, while still rejecting a different person.
 */
export function namesMatch(erpName: string, claimedName: string): boolean {
  const erpTokens = new Set(nameTokens(erpName));
  const claimedTokens = new Set(nameTokens(claimedName));

  if (erpTokens.size === 0 || claimedTokens.size === 0) return false;

  const [smaller, larger] =
    erpTokens.size <= claimedTokens.size ? [erpTokens, claimedTokens] : [claimedTokens, erpTokens];

  // Require at least two shared tokens where possible: a single shared
  // surname is far too weak a signal to accept on its own.
  let shared = 0;
  for (const token of smaller) {
    if (larger.has(token)) shared += 1;
  }

  if (shared !== smaller.size) return false;
  return smaller.size >= 2 || erpTokens.size === 1 || claimedTokens.size === 1;
}

function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Returns the names of the fields that did not match. An empty array means the
 * claimed identity is consistent with the ERP record.
 */
export function compareIdentity(record: ErpStaffRecord, claimed: ClaimedIdentity): string[] {
  const mismatched: string[] = [];

  if (!namesMatch(record.fullName, claimed.fullName)) {
    mismatched.push('fullName');
  }

  // Only compared when the ERP actually holds an address. Many ERPs store a
  // personal address while staff register with an institutional one, so an
  // absent ERP email is not treated as a mismatch.
  if (record.email && normaliseEmail(record.email) !== normaliseEmail(claimed.email)) {
    mismatched.push('email');
  }

  return mismatched;
}
