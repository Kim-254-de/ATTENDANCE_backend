import QRCode from 'qrcode';
import { env } from '../../config/env.js';

/**
 * Renders a token payload as a scannable image.
 *
 * Error-correction level M (~15% recoverable) is the right trade for a
 * projected code: L is fragile against glare and a partially blocked screen,
 * while H inflates the module count enough to hurt legibility from the back of
 * a lecture hall.
 */

const COMMON = {
  errorCorrectionLevel: 'M',
  margin: 2,
  color: { dark: '#000000', light: '#FFFFFF' },
} as const;

export async function renderPng(payload: string, size = env.QR_IMAGE_SIZE): Promise<Buffer> {
  return QRCode.toBuffer(payload, { ...COMMON, type: 'png', width: size });
}

/** Vector output, for printing or embedding at any size without blur. */
export async function renderSvg(payload: string, size = env.QR_IMAGE_SIZE): Promise<string> {
  return QRCode.toString(payload, { ...COMMON, type: 'svg', width: size });
}

/** Data URL, for a client that wants the image inline in the JSON response. */
export async function renderDataUrl(payload: string, size = env.QR_IMAGE_SIZE): Promise<string> {
  return QRCode.toDataURL(payload, { ...COMMON, width: size });
}
