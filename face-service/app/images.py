"""Turning a submitted image string into a pixel array, or refusing it."""

import base64
import binascii
import re

import cv2
import numpy as np

_DATA_URL = re.compile(r"^data:image/(jpeg|jpg|png|webp);base64,", re.IGNORECASE)


class ImageError(ValueError):
    """The image cannot be used. `code` is returned to the caller as-is."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def decode_image(value: str, max_bytes: int, max_side_px: int) -> np.ndarray:
    """A base64 string or data URL (what the portal's canvas produces) as a BGR array.

    EXIF orientation is applied by imdecode, so a portrait phone photo is upright.
    """
    raw_b64 = _DATA_URL.sub("", value.strip(), count=1)
    # Checked before decoding: base64 is 4/3 the size of what it encodes.
    if len(raw_b64) * 3 // 4 > max_bytes:
        raise ImageError("IMAGE_TOO_LARGE", f"Images must be under {max_bytes // 1000} KB.")
    try:
        data = base64.b64decode(raw_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ImageError("INVALID_IMAGE", "The image is not valid base64.") from None

    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ImageError("INVALID_IMAGE", "The image could not be read. Send a JPEG, PNG or WebP.")

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest > max_side_px:
        scale = max_side_px / longest
        image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    return image


# The reference photo a lecturer sees on the terminal: big enough to recognise
# someone on a phone screen, small enough (~5-10 KB) to keep one per student.
CROP_SIDE_PX = 160
CROP_JPEG_QUALITY = 80
# Room around the detector's box, as a share of its size, so the crop shows hair and chin.
CROP_PADDING = 0.25


def face_crop(image: np.ndarray, x: int, y: int, width: int, height: int) -> str:
    """A square JPEG data URL of the face at (x, y, width, height), with some room around it."""
    side = round(max(width, height) * (1 + 2 * CROP_PADDING))
    cx, cy = x + width / 2, y + height / 2
    img_h, img_w = image.shape[:2]
    left = max(0, min(round(cx - side / 2), img_w - 1))
    top = max(0, min(round(cy - side / 2), img_h - 1))
    right = min(img_w, left + side)
    bottom = min(img_h, top + side)
    crop = cv2.resize(image[top:bottom, left:right], (CROP_SIDE_PX, CROP_SIDE_PX), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, CROP_JPEG_QUALITY])
    if not ok:
        raise RuntimeError("could not encode the face crop")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()
