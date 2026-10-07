import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AppError } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import * as repository from './passkey.repository.js';
import type { PasskeyAuthenticationInput, PasskeyCredentialInput } from './passkey.schema.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

async function remember(userId: string, value: string): Promise<void> {
  await repository.saveChallenge(userId, value, new Date(Date.now() + CHALLENGE_TTL_MS));
}

async function consume(userId: string): Promise<string> {
  const challenge = await repository.consumeChallenge(userId);
  if (!challenge) {
    throw AppError.badRequest('The biometric challenge has expired. Start again.');
  }
  return challenge;
}

export async function registrationOptions(userId: string, userName: string) {
  const existing = await repository.findCredentialsForUser(userId);
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userID: new TextEncoder().encode(userId),
    userName,
    userDisplayName: userName,
    attestationType: 'none',
    excludeCredentials: existing.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  await remember(userId, options.challenge);
  return options;
}

export async function verifyRegistration(userId: string, input: PasskeyCredentialInput): Promise<void> {
  const verification = await verifyRegistrationResponse({
    response: input as unknown as RegistrationResponseJSON,
    expectedChallenge: await consume(userId),
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw AppError.badRequest('The phone biometric could not be verified.');
  }
  const { credential } = verification.registrationInfo;
  await repository.saveCredential({
    userId,
    credentialId: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports ?? [],
  });
}

export async function authenticationOptions(userId: string) {
  const credentials = await repository.findCredentialsForUser(userId);
  if (credentials.length === 0) throw AppError.notFound('No phone biometric is registered for this account.');
  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: 'required',
    allowCredentials: credentials.map((credential) => ({
      id: credential.credential_id,
      transports: credential.transports,
    })),
  });
  await remember(userId, options.challenge);
  return options;
}

export async function verifyAuthentication(userId: string, input: PasskeyAuthenticationInput): Promise<void> {
  const credential = await repository.findCredential(input.credential.id);
  if (!credential || credential.user_id !== userId) throw AppError.unauthenticated('Unknown phone biometric.');
  const verification = await verifyAuthenticationResponse({
    response: input.credential as unknown as AuthenticationResponseJSON,
    expectedChallenge: await consume(userId),
    expectedOrigin: env.WEBAUTHN_ORIGIN,
    expectedRPID: env.WEBAUTHN_RP_ID,
    credential: {
      id: credential.credential_id,
      publicKey: Uint8Array.from(credential.public_key),
      counter: Number(credential.counter),
      transports: credential.transports,
    },
  });
  if (!verification.verified) throw AppError.unauthenticated('The phone biometric could not be verified.');
  await repository.updateCounter(credential.credential_id, verification.authenticationInfo.newCounter);
}
